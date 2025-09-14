# Test Results Directory

This directory stores JSON test results from the versioning test framework.

## How It Works

When you run tests using the test framework:
1. **Individual tests** automatically download a JSON file with full test details
2. **"Run All" tests** download batch results plus an error report if any tests failed
3. Save the downloaded files to this directory for analysis

## File Naming Convention

### Individual Test Results
- **PASS**: `test_PASS_[scenario-id]_[timestamp].json`
- **FAIL**: `test_FAIL_[scenario-id]_[timestamp].json`

### Batch Test Results
- `batch_test_[passed]pass_[failed]fail_[timestamp].json`

### Error Reports
- `error_report_[failures]failures_[timestamp].json`

## File Contents

Each JSON file contains:
- **metadata**: Test information, timestamp, environment details
- **scenario**: The test scenario that was executed
- **result**: Pass/fail status with detailed step results
- **stateHistory**: Complete state at each step of execution
- **apiCalls**: All mocked API calls made during the test
- **summary**: Quick overview of test results

## Analyzing Results

1. **Check failure reasons**: Look at `result.errorMessages` and `result.failedSteps`
2. **Review state changes**: Examine `stateHistory` to see how state evolved
3. **Debug API calls**: Check `apiCalls` to verify correct API interactions
4. **Compare states**: Use `detailedSteps` to see state before/after each step

## Example Usage

```javascript
// Load and analyze a test result
const result = require('./test_FAIL_edit-user_2024-01-15T10-30-45.json');

// Check what failed
console.log('Failed steps:', result.result.failedSteps);
console.log('Error messages:', result.result.errorMessages);

// Review state at failure point
const failureIndex = result.result.passedSteps.length;
console.log('State at failure:', result.stateHistory[failureIndex]);
```

## Tips

- Keep failed test results for debugging
- Compare passing vs failing results to identify issues
- Use batch results to spot patterns in failures
- Check error reports for common failure reasons

## Cleanup

Periodically clean old test results to save space:
```bash
# Remove test results older than 7 days
find . -name "*.json" -mtime +7 -delete
```