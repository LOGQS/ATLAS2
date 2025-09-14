/**
 * Test UI Component for versioning functionality
 */

import React, { useState, useEffect, useCallback, useRef } from 'react';
import { TestRunner, RunnerState } from './testRunner';
import { testScenarios, getHighPriorityScenarios, getScenariosByCategory } from './scenarios';
import { TestScenario, TestResult, TestStepResult, StateSnapshot } from './types';
import { TestResultSaver } from './testResultSaver';
import './TestUI.css';

const TestUI: React.FC = () => {
  const [runnerState, setRunnerState] = useState<RunnerState | null>(null);
  const [selectedScenario, setSelectedScenario] = useState<TestScenario | null>(null);
  const [selectedCategory, setSelectedCategory] = useState<string>('all');
  const [autoSave, setAutoSave] = useState(false);
  const [showStateDetails, setShowStateDetails] = useState(false);
  const [currentStepResult, setCurrentStepResult] = useState<TestStepResult | null>(null);
  const [expandedResults, setExpandedResults] = useState<Set<string>>(new Set());
  const [isRunningAll, setIsRunningAll] = useState(false);
  const runnerRef = useRef<TestRunner | null>(null);
  const stopRequestedRef = useRef(false);
  const batchResultsRef = useRef<Array<{
    scenario: TestScenario;
    result: TestResult;
    stateHistory: StateSnapshot[];
  }>>([]);

  useEffect(() => {
    // Initialize test runner
    const runner = new TestRunner();
    runner.setEventHandlers({
      onStateChange: setRunnerState,
      onStepComplete: setCurrentStepResult,
      onScenarioComplete: (result) => {
        console.log('Scenario completed:', result);
      }
    });
    runnerRef.current = runner;

    return () => {
      runner.cleanup();
    };
  }, []);

  // Keep runner's auto-save in sync with checkbox
  useEffect(() => {
    if (runnerRef.current) {
      runnerRef.current.setAutoSave(autoSave);
    }
  }, [autoSave]);

  const getFilteredScenarios = useCallback((): TestScenario[] => {
    if (selectedCategory === 'all') {
      return testScenarios;
    } else if (selectedCategory === 'high-priority') {
      return getHighPriorityScenarios();
    } else {
      return getScenariosByCategory(selectedCategory);
    }
  }, [selectedCategory]);

  const runScenario = useCallback(async (scenario: TestScenario) => {
    if (!runnerRef.current) return;
    setSelectedScenario(scenario);
    setCurrentStepResult(null);
    await runnerRef.current.runScenario(scenario);
  }, []);

  const runAllScenarios = useCallback(async () => {
    if (!runnerRef.current || isRunningAll) return;
    
    setIsRunningAll(true);
    stopRequestedRef.current = false;
    batchResultsRef.current = []; // Clear previous batch results
    const scenarios = getFilteredScenarios();
    const failedScenarios: Array<{
      scenario: TestScenario;
      result: TestResult;
      stateHistory: StateSnapshot[];
    }> = [];
    
    for (let i = 0; i < scenarios.length; i++) {
      if (stopRequestedRef.current) break;
      
      const scenario = scenarios[i];
      await runScenario(scenario);
      
      // Collect result for batch saving
      const lastResult = runnerRef.current.getLastResult();
      const stateHistory = runnerRef.current.getState().stateHistory;
      if (lastResult) {
        const resultData = {
          scenario,
          result: lastResult,
          stateHistory: [...stateHistory]
        };
        batchResultsRef.current.push(resultData);
        
        if (!lastResult.passed) {
          failedScenarios.push(resultData);
        }
      }
      
      // Small delay between scenarios for visual clarity (longer if auto-run for better visibility)
      if (i < scenarios.length - 1 && !stopRequestedRef.current) {
        await new Promise(resolve => setTimeout(resolve, 500));
      }
    }
    
    // Auto-save batch results if enabled and we completed all scenarios
    if (autoSave && batchResultsRef.current.length > 0 && !stopRequestedRef.current) {
      TestResultSaver.saveBatchResults(batchResultsRef.current);
      if (failedScenarios.length > 0) {
        TestResultSaver.generateErrorReport(failedScenarios);
      }
    }
    
    setIsRunningAll(false);
  }, [getFilteredScenarios, runScenario, isRunningAll, autoSave]);

  const handlePauseResume = useCallback(() => {
    if (!runnerRef.current) return;
    if (runnerState?.isPaused) {
      runnerRef.current.resume();
    } else {
      runnerRef.current.pause();
    }
  }, [runnerState]);

  const handleStop = useCallback(() => {
    if (!runnerRef.current) return;
    stopRequestedRef.current = true;
    runnerRef.current.stop();
    setIsRunningAll(false);
  }, []);

  const handleReset = useCallback(() => {
    if (!runnerRef.current) return;
    stopRequestedRef.current = true;
    runnerRef.current.reset();
    setSelectedScenario(null);
    setCurrentStepResult(null);
    setIsRunningAll(false);
  }, []);

  const toggleResultExpansion = useCallback((resultId: string) => {
    setExpandedResults(prev => {
      const next = new Set(prev);
      if (next.has(resultId)) {
        next.delete(resultId);
      } else {
        next.add(resultId);
      }
      return next;
    });
  }, []);

  const renderScenarioList = () => {
    const scenarios = getFilteredScenarios();
    const categories = ['all', 'high-priority', 'edit', 'retry', 'delete', 'switcher', 'complex', 'edge-case'];

    return (
      <div className="scenario-list">
        <div className="category-filter">
          <label>Filter by category:</label>
          <select value={selectedCategory} onChange={(e) => setSelectedCategory(e.target.value)}>
            {categories.map(cat => (
              <option key={cat} value={cat}>{cat}</option>
            ))}
          </select>
        </div>
        
        <div className="scenarios">
          {scenarios.map(scenario => (
            <div 
              key={scenario.id} 
              className={`scenario-item ${selectedScenario?.id === scenario.id ? 'selected' : ''}`}
              onClick={() => setSelectedScenario(scenario)}
            >
              <div className="scenario-header">
                <h4>{scenario.name}</h4>
                <span className={`priority priority-${scenario.priority}`}>{scenario.priority}</span>
              </div>
              <p>{scenario.description}</p>
              <div className="scenario-meta">
                <span className="category">{scenario.category}</span>
                <span className="steps">{scenario.steps.length} steps</span>
              </div>
              <div className="scenario-tags">
                {scenario.tags.map(tag => (
                  <span key={tag} className="tag">{tag}</span>
                ))}
              </div>
              <button 
                className="run-button"
                onClick={(e) => {
                  e.stopPropagation();
                  runScenario(scenario);
                }}
                disabled={runnerState?.isRunning || isRunningAll}
              >
                Run
              </button>
            </div>
          ))}
        </div>
      </div>
    );
  };

  const renderCurrentExecution = () => {
    if (!runnerState || !runnerState.currentScenario) {
      return <div className="no-execution">No test running</div>;
    }

    const progress = (runnerState.currentStepIndex / runnerState.totalSteps) * 100;

    return (
      <div className="current-execution">
        <h3>{runnerState.currentScenario.name}</h3>
        <div className="execution-controls">
          <button onClick={handlePauseResume}>
            {runnerState.isPaused ? 'Resume' : 'Pause'}
          </button>
          <button onClick={handleStop}>Stop</button>
        </div>
        
        <div className="progress-bar">
          <div className="progress-fill" style={{ width: `${progress}%` }} />
          <span className="progress-text">
            Step {runnerState.currentStepIndex + 1} / {runnerState.totalSteps}
          </span>
        </div>

        <div className="steps-list">
          {runnerState.currentScenario.steps.map((step, index) => (
            <div 
              key={step.id} 
              className={`step-item ${
                index < runnerState.currentStepIndex ? 'completed' : 
                index === runnerState.currentStepIndex ? 'current' : 'pending'
              }`}
            >
              <span className="step-number">{index + 1}</span>
              <span className="step-action">{step.action}</span>
              <span className="step-description">{step.description}</span>
            </div>
          ))}
        </div>

        {currentStepResult && (
          <div className={`current-step-result ${currentStepResult.passed ? 'passed' : 'failed'}`}>
            <h4>Last Step Result</h4>
            <p>{currentStepResult.stepDescription}</p>
            {currentStepResult.error && (
              <div className="error-message">{currentStepResult.error}</div>
            )}
            <span className="duration">{currentStepResult.duration}ms</span>
          </div>
        )}
      </div>
    );
  };

  const renderState = () => {
    if (!runnerState) return null;

    const state = runnerState.currentState;

    return (
      <div className="state-view">
        <h3>Current State</h3>
        <button onClick={() => setShowStateDetails(!showStateDetails)}>
          {showStateDetails ? 'Hide' : 'Show'} Details
        </button>
        
        <div className="state-summary">
          <div className="state-item">
            <label>Chat ID:</label>
            <span>{state.currentChatId}</span>
          </div>
          <div className="state-item">
            <label>Messages:</label>
            <span>{state.messages.length}</span>
          </div>
          <div className="state-item">
            <label>Versions:</label>
            <span>{Object.keys(state.versions).length} messages with versions</span>
          </div>
          <div className="state-item">
            <label>Streaming:</label>
            <span className={state.isStreaming ? 'active' : 'inactive'}>
              {state.isStreaming ? 'Yes' : 'No'}
            </span>
          </div>
          <div className="state-item">
            <label>Send Button:</label>
            <span className={state.sendButtonDisabled ? 'disabled' : 'enabled'}>
              {state.sendButtonDisabled ? 'Disabled' : 'Enabled'}
            </span>
          </div>
          <div className="state-item">
            <label>Operation:</label>
            <span>{state.operationInProgress || 'None'}</span>
          </div>
        </div>

        {showStateDetails && (
          <div className="state-details">
            <h4>Messages</h4>
            <pre>{JSON.stringify(state.messages, null, 2)}</pre>
            
            <h4>Versions</h4>
            <pre>{JSON.stringify(state.versions, null, 2)}</pre>
            
            <h4>UI State</h4>
            <pre>{JSON.stringify({
              visibleSwitchers: state.visibleSwitchers,
              activeDropdown: state.activeDropdown
            }, null, 2)}</pre>
          </div>
        )}
      </div>
    );
  };

  const renderResults = () => {
    if (!runnerState || runnerState.results.length === 0) {
      return <div className="no-results">No test results yet</div>;
    }

    const totalTests = runnerState.results.length;
    const passedTests = runnerState.results.filter(r => r.passed).length;
    const failedTests = totalTests - passedTests;
    const passRate = totalTests > 0 ? (passedTests / totalTests * 100).toFixed(1) : 0;

    return (
      <div className="results-view">
        <div className="results-summary">
          <h3>Test Results</h3>
          <div className="summary-stats">
            <div className="stat">
              <label>Total:</label>
              <span>{totalTests}</span>
            </div>
            <div className="stat passed">
              <label>Passed:</label>
              <span>{passedTests}</span>
            </div>
            <div className="stat failed">
              <label>Failed:</label>
              <span>{failedTests}</span>
            </div>
            <div className="stat">
              <label>Pass Rate:</label>
              <span>{passRate}%</span>
            </div>
          </div>
        </div>

        <div className="results-list">
          {runnerState.results.map((result, index) => (
            <div key={`${result.scenarioId}-${index}`} className={`result-item ${result.passed ? 'passed' : 'failed'}`}>
              <div 
                className="result-header"
                onClick={() => toggleResultExpansion(`${result.scenarioId}-${index}`)}
              >
                <span className="result-status">{result.passed ? '✓' : '✗'}</span>
                <span className="result-name">{result.scenarioName}</span>
                <span className="result-duration">{result.duration}ms</span>
                <span className="result-expand">
                  {expandedResults.has(`${result.scenarioId}-${index}`) ? '▼' : '▶'}
                </span>
              </div>
              
              {expandedResults.has(`${result.scenarioId}-${index}`) && (
                <div className="result-details">
                  <div className="steps-summary">
                    <h4>Steps</h4>
                    <div className="passed-steps">
                      <h5>Passed ({result.passedSteps.length})</h5>
                      {result.passedSteps.map(step => (
                        <div key={step.stepId} className="step-result passed">
                          <span>✓</span> {step.stepDescription}
                        </div>
                      ))}
                    </div>
                    {result.failedSteps.length > 0 && (
                      <div className="failed-steps">
                        <h5>Failed ({result.failedSteps.length})</h5>
                        {result.failedSteps.map(step => (
                          <div key={step.stepId} className="step-result failed">
                            <span>✗</span> {step.stepDescription}
                            {step.error && <div className="error">{step.error}</div>}
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                  
                  {result.errorMessages.length > 0 && (
                    <div className="error-messages">
                      <h4>Errors</h4>
                      {result.errorMessages.map((error, i) => (
                        <div key={i} className="error-message">{error}</div>
                      ))}
                    </div>
                  )}
                </div>
              )}
            </div>
          ))}
        </div>
      </div>
    );
  };

  return (
    <div className="test-ui-container">
      <div className="test-ui-header">
        <h1>Versioning Test Framework</h1>
        <div className="global-controls">
          <label>
            <input
              type="checkbox"
              checked={autoSave}
              onChange={(e) => setAutoSave(e.target.checked)}
            />
            Auto-save
          </label>
          <button onClick={runAllScenarios} disabled={runnerState?.isRunning || isRunningAll}>
            {isRunningAll ? 'Running...' : 'Run All'}
          </button>
          <button onClick={handleReset}>Reset All</button>
          <button 
            onClick={() => {
              if (runnerState?.results && runnerState.results.length > 0) {
                const results = runnerState.results.map((result, index) => ({
                  scenario: testScenarios.find(s => s.id === result.scenarioId)!,
                  result,
                  stateHistory: runnerState.stateHistory
                }));
                TestResultSaver.saveBatchResults(results);
              }
            }}
            disabled={!runnerState?.results || runnerState.results.length === 0}
          >
            Save Results
          </button>
        </div>
      </div>

      <div className="test-ui-body">
        <div className="left-panel">
          <h2>Test Scenarios</h2>
          {renderScenarioList()}
        </div>

        <div className="middle-panel">
          <h2>Execution</h2>
          {renderCurrentExecution()}
          {renderState()}
        </div>

        <div className="right-panel">
          <h2>Results</h2>
          {renderResults()}
        </div>
      </div>
    </div>
  );
};

export default TestUI;
