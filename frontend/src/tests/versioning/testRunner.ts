/**
 * Test runner for executing versioning test scenarios
 */

import { 
  TestScenario, 
  TestStep, 
  TestResult, 
  TestStepResult,
  StateSnapshot,
  ExpectedOutcome
} from './types';
import { MockEnvironment } from './mockEnvironment';
import { TestResultSaver } from './testResultSaver';

export class TestRunner {
  private mockEnv: MockEnvironment;
  private currentScenario: TestScenario | null = null;
  private currentStepIndex: number = 0;
  private results: TestResult[] = [];
  private isRunning: boolean = false;
  private isPaused: boolean = false;
  private stateHistory: StateSnapshot[] = [];
  private onStateChange?: (state: RunnerState) => void;
  private onStepComplete?: (step: TestStepResult) => void;
  private onScenarioComplete?: (result: TestResult) => void;
  private autoSave: boolean = false;

  constructor() {
    this.mockEnv = new MockEnvironment({
      simulateLatency: true,
      latencyRange: [5, 15],
      streamingDelay: 100,
      interceptFetch: true
    });
  }

  /**
   * Set event handlers
   */
  public setEventHandlers(handlers: {
    onStateChange?: (state: RunnerState) => void;
    onStepComplete?: (step: TestStepResult) => void;
    onScenarioComplete?: (result: TestResult) => void;
  }): void {
    this.onStateChange = handlers.onStateChange;
    this.onStepComplete = handlers.onStepComplete;
    this.onScenarioComplete = handlers.onScenarioComplete;
  }

  /**
   * Toggle auto-save of results
   */
  public setAutoSave(enabled: boolean): void {
    this.autoSave = enabled;
  }

  /**
   * Run a single test scenario
   */
  public async runScenario(scenario: TestScenario): Promise<TestResult> {
    if (this.isRunning) {
      throw new Error('Test runner is already running');
    }

    this.isRunning = true;
    this.currentScenario = scenario;
    this.currentStepIndex = 0;
    this.stateHistory = [];

    const startTime = Date.now();
    const passedSteps: TestStepResult[] = [];
    const failedSteps: TestStepResult[] = [];
    const errorMessages: string[] = [];

    // Initialize mock environment with scenario's initial state
    this.mockEnv.initialize({
      messages: scenario.initialState.messages,
      versions: scenario.initialState.versions || {},
      currentChatId: scenario.initialState.chatId,
      isStreaming: scenario.initialState.isStreaming || false,
      sendButtonDisabled: scenario.initialState.sendButtonDisabled || false,
      visibleSwitchers: [],
      activeDropdown: null,
      operationInProgress: null
    });

    // Record initial state
    this.stateHistory.push(this.mockEnv.getState());
    this.notifyStateChange();

    // Execute each step
    for (let i = 0; i < scenario.steps.length; i++) {
      if (!this.isRunning) break;
      
      while (this.isPaused) {
        await this.sleep(100);
      }

      this.currentStepIndex = i;
      const step = scenario.steps[i];
      const stepStartTime = Date.now();

      try {
        // Execute the step
        await this.executeStep(step);
        
        // Record state after step
        const currentState = this.mockEnv.getState();
        this.stateHistory.push(currentState);

        // Validate expected state if defined
        let stepPassed = true;
        let validationError: string | undefined;

        if (step.expectedState) {
          const validation = this.validateState(currentState, step.expectedState);
          stepPassed = validation.passed;
          validationError = validation.error;
        }

        // Check expected outcomes for this step
        const stepOutcomes = scenario.expectedOutcomes.filter(o => o.stepId === step.id);
        for (const outcome of stepOutcomes) {
          const outcomeValidation = this.validateOutcome(outcome, currentState);
          if (!outcomeValidation.passed) {
            stepPassed = false;
            validationError = outcomeValidation.error;
            errorMessages.push(`Step ${step.id}: ${outcomeValidation.error}`);
          }
        }

        const stepResult: TestStepResult = {
          stepId: step.id,
          stepDescription: step.description,
          passed: stepPassed,
          error: validationError,
          actualState: currentState,
          expectedState: step.expectedState,
          duration: Date.now() - stepStartTime
        };

        if (stepPassed) {
          passedSteps.push(stepResult);
        } else {
          failedSteps.push(stepResult);
        }

        this.onStepComplete?.(stepResult);
        this.notifyStateChange();

        // Add delay if specified
        if (step.delay) {
          await this.sleep(step.delay);
        }

      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        failedSteps.push({
          stepId: step.id,
          stepDescription: step.description,
          passed: false,
          error: errorMessage,
          actualState: this.mockEnv.getState(),
          expectedState: step.expectedState,
          duration: Date.now() - stepStartTime
        });
        errorMessages.push(`Step ${step.id} failed: ${errorMessage}`);
        this.onStepComplete?.({
          stepId: step.id,
          stepDescription: step.description,
          passed: false,
          error: errorMessage,
          duration: Date.now() - stepStartTime
        });
      }
    }

    // Create test result
    const result: TestResult = {
      scenarioId: scenario.id,
      scenarioName: scenario.name,
      passed: failedSteps.length === 0,
      failedSteps,
      passedSteps,
      duration: Date.now() - startTime,
      timestamp: Date.now(),
      errorMessages,
      stateSnapshots: this.stateHistory
    };

    this.results.push(result);
    this.isRunning = false;
    this.currentScenario = null;
    
    // Conditionally save test result to JSON file
    if (this.autoSave) {
      const apiCalls = this.mockEnv.getApiCallHistory();
      TestResultSaver.saveTestResult(scenario, result, this.stateHistory, apiCalls);
    }
    
    this.onScenarioComplete?.(result);
    this.notifyStateChange();

    return result;
  }

  /**
   * Run multiple scenarios
   */
  public async runScenarios(scenarios: TestScenario[]): Promise<TestResult[]> {
    const results: TestResult[] = [];
    
    for (const scenario of scenarios) {
      if (!this.isRunning) {
        const result = await this.runScenario(scenario);
        results.push(result);
      }
    }
    
    return results;
  }

  /**
   * Execute a single test step
   */
  private async executeStep(step: TestStep): Promise<void> {
    switch (step.action) {
      case 'edit':
        await this.executeEdit(step);
        break;
      case 'retry':
        await this.executeRetry(step);
        break;
      case 'delete':
        await this.executeDelete(step);
        break;
      case 'switch-version':
        await this.executeSwitchVersion(step);
        break;
      case 'hover-message':
        await this.executeHover(step);
        break;
      case 'click-switcher':
        await this.executeClickSwitcher(step);
        break;
      case 'select-version':
        await this.executeSelectVersion(step);
        break;
      case 'send-message':
        await this.executeSendMessage(step);
        break;
      case 'wait': {
        // Make waits sequential and condition-driven: if streaming is active in the
        // current chat, await streaming completion instead of sleeping arbitrarily.
        const state = this.mockEnv.getState();
        if (state.isStreaming) {
          await this.mockEnv.waitForStreaming(state.currentChatId, false);
        } else if (step.expectedState) {
          // If an expectedState snapshot is provided, poll until it matches
          await this.waitUntilStateMatches(step.expectedState, 3000);
        }
        break;
      }
      case 'verify-state':
        // State verification is handled after step execution
        break;
      case 'cancel-streaming':
        await this.executeCancelStreaming(step);
        break;
      case 'delete-chat':
        await this.executeDeleteChat(step);
        break;
      default:
        throw new Error(`Unknown action: ${step.action}`);
    }
  }

  /**
   * Action executors
   */
  private async executeEdit(step: TestStep): Promise<void> {
    if (!step.target.messageId) {
      throw new Error('Edit requires messageId');
    }
    if (step.payload?.newContent === undefined) {
      throw new Error('Edit requires newContent in payload');
    }

    // Simulate API call through mock environment
    const response = await fetch('/api/db/versioning/notify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        operation_type: 'edit',
        message_id: step.target.messageId,
        chat_id: this.mockEnv.getState().currentChatId,
        new_content: step.payload.newContent
      })
    });

    // Check for validation errors and handle them gracefully
    if (!response.ok) {
      const error = await response.json();
      // For empty content validation, don't throw - just log
      if (error.error === 'Edit requires newContent in payload') {
        console.log('Empty edit rejected as expected');
        return;
      }
      throw new Error(error.error || 'API call failed');
    }

    // Auto-switch to the new version and start streaming if needed
    const data = await response.json();
    if (data && data.version_chat_id) {
      // Switch chat context to the new version
      await fetch('/api/chat/switch', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: data.version_chat_id })
      });

      // Start streaming if required (edit regeneration from user messages)
      if (data.needs_streaming && data.stream_message) {
        const payload: any = {
          message: data.stream_message,
          chat_id: data.version_chat_id,
          include_reasoning: true,
          is_edit_regeneration: true,
          existing_message_id: data.target_message_id
        };
        await fetch('/api/chat/stream', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload)
        });
      }
    }
  }

  private async executeRetry(step: TestStep): Promise<void> {
    if (!step.target.messageId) {
      throw new Error('Retry requires messageId');
    }

    const response = await fetch('/api/db/versioning/notify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        operation_type: 'retry',
        message_id: step.target.messageId,
        chat_id: this.mockEnv.getState().currentChatId
      })
    });

    const data = await response.json();
    if (data && data.version_chat_id) {
      // Switch to the new version chat
      await fetch('/api/chat/switch', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: data.version_chat_id })
      });

      // Start streaming if required (assistant retry or user retry)
      if (data.needs_streaming && data.stream_message) {
        const payload: any = {
          message: data.stream_message,
          chat_id: data.version_chat_id,
          include_reasoning: true,
          is_retry: true
        };
        await fetch('/api/chat/stream', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload)
        });
      }
    }
  }

  private async executeDelete(step: TestStep): Promise<void> {
    if (!step.target.messageId) {
      throw new Error('Delete requires messageId');
    }

    const response = await fetch('/api/db/versioning/notify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        operation_type: 'delete',
        message_id: step.target.messageId,
        chat_id: this.mockEnv.getState().currentChatId
      })
    });

    const data = await response.json();
    if (data && data.version_chat_id) {
      // Switch to the version chat reflecting deletion
      await fetch('/api/chat/switch', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: data.version_chat_id })
      });
    }
  }

  private async executeSwitchVersion(step: TestStep): Promise<void> {
    if (!step.target.chatId) {
      throw new Error('Switch version requires chatId');
    }

    await fetch('/api/chat/switch', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: step.target.chatId
      })
    });
  }

  private async executeHover(step: TestStep): Promise<void> {
    this.mockEnv.simulateHover(step.target.messageId || null);
  }

  private async executeClickSwitcher(step: TestStep): Promise<void> {
    if (!step.target.messageId) {
      throw new Error('Click switcher requires messageId');
    }
    this.mockEnv.simulateDropdownClick(step.target.messageId);
  }

  private async executeSelectVersion(step: TestStep): Promise<void> {
    if (!step.target.messageId || !step.target.versionNumber) {
      throw new Error('Select version requires messageId and versionNumber');
    }

    const state = this.mockEnv.getState();
    const versions = state.versions[step.target.messageId];
    
    if (!versions) {
      throw new Error(`No versions found for message ${step.target.messageId}`);
    }

    const targetVersion = versions.find(v => v.version_number === step.target.versionNumber);
    if (!targetVersion) {
      throw new Error(`Version ${step.target.versionNumber} not found`);
    }

    // Close dropdown
    this.mockEnv.setState({ activeDropdown: null });

    // Switch to the chat containing this version
    await fetch('/api/chat/switch', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: targetVersion.chat_version_id
      })
    });
  }

  private async executeSendMessage(step: TestStep): Promise<void> {
    if (!step.payload?.content) {
      throw new Error('Send message requires content in payload');
    }

    const state = this.mockEnv.getState();
    const newMessageId = `${state.currentChatId}_${state.messages.length + 1}`;
    
    const newMsg = {
      id: newMessageId,
      role: 'user',
      content: step.payload.content,
      created_at: new Date().toISOString()
    } as any;
    state.messages.push(newMsg);

    // Close any open dropdown when sending a message
    this.mockEnv.setState({ 
      messages: state.messages,
      activeDropdown: null 
    });

    // Track in the full store so switching back restores it
    this.mockEnv.recordUserMessage(newMsg);
  }

  private async executeCancelStreaming(step: TestStep): Promise<void> {
    const chatId = step.target.chatId || this.mockEnv.getState().currentChatId;
    
    // Call cancel streaming endpoint
    await fetch('/api/db/chat/' + chatId + '/cancel-streaming', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' }
    });

    // Update local state to reflect cancellation
    this.mockEnv.setState({ isStreaming: false });
  }

  private async executeDeleteChat(step: TestStep): Promise<void> {
    if (!step.target.chatId) {
      throw new Error('Delete chat requires chatId');
    }

    // Simulate chat deletion
    await fetch('/api/db/chat/' + step.target.chatId, {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' }
    });

    // If it's the current chat, clear the state
    const state = this.mockEnv.getState();
    if (state.currentChatId === step.target.chatId) {
      this.mockEnv.setState({ 
        messages: [], 
        currentChatId: '',
        versions: {}
      });
    }
  }

  /**
   * Validation methods
   */
  private validateState(actual: any, expected: any): { passed: boolean; error?: string } {
    try {
      const validation = this.deepCompare(actual, expected);
      if (!validation.matches) {
        return { 
          passed: false, 
          error: `State mismatch at ${validation.path}: expected ${JSON.stringify(validation.expected)}, got ${JSON.stringify(validation.actual)}` 
        };
      }
      return { passed: true };
    } catch (error) {
      return { 
        passed: false, 
        error: error instanceof Error ? error.message : String(error) 
      };
    }
  }

  // Poll current state until it matches the expected partial state or timeout.
  private async waitUntilStateMatches(expected: any, timeoutMs: number = 3000): Promise<void> {
    const start = Date.now();
    while (true) {
      const current = this.mockEnv.getState();
      const validation = this.validateState(current, expected);
      if (validation.passed) return;
      if (Date.now() - start > timeoutMs) return;
      await this.sleep(25);
    }
  }

  private validateOutcome(outcome: ExpectedOutcome, state: StateSnapshot): { passed: boolean; error?: string } {
    const { condition } = outcome;
    
    // For API-type outcomes, check the mock environment's API call history
    let value: any;
    if (outcome.type === 'api') {
      // Get the value from the mock environment's API call history
      const lastApiCall = this.mockEnv.lastApiCall;
      if (condition.field.startsWith('lastApiCall.')) {
        const fieldPath = condition.field.replace('lastApiCall.', '');
        value = lastApiCall ? this.getValueByPath(lastApiCall, fieldPath) : undefined;
      } else {
        value = this.getValueByPath({ lastApiCall }, condition.field);
      }
    } else {
      // For other outcome types, check the state
      value = this.getValueByPath(state, condition.field);
    }

    switch (condition.operator) {
      case 'equals':
        if (value !== condition.value) {
          return { 
            passed: false, 
            error: `${outcome.description}: Expected ${condition.field} to equal ${JSON.stringify(condition.value)}, got ${JSON.stringify(value)}` 
          };
        }
        break;
      case 'contains':
        if (!value || !value.includes(condition.value)) {
          return { 
            passed: false, 
            error: `${outcome.description}: Expected ${condition.field} to contain ${JSON.stringify(condition.value)}` 
          };
        }
        break;
      case 'exists':
        if (value === undefined || value === null) {
          return { 
            passed: false, 
            error: `${outcome.description}: Expected ${condition.field} to exist` 
          };
        }
        break;
      case 'not-exists': {
        // If a specific value is provided and the field is an array, assert it does NOT contain the value
        if (condition.value !== undefined && Array.isArray(value)) {
          if (value.includes(condition.value)) {
            return {
              passed: false,
              error: `${outcome.description}: Expected ${condition.field} to not include ${JSON.stringify(condition.value)}`
            };
          }
          break;
        }
        // Otherwise, assert the field itself is absent/empty
        if (value !== undefined && value !== null && value !== '') {
          return {
            passed: false,
            error: `${outcome.description}: Expected ${condition.field} to not exist`
          };
        }
        break;
      }
      case 'not-contains':
        if (!Array.isArray(value)) {
          return {
            passed: false,
            error: `${outcome.description}: Expected ${condition.field} to be an array to apply not-contains`
          };
        }
        if (value.includes(condition.value)) {
          return {
            passed: false,
            error: `${outcome.description}: Expected ${condition.field} to not contain ${JSON.stringify(condition.value)}`
          };
        }
        break;
      case 'greater-than':
        if (typeof value !== 'number' || value <= condition.value) {
          return { 
            passed: false, 
            error: `${outcome.description}: Expected ${condition.field} to be greater than ${condition.value}, got ${value}` 
          };
        }
        break;
      case 'less-than':
        if (typeof value !== 'number' || value >= condition.value) {
          return { 
            passed: false, 
            error: `${outcome.description}: Expected ${condition.field} to be less than ${condition.value}, got ${value}` 
          };
        }
        break;
    }

    return { passed: true };
  }

  private deepCompare(actual: any, expected: any, path: string = ''): { matches: boolean; path?: string; expected?: any; actual?: any } {
    if (expected === undefined) return { matches: true };

    if (typeof expected !== typeof actual) {
      return { matches: false, path, expected, actual };
    }

    if (typeof expected === 'object' && expected !== null) {
      if (Array.isArray(expected)) {
        if (!Array.isArray(actual) || expected.length !== actual.length) {
          return { matches: false, path, expected, actual };
        }
        for (let i = 0; i < expected.length; i++) {
          const result = this.deepCompare(actual[i], expected[i], `${path}[${i}]`);
          if (!result.matches) return result;
        }
      } else {
        for (const key in expected) {
          const result = this.deepCompare(actual[key], expected[key], path ? `${path}.${key}` : key);
          if (!result.matches) return result;
        }
      }
      return { matches: true };
    }

    if (expected !== actual) {
      return { matches: false, path, expected, actual };
    }

    return { matches: true };
  }

  private getValueByPath(obj: any, path: string): any {
    const parts = path.split('.');
    let current = obj;
    
    for (const part of parts) {
      // Handle array indexing
      const arrayMatch = part.match(/(.+)\[(\d+)\]/);
      if (arrayMatch) {
        const [, key, index] = arrayMatch;
        current = current[key];
        if (!Array.isArray(current)) return undefined;
        current = current[parseInt(index, 10)];
      } else {
        current = current[part];
      }
      
      if (current === undefined) return undefined;
    }
    
    return current;
  }

  /**
   * Control methods
   */
  public pause(): void {
    this.isPaused = true;
    this.notifyStateChange();
  }

  public resume(): void {
    this.isPaused = false;
    this.notifyStateChange();
  }

  public stop(): void {
    this.isRunning = false;
    this.isPaused = false;
    this.currentScenario = null;
    this.currentStepIndex = 0;
    this.notifyStateChange();
  }

  public reset(): void {
    this.stop();
    this.results = [];
    this.stateHistory = [];
    this.mockEnv.cleanup();
    this.notifyStateChange();
  }

  /**
   * Getters
   */
  public getState(): RunnerState {
    return {
      isRunning: this.isRunning,
      isPaused: this.isPaused,
      currentScenario: this.currentScenario,
      currentStepIndex: this.currentStepIndex,
      totalSteps: this.currentScenario?.steps.length || 0,
      results: this.results,
      currentState: this.mockEnv.getState(),
      stateHistory: this.stateHistory
    };
  }

  public getResults(): TestResult[] {
    return [...this.results];
  }

  public getLastResult(): TestResult | null {
    return this.results[this.results.length - 1] || null;
  }

  /**
   * Utility methods
   */
  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  private notifyStateChange(): void {
    this.onStateChange?.(this.getState());
  }

  /**
   * Cleanup
   */
  public cleanup(): void {
    this.mockEnv.cleanup();
    this.reset();
  }
}

export interface RunnerState {
  isRunning: boolean;
  isPaused: boolean;
  currentScenario: TestScenario | null;
  currentStepIndex: number;
  totalSteps: number;
  results: TestResult[];
  currentState: StateSnapshot;
  stateHistory: StateSnapshot[];
}
