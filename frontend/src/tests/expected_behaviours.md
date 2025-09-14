# Expected System Behaviors from User Perspective

This document describes how the versioning system should behave from the user's point of view in various scenarios.

## Basic Edit Operations

- In retry, delete, edit operations, ALWAYS the active chat/version is taken as the parent/reference and the new generated
is the child!
- The message version switcher's total states together in that chat (e.g. one message is 3/7 another is 2/4, ...) should 
correspond directly to a existing version and be coherent with it.
- Since we have multiprocessing in place, we do not need to cancel with any new operation. We can just let it complete processing
in the background. NONE OF THE OPERATIONS SHOULD CANCEL ACTIVE STREAMING! ON THE OPPOSITE, THE USER SHOULD BE ABLE TO TRIGGER AN 
OPERATION DURING STREAMING, THEN EVEN COME BACK AND REJOIN THE STREAM WHERE IT LEFT OFF!

### Editing a User Message
**What the user does:** Clicks edit on a user message and changes the content

**What should happen:**
1. The user message content is immediately updated in the UI
2. All messages after the edited message are removed (because the context changed)
3. The system automatically generates a new assistant response based on the edited message
4. A version indicator appears on the message showing it has been edited with 2/2
5. The send button remains disabled throughout the whole process for that chat (from edit acceptance till stream finalization in chat)
6. The operation completes fully before allowing new interactions
7. Both the user message AND corresponding assistant message get version indicators

### Editing an Assistant Message
**What the user does:** Clicks edit on an assistant message and changes the content

**What should happen:**
1. The assistant message content is immediately updated in the UI
2. Messages after the edited assistant message remain unchanged
3. No new streaming occurs (it's just a content change)
4. A version indicator appears showing the message has been edited with 2/2 ONLY under the assistant message
5. The send button remains enabled throughout

## Retry Operations

### Retrying an Assistant Message
**What the user does:** Clicks retry on an assistant message

**What should happen:**
1. The system treats this as "regenerate from the previous user message"
2. All messages after retried message needs to be fully removed
3. A new assistant response starts streaming immediately
4. The old assistant message content is preserved in version history
5. Both the user message AND assistant message get version indicators with 2/2
6. The user can switch between different retry versions using the dropdown
7. The send button remains disabled throughout the whole process for that chat (from edit acceptance till stream finalization in chat)

### Multiple Retries
**What the user does:** Clicks retry multiple times on the same assistant message

**What should happen:**
1. Each retry creates a new version of the response
2. All versions are accessible through the version dropdown with i/i
3. The user message (parent) also tracks these versions and each version have the previous version as their parent they were generated from
4. The version number increments with each retry

## Delete Operations

### Deleting a Message
**What the user does:** Clicks delete on any message

**What should happen:**
1. The message and all messages after it are removed from view
2. The deletion creates a version checkpoint (can be restored)
3. The chat returns to a state ready for new input
4. The send button becomes enabled after deletion completes

## Version Switching

### Using the Version Switcher
**What the user does:** Hovers over a versioned message and clicks the version indicator

**What should happen:**
1. A dropdown appears showing all available versions
2. Each version shows: version number, operation type (edit/retry), and preview
3. Clicking a version switches the entire chat to that version's context
4. The switch is immediate for already-generated content
5. The current version is highlighted in the dropdown

### Switching Between Branches
**What the user does:** Switches from one version to another

**What should happen:**
1. The entire conversation updates to reflect the selected version
2. Messages that only exist in that version appear
3. Messages that don't exist in that version disappear
4. The chat ID updates to the version's chat ID
5. Further messages continue from that version's context

## Edge Cases and Validation

### Empty Edit Attempt
**What the user does:** Tries to save an edit with empty or whitespace-only content

**What should happen:**
1. The edit is rejected with validation
2. The original message content remains unchanged
3. No version is created
4. An error message or disabled save button prevents the action
5. The edit modal/interface remains open for correction

### Rapid Operations
**What the user does:** Quickly performs multiple operations (edit, retry, delete)

**What should happen:**
1. Operations queue properly without conflicts
2. Each operation completes before the next begins
3. No race conditions or state corruption occurs
4. The UI remains responsive
5. Loading indicators show for each operation

### Network Failures
**What the user does:** Performs an operation when network is unstable

**What should happen:**
1. Failed operations show clear error messages
2. The UI rolls back optimistic updates if operation fails
3. Retry mechanisms are available
4. No partial state corruption
5. The user can safely retry the operation

## State Management

### Operation Progress Indicators
**What the user sees during operations:**
1. Clear visual feedback that an operation is in progress
2. Disabled interactions on elements being modified
3. Loading spinners or progress indicators
4. The operation type is clear (editing, retrying, deleting)
5. Completion is clearly indicated

### Send Button State
**When the send button should be disabled and reenabled:**
The send button remains disabled throughout the whole process for that chat (from operation acceptance till stream finalization in chat (if streaming exists for that operation, 
if not, just till the end of the operation process and rerender))

## Version History Persistence

### What gets versioned:**
1. Every edit creates a new version
2. Every retry creates a new version
3. Every delete creates a new version

### Version metadata includes:**
1. Version number (incrementing)
2. Operation type (original, edit, retry, delete)
3. Timestamp of creation
4. Content at that version
5. The chat context ID for that version
