# Versioning Test Framework

A comprehensive testing framework for the versioning and message switcher functionality.

## 🚀 Quick Start

1. Start your development server: `npm start`
2. Navigate to: `http://localhost:3000?test=versioning`
3. The test UI will load with all available test scenarios

## 📋 Test Categories

### Basic Operations
- **Edit**: Test editing user and assistant messages
- **Retry**: Test retrying assistant responses
- **Delete**: Test deleting messages and chains

### UI Interactions
- **Switcher**: Test version switcher visibility and dropdown
- **Hover**: Test hover behavior for version controls
- **Navigation**: Test switching between versions

### Complex Scenarios
- **Branching**: Create and navigate multiple version branches
- **Chain Operations**: Test operations on message chains
- **State Management**: Verify state consistency

### Edge Cases
- **Streaming**: Operations during active streaming
- **Rapid Switching**: Test race conditions
- **Validation**: Empty content, invalid operations

## 🎮 Using the Test UI

### Running Tests

1. **Individual Tests**: Click "Run" on any scenario
2. **Category Tests**: Filter by category and run all
3. **All Tests**: Click "Run All" to execute everything
4. **Auto-run**: Enable to automatically proceed to next test

### Monitoring Execution

- **Progress Bar**: Shows current step progress
- **Step List**: See all steps with status (pending/current/completed)
- **Live State**: Monitor state changes in real-time
- **Results**: View pass/fail status with detailed errors

### Understanding Results

- ✅ **Green**: Test passed all validations
- ❌ **Red**: Test failed with errors (expand for details)
- **Duration**: Time taken for each step and scenario
- **State Snapshots**: Inspect state at each step

## 🔧 Adding New Test Scenarios

### 1. Define Your Scenario

Edit `scenarios.ts` and add your test:

```typescript
{
  id: 'my-new-test',
  name: 'My New Test',
  description: 'Tests a specific behavior',
  category: 'edit', // or 'retry', 'delete', 'switcher', 'complex', 'edge-case'
  priority: 'high', // or 'medium', 'low'
  tags: ['tag1', 'tag2'],
  initialState: {
    chatId: 'chat_test',
    messages: [
      createMessage('chat_test_1', 'user', 'Test message'),
      createMessage('chat_test_2', 'assistant', 'Test response')
    ]
  },
  steps: [
    {
      id: 'step1',
      action: 'edit',
      target: { messageId: 'chat_test_1' },
      payload: { newContent: 'Edited message' },
      description: 'Edit the user message'
    }
  ],
  expectedOutcomes: [
    {
      stepId: 'step1',
      type: 'state',
      condition: {
        field: 'messages[0].content',
        operator: 'equals',
        value: 'Edited message'
      },
      description: 'Message content was updated'
    }
  ]
}
```

### 2. Available Actions

- `edit` - Edit a message
- `retry` - Retry an assistant message
- `delete` - Delete a message
- `switch-version` - Switch to a different version
- `hover-message` - Simulate hover over message
- `click-switcher` - Open version dropdown
- `select-version` - Select a specific version
- `send-message` - Send a new message
- `wait` - Wait for specified duration
- `verify-state` - Verify current state

### 3. Validation Conditions

```typescript
condition: {
  field: 'path.to.field',
  operator: 'equals' | 'contains' | 'exists' | 'not-exists' | 'greater-than' | 'less-than',
  value: expectedValue
}
```

### 4. State Fields You Can Test

- `messages` - Array of messages
- `versions` - Version map for messages
- `currentChatId` - Active chat ID
- `isStreaming` - Streaming state
- `sendButtonDisabled` - Send button state
- `visibleSwitchers` - Which switchers are visible
- `activeDropdown` - Which dropdown is open
- `operationInProgress` - Current operation

## 🔍 Debugging Tests

### Enable Detailed Logging

The test runner logs all operations. Check the browser console for:
- Step execution details
- State changes
- API mock responses
- Validation results

### Inspect State

1. Click "Show Details" in the State View
2. See full JSON of current state
3. Compare with expected state
4. Track state history through execution

### Common Issues

**Test fails immediately**
- Check initial state setup
- Verify message IDs match

**Validation errors**
- Check field paths are correct
- Ensure expected values match types
- Use proper operators for comparisons

**Timing issues**
- Add `wait` steps if needed
- Increase delays for async operations
- Check streaming simulation delays

## 🏗️ Architecture

### Mock Environment (`mockEnvironment.ts`)
- Intercepts fetch calls
- Simulates backend responses
- Manages state transitions
- Provides consistent test environment

### Test Runner (`testRunner.ts`)
- Executes test steps sequentially
- Validates state after each step
- Tracks results and timing
- Handles pause/resume/stop

### Test UI (`TestUI.tsx`)
- Visual interface for test execution
- Real-time monitoring
- Result visualization
- State inspection tools

## 📊 Test Coverage

Current test coverage includes:
- ✅ Basic CRUD operations on messages
- ✅ Version creation and switching
- ✅ UI interaction patterns
- ✅ Edge cases and error handling
- ✅ Complex branching scenarios
- ✅ Concurrent operation handling

## 🎯 Best Practices

1. **Start Simple**: Test basic operations first
2. **Build Complexity**: Layer complex scenarios on proven basics
3. **Test Edge Cases**: Always include error scenarios
4. **Validate Thoroughly**: Check all affected state
5. **Document Well**: Clear descriptions help debugging

## 💡 Tips

- Use high-priority tests for critical paths
- Group related tests with tags
- Keep scenarios focused on single behaviors
- Use descriptive IDs and names
- Add delays only when necessary
- Validate both positive and negative cases

## 🐛 Troubleshooting

**Tests won't run**
- Ensure mock environment is initialized
- Check browser console for errors
- Verify test framework is loaded

**State doesn't match**
- Mock environment may need updates
- Check if actual behavior changed
- Verify expected outcomes are correct

**UI doesn't update**
- React state may be stale
- Force re-render with Reset
- Check event handlers

## 📈 Extending the Framework

To add new features:

1. **New Action Types**: Add to `TestAction` type and implement in `testRunner.ts`
2. **New Validations**: Add to `ValidationCondition` operators
3. **New State Fields**: Extend `StateSnapshot` interface
4. **New Categories**: Add to category list in UI

## 🔗 Related Documentation

- See `temporary_removal_guide.md` for removal instructions
- Check main app versioning hooks in `/frontend/src/hooks/useVersioning.ts`
- Review message switcher component in `/frontend/src/components/MessageVersionSwitcher.tsx`