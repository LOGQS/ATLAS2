/**
 * Type definitions for the versioning test framework
 */

export interface TestScenario {
  id: string;
  name: string;
  description: string;
  category: 'edit' | 'retry' | 'delete' | 'switcher' | 'complex' | 'edge-case';
  steps: TestStep[];
  initialState: InitialState;
  expectedOutcomes: ExpectedOutcome[];
  tags: string[];
  priority: 'high' | 'medium' | 'low';
}

export interface TestStep {
  id: string;
  action: TestAction;
  target: TargetSpecifier;
  payload?: any;
  delay?: number;
  description: string;
  expectedState?: Partial<StateSnapshot>;
}

export type TestAction = 
  | 'edit'
  | 'retry'
  | 'delete'
  | 'switch-version'
  | 'hover-message'
  | 'click-switcher'
  | 'select-version'
  | 'send-message'
  | 'wait'
  | 'verify-state'
  | 'cancel-streaming'
  | 'delete-chat';

export interface TargetSpecifier {
  messageId?: string;
  messageIndex?: number;
  versionNumber?: number;
  chatId?: string;
  element?: string;
}

export interface InitialState {
  chatId: string;
  messages: MockMessage[];
  versions?: VersionMap;
  isStreaming?: boolean;
  sendButtonDisabled?: boolean;
}

export interface MockMessage {
  id: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  created_at: string;
  attachedFiles?: any[];
  isStreaming?: boolean;
}

export interface VersionInfo {
  version_number: number;
  chat_version_id: string;
  operation: 'edit' | 'retry' | 'delete' | 'original';
  created_at: string;
  content?: string;
  parent_version?: string;
}

export interface VersionMap {
  [messageId: string]: VersionInfo[];
}

export interface ExpectedOutcome {
  stepId: string;
  type: 'state' | 'ui' | 'api' | 'error';
  condition: ValidationCondition;
  description: string;
}

export interface ValidationCondition {
  field: string;
  operator: 'equals' | 'contains' | 'exists' | 'not-exists' | 'greater-than' | 'less-than' | 'not-contains';
  value?: any;
  path?: string[];
}

export interface StateSnapshot {
  messages: MockMessage[];
  versions: VersionMap;
  currentChatId: string;
  isStreaming: boolean;
  sendButtonDisabled: boolean;
  visibleSwitchers: string[];
  activeDropdown: string | null;
  operationInProgress: string | null;
  lastApiCall?: ApiCall;
}

export interface ApiCall {
  method: string;
  url: string;
  body?: any;
  response?: any;
  timestamp: number;
}

export interface TestResult {
  scenarioId: string;
  scenarioName: string;
  passed: boolean;
  failedSteps: TestStepResult[];
  passedSteps: TestStepResult[];
  duration: number;
  timestamp: number;
  errorMessages: string[];
  stateSnapshots: StateSnapshot[];
}

export interface TestStepResult {
  stepId: string;
  stepDescription: string;
  passed: boolean;
  error?: string;
  actualState?: any;
  expectedState?: any;
  duration: number;
}

export interface TestRunner {
  scenarios: TestScenario[];
  currentScenario: TestScenario | null;
  currentStep: number;
  state: StateSnapshot;
  results: TestResult[];
  isRunning: boolean;
  isPaused: boolean;
}

export interface MockApiConfig {
  simulateLatency: boolean;
  latencyRange: [number, number];
  failureRate: number;
  streamingDelay: number;
  interceptFetch: boolean;
}
