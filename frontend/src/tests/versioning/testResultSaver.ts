/**
 * Test result saver - saves test results as JSON files for debugging
 */

import { TestResult, TestScenario, StateSnapshot } from './types';

export interface SavedTestResult {
  metadata: {
    timestamp: number;
    dateTime: string;
    scenarioId: string;
    scenarioName: string;
    category: string;
    tags: string[];
    duration: number;
    passed: boolean;
    environment: {
      userAgent: string;
      viewport: {
        width: number;
        height: number;
      };
      timestamp: number;
    };
  };
  scenario: TestScenario;
  result: TestResult;
  detailedSteps: {
    stepId: string;
    description: string;
    passed: boolean;
    duration: number;
    error?: string;
    actualState?: any;
    expectedState?: any;
    stateBeforeStep?: StateSnapshot;
    stateAfterStep?: StateSnapshot;
  }[];
  stateHistory: StateSnapshot[];
  apiCalls: any[];
  summary: {
    totalSteps: number;
    passedSteps: number;
    failedSteps: number;
    passRate: string;
    totalDuration: number;
    failureReasons: string[];
  };
}

export class TestResultSaver {
  /**
   * Save test result as JSON file
   */
  static saveTestResult(
    scenario: TestScenario,
    result: TestResult,
    stateHistory: StateSnapshot[],
    apiCalls: any[] = []
  ): void {
    try {
      // Create detailed result object
      const savedResult: SavedTestResult = {
        metadata: {
          timestamp: result.timestamp,
          dateTime: new Date(result.timestamp).toISOString(),
          scenarioId: scenario.id,
          scenarioName: scenario.name,
          category: scenario.category,
          tags: scenario.tags,
          duration: result.duration,
          passed: result.passed,
          environment: {
            userAgent: navigator.userAgent,
            viewport: {
              width: window.innerWidth,
              height: window.innerHeight
            },
            timestamp: Date.now()
          }
        },
        scenario: scenario,
        result: result,
        detailedSteps: [
          ...result.passedSteps.map((step, index) => ({
            stepId: step.stepId,
            description: step.stepDescription,
            passed: step.passed,
            duration: step.duration,
            error: step.error,
            actualState: step.actualState,
            expectedState: step.expectedState,
            stateBeforeStep: stateHistory[index] || undefined,
            stateAfterStep: stateHistory[index + 1] || undefined
          })),
          ...result.failedSteps.map((step, index) => ({
            stepId: step.stepId,
            description: step.stepDescription,
            passed: step.passed,
            duration: step.duration,
            error: step.error,
            actualState: step.actualState,
            expectedState: step.expectedState,
            stateBeforeStep: stateHistory[result.passedSteps.length + index] || undefined,
            stateAfterStep: stateHistory[result.passedSteps.length + index + 1] || undefined
          }))
        ].sort((a, b) => {
          // Sort by original step order
          const aIndex = scenario.steps.findIndex(s => s.id === a.stepId);
          const bIndex = scenario.steps.findIndex(s => s.id === b.stepId);
          return aIndex - bIndex;
        }),
        stateHistory: stateHistory,
        apiCalls: apiCalls,
        summary: {
          totalSteps: result.passedSteps.length + result.failedSteps.length,
          passedSteps: result.passedSteps.length,
          failedSteps: result.failedSteps.length,
          passRate: ((result.passedSteps.length / (result.passedSteps.length + result.failedSteps.length)) * 100).toFixed(1) + '%',
          totalDuration: result.duration,
          failureReasons: result.errorMessages
        }
      };

      // Generate filename with timestamp and scenario ID
      const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, -5);
      const status = result.passed ? 'PASS' : 'FAIL';
      const filename = `test_${status}_${scenario.id}_${timestamp}.json`;

      // Convert to JSON with pretty formatting
      const jsonContent = JSON.stringify(savedResult, null, 2);

      // Create blob and download
      const blob = new Blob([jsonContent], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = filename;
      
      // Note for user about where to save
      console.log(`📁 Save this file to: frontend/src/tests/ran_tests/${filename}`);
      
      // Trigger download
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
      
      // Clean up
      setTimeout(() => URL.revokeObjectURL(url), 100);

      // Log success
      console.log(`✅ Test result saved: ${filename}`);
      console.log(`   Status: ${status}`);
      console.log(`   Duration: ${result.duration}ms`);
      console.log(`   Steps: ${result.passedSteps.length}/${savedResult.summary.totalSteps} passed`);
      
    } catch (error) {
      console.error('Failed to save test result:', error);
    }
  }

  /**
   * Save batch test results (for "Run All" scenarios)
   */
  static saveBatchResults(
    results: Array<{
      scenario: TestScenario;
      result: TestResult;
      stateHistory: StateSnapshot[];
      apiCalls?: any[];
    }>
  ): void {
    try {
      const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, -5);
      const totalPassed = results.filter(r => r.result.passed).length;
      const totalFailed = results.length - totalPassed;
      
      const batchSummary = {
        metadata: {
          timestamp: Date.now(),
          dateTime: new Date().toISOString(),
          totalScenarios: results.length,
          passed: totalPassed,
          failed: totalFailed,
          passRate: ((totalPassed / results.length) * 100).toFixed(1) + '%',
          environment: {
            userAgent: navigator.userAgent,
            viewport: {
              width: window.innerWidth,
              height: window.innerHeight
            }
          }
        },
        scenarios: results.map(r => ({
          id: r.scenario.id,
          name: r.scenario.name,
          category: r.scenario.category,
          passed: r.result.passed,
          duration: r.result.duration,
          failedSteps: r.result.failedSteps.length,
          totalSteps: r.result.passedSteps.length + r.result.failedSteps.length,
          errors: r.result.errorMessages
        })),
        detailedResults: results.map(r => ({
          scenario: r.scenario,
          result: r.result,
          stateHistory: r.stateHistory,
          apiCalls: r.apiCalls || []
        }))
      };

      const filename = `batch_test_${totalPassed}pass_${totalFailed}fail_${timestamp}.json`;
      const jsonContent = JSON.stringify(batchSummary, null, 2);
      
      const blob = new Blob([jsonContent], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = filename;
      
      console.log(`📁 Save batch results to: frontend/src/tests/ran_tests/${filename}`);
      
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
      
      setTimeout(() => URL.revokeObjectURL(url), 100);
      
      console.log(`✅ Batch results saved: ${filename}`);
      console.log(`   Total: ${results.length} scenarios`);
      console.log(`   Passed: ${totalPassed}`);
      console.log(`   Failed: ${totalFailed}`);
      
    } catch (error) {
      console.error('Failed to save batch results:', error);
    }
  }

  /**
   * Generate a detailed error report for failed tests
   */
  static generateErrorReport(
    failedResults: Array<{
      scenario: TestScenario;
      result: TestResult;
      stateHistory: StateSnapshot[];
    }>
  ): void {
    if (failedResults.length === 0) return;

    try {
      const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, -5);
      
      const errorReport = {
        metadata: {
          timestamp: Date.now(),
          dateTime: new Date().toISOString(),
          totalFailures: failedResults.length,
          title: 'Test Failure Report'
        },
        failures: failedResults.map(f => ({
          scenario: {
            id: f.scenario.id,
            name: f.scenario.name,
            category: f.scenario.category,
            description: f.scenario.description
          },
          failedSteps: f.result.failedSteps.map(step => ({
            stepId: step.stepId,
            description: step.stepDescription,
            error: step.error,
            expectedState: step.expectedState,
            actualState: step.actualState
          })),
          errorMessages: f.result.errorMessages,
          lastKnownGoodState: f.stateHistory[f.result.passedSteps.length - 1] || null,
          failureState: f.stateHistory[f.result.passedSteps.length] || null
        }))
      };

      const filename = `error_report_${failedResults.length}failures_${timestamp}.json`;
      const jsonContent = JSON.stringify(errorReport, null, 2);
      
      const blob = new Blob([jsonContent], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = filename;
      
      console.log(`📁 Save error report to: frontend/src/tests/ran_tests/${filename}`);
      
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
      
      setTimeout(() => URL.revokeObjectURL(url), 100);
      
      console.log(`📋 Error report generated: ${filename}`);
      
    } catch (error) {
      console.error('Failed to generate error report:', error);
    }
  }
}