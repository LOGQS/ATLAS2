/**
 * Test scenarios for versioning and message switcher functionality
 */

import { TestScenario, MockMessage } from './types';

const createMessage = (id: string, role: 'user' | 'assistant', content: string): MockMessage => ({
  id,
  role,
  content,
  created_at: new Date().toISOString()
});

export const testScenarios: TestScenario[] = [
  // ========== BASIC EDIT SCENARIOS ==========
  {
    id: 'basic-edit-user',
    name: 'Basic User Message Edit',
    description: 'Edit a user message and verify version creation',
    category: 'edit',
    priority: 'high',
    tags: ['edit', 'user', 'version-creation'],
    initialState: {
      chatId: 'chat_001',
      messages: [
        createMessage('chat_001_1', 'user', 'What is 2+2?'),
        createMessage('chat_001_2', 'assistant', 'The answer is 4.')
      ]
    },
    steps: [
      {
        id: 'step1',
        action: 'hover-message',
        target: { messageId: 'chat_001_1' },
        description: 'Hover over user message to show controls'
      },
      {
        id: 'step2',
        action: 'edit',
        target: { messageId: 'chat_001_1' },
        payload: { newContent: 'What is 3+3?' },
        description: 'Edit user message content'
      },
      {
        id: 'wait-after-edit',
        action: 'wait',
        target: {},
        delay: 150,
        description: 'Wait for possible regeneration stream to complete'
      },
      {
        id: 'step3',
        action: 'verify-state',
        target: {},
        description: 'Verify version was created',
        expectedState: {
          operationInProgress: null,
          sendButtonDisabled: false
        }
      }
    ],
    expectedOutcomes: [
      {
        stepId: 'step3',
        type: 'state',
        condition: {
          field: 'versions.chat_001_1',
          operator: 'exists'
        },
        description: 'Version entry created for message'
      }
    ]
  },

  // ========== USER RETRY: SWITCHERS AND STREAM ==========
  {
    id: 'user-retry-switchers',
    name: 'User Retry Shows Both Switchers',
    description: 'Retry a user message; both the user and regenerated assistant show switchers and streaming occurs',
    category: 'retry',
    priority: 'high',
    tags: ['retry', 'user', 'switcher', 'streaming'],
    initialState: {
      chatId: 'chat_030',
      messages: [
        createMessage('chat_030_1', 'user', 'Please define entropy'),
        createMessage('chat_030_2', 'assistant', 'Entropy is ...')
      ]
    },
    steps: [
      { id: 'retry-user', action: 'retry', target: { messageId: 'chat_030_1' }, description: 'Retry the user message' },
      { id: 'wait-stream', action: 'wait', target: {}, delay: 150, description: 'Wait for regeneration stream to complete' },
      { id: 'hover-user', action: 'hover-message', target: { messageId: 'chat_030_1' }, description: 'Hover user message' },
      { id: 'hover-assistant', action: 'hover-message', target: { messageId: 'chat_030_v2_2' }, description: 'Hover regenerated assistant message' }
    ],
    expectedOutcomes: [
      { stepId: 'wait-stream', type: 'state', description: 'Streaming finished', condition: { field: 'isStreaming', operator: 'equals', value: false } },
      { stepId: 'hover-user', type: 'ui', description: 'User switcher visible', condition: { field: 'visibleSwitchers', operator: 'contains', value: 'chat_030_1' } },
      { stepId: 'hover-assistant', type: 'ui', description: 'Assistant switcher visible via fallback', condition: { field: 'visibleSwitchers', operator: 'contains', value: 'chat_030_v2_2' } }
    ]
  },

  // ========== MID-STREAM SECOND OPERATION DOES NOT CANCEL ==========
  {
    id: 'mid-stream-second-operation',
    name: 'Second Operation During Streaming Does Not Cancel',
    description: 'Start an assistant retry (streaming), then trigger an assistant edit; streaming should continue; edit should apply after',
    category: 'edge-case',
    priority: 'medium',
    tags: ['streaming', 'retry', 'edit', 'concurrency'],
    initialState: {
      chatId: 'chat_031',
      messages: [
        createMessage('chat_031_1', 'user', 'Compose a haiku'),
        createMessage('chat_031_2', 'assistant', 'Drafting...')
      ]
    },
    steps: [
      { id: 'retry-assistant', action: 'retry', target: { messageId: 'chat_031_2' }, description: 'Trigger assistant retry (starts stream)' },
      { id: 'quick-edit-assistant', action: 'edit', target: { messageId: 'chat_031_2' }, payload: { newContent: 'Edited interim response' }, description: 'Edit assistant during stream' },
      { id: 'switch-back-to-stream', action: 'switch-version', target: { chatId: 'chat_031_v2' }, description: 'Return to streaming chat' },
      { id: 'verify-still-streaming', action: 'verify-state', target: {}, description: 'Streaming still active in streaming chat', expectedState: { isStreaming: true, sendButtonDisabled: true } },
      { id: 'wait-finish', action: 'wait', target: {}, delay: 160, description: 'Finish streaming' },
      { id: 'verify-finished', action: 'verify-state', target: {}, description: 'Streaming finished', expectedState: { isStreaming: false, sendButtonDisabled: false } }
    ],
    expectedOutcomes: []
  },

  // ========== SWITCHER VISIBILITY RULES AFTER MULTIPLE OPERATIONS ==========
  {
    id: 'switcher-visibility-matrix',
    name: 'Switcher Visibility Across Operations',
    description: 'Verify which messages show switchers after edit (user), edit (assistant), and retries',
    category: 'switcher',
    priority: 'medium',
    tags: ['switcher', 'rules', 'composite'],
    initialState: {
      chatId: 'chat_032',
      messages: [
        createMessage('chat_032_1', 'user', 'Alpha'),
        createMessage('chat_032_2', 'assistant', 'Beta')
      ]
    },
    steps: [
      { id: 'edit-user', action: 'edit', target: { messageId: 'chat_032_1' }, payload: { newContent: 'Alpha*' }, description: 'User edit -> stream' },
      { id: 'wait1', action: 'wait', target: {}, delay: 150, description: 'Wait stream' },
      { id: 'hover-user-after-edit', action: 'hover-message', target: { messageId: 'chat_032_1' }, description: 'Hover user' },
      { id: 'hover-assistant-after-edit', action: 'hover-message', target: { messageId: 'chat_032_v2_2' }, description: 'Hover assistant' },
      { id: 'edit-assistant', action: 'edit', target: { messageId: 'chat_032_v2_2' }, payload: { newContent: 'Beta*' }, description: 'Assistant edit only' },
      { id: 'hover-user-after-assist-edit', action: 'hover-message', target: { messageId: 'chat_032_1' }, description: 'Hover user again' },
      { id: 'hover-assistant-after-assist-edit', action: 'hover-message', target: { messageId: 'chat_032_v2_2' }, description: 'Hover assistant again' },
      { id: 'retry-assistant', action: 'retry', target: { messageId: 'chat_032_v2_2' }, description: 'Assistant retry' },
      { id: 'wait2', action: 'wait', target: {}, delay: 150, description: 'Wait stream' },
      { id: 'hover-user-after-retry', action: 'hover-message', target: { messageId: 'chat_032_1' }, description: 'Hover user post-retry' },
      { id: 'hover-assistant-after-retry', action: 'hover-message', target: { messageId: 'chat_032_v3_2' }, description: 'Hover latest assistant' }
    ],
    expectedOutcomes: [
      { stepId: 'hover-user-after-edit', type: 'ui', description: 'User switcher visible after user edit', condition: { field: 'visibleSwitchers', operator: 'contains', value: 'chat_032_1' } },
      { stepId: 'hover-assistant-after-edit', type: 'ui', description: 'Assistant switcher visible via fallback after user edit', condition: { field: 'visibleSwitchers', operator: 'contains', value: 'chat_032_v2_2' } },
      { stepId: 'hover-user-after-assist-edit', type: 'ui', description: 'User switcher still visible (unchanged)', condition: { field: 'visibleSwitchers', operator: 'contains', value: 'chat_032_1' } },
      { stepId: 'hover-assistant-after-assist-edit', type: 'ui', description: 'Assistant switcher visible (assistant has its own versions)', condition: { field: 'visibleSwitchers', operator: 'contains', value: 'chat_032_v2_2' } },
      { stepId: 'hover-user-after-retry', type: 'ui', description: 'User switcher visible after assistant retry (parent has retries)', condition: { field: 'visibleSwitchers', operator: 'contains', value: 'chat_032_1' } },
      { stepId: 'hover-assistant-after-retry', type: 'ui', description: 'Latest assistant shows switcher', condition: { field: 'visibleSwitchers', operator: 'contains', value: 'chat_032_v3_2' } }
    ]
  },

  // ========== CONTINUE CHAT AFTER VERSION SWITCH ==========
  {
    id: 'continue-after-switch',
    name: 'Continue Chat After Manual Version Switch',
    description: 'Switch to an older version via dropdown and continue the chat in that context',
    category: 'switcher',
    priority: 'medium',
    tags: ['switcher', 'dropdown', 'continuation'],
    initialState: {
      chatId: 'chat_033',
      messages: [
        createMessage('chat_033_1', 'user', 'Topic X'),
        createMessage('chat_033_2', 'assistant', 'About X')
      ],
      versions: {
        'chat_033_1': [
          { version_number: 1, chat_version_id: 'chat_033', operation: 'original', created_at: new Date().toISOString(), content: 'Topic X' },
          { version_number: 2, chat_version_id: 'chat_033_v2', operation: 'edit', created_at: new Date().toISOString(), content: 'Topic X (edited)' },
          { version_number: 3, chat_version_id: 'chat_033_v3', operation: 'retry', created_at: new Date().toISOString(), content: 'Topic X (edited)' }
        ]
      }
    },
    steps: [
      { id: 'hover-user', action: 'hover-message', target: { messageId: 'chat_033_1' }, description: 'Hover to show switcher' },
      { id: 'open-dropdown', action: 'click-switcher', target: { messageId: 'chat_033_1' }, description: 'Open dropdown' },
      { id: 'select-v2', action: 'select-version', target: { messageId: 'chat_033_1', versionNumber: 2 }, description: 'Switch to v2' },
      { id: 'send-followup', action: 'send-message', target: {}, payload: { content: 'Follow-up in v2' }, description: 'Continue in v2' },
      { id: 'verify-context', action: 'verify-state', target: {}, description: 'Context is v2', expectedState: { currentChatId: 'chat_033_v2' } }
    ],
    expectedOutcomes: [
      { stepId: 'select-v2', type: 'state', description: 'Switched to v2 chat', condition: { field: 'currentChatId', operator: 'equals', value: 'chat_033_v2' } }
    ]
  },

  // ========== EDGE: DELETE DURING STREAMING (LEGACY NAME) ==========
  {
    id: 'edge-streaming-delete',
    name: 'Delete During Streaming',
    description: 'Attempt to delete a message while streaming is active; streaming should not cancel (background stream continues in previous chat)',
    category: 'edge-case',
    priority: 'high',
    tags: ['delete', 'streaming', 'edge-case'],
    initialState: {
      chatId: 'chat_005',
      messages: [
        createMessage('chat_005_1', 'user', 'Question'),
        { ...createMessage('chat_005_2', 'assistant', 'Streaming...'), isStreaming: true }
      ],
      isStreaming: true
    },
    steps: [
      {
        id: 'delete-streaming',
        action: 'delete',
        target: { messageId: 'chat_005_2' },
        description: 'Try to delete streaming message'
      },
      {
        id: 'verify-active-no-stream',
        action: 'verify-state',
        target: {},
        description: 'Active chat shows no stream',
        expectedState: { isStreaming: false }
      },
      {
        id: 'switch-back-to-original',
        action: 'switch-version',
        target: { chatId: 'chat_005' },
        description: 'Return to original streaming chat'
      },
      {
        id: 'verify-original-streaming',
        action: 'verify-state',
        target: {},
        description: 'Original chat still shows streaming (background)',
        expectedState: { isStreaming: true }
      }
    ],
    expectedOutcomes: []
  },

  // ========== CONTINUE CHAT AFTER VERSION CREATION ==========
  {
    id: 'continue-after-version-edit',
    name: 'Continue Chat After Edit Version',
    description: 'After editing a user message, auto-switches and streaming finishes, then user continues chatting',
    category: 'edit',
    priority: 'high',
    tags: ['edit', 'streaming', 'continuation'],
    initialState: {
      chatId: 'chat_010',
      messages: [
        createMessage('chat_010_1', 'user', 'Explain gravity'),
        createMessage('chat_010_2', 'assistant', 'Gravity is a force...')
      ]
    },
    steps: [
      {
        id: 'edit-user',
        action: 'edit',
        target: { messageId: 'chat_010_1' },
        payload: { newContent: 'Explain quantum gravity' },
        description: 'Edit first user message to create version and stream'
      },
      {
        id: 'wait-stream',
        action: 'wait',
        target: {},
        delay: 150,
        description: 'Wait for streaming to complete'
      },
      {
        id: 'verify-post-stream',
        action: 'verify-state',
        target: {},
        description: 'Verify switched to version chat and streaming ended',
        expectedState: {
          currentChatId: 'chat_010_v2',
          isStreaming: false,
          sendButtonDisabled: false
        }
      },
      {
        id: 'send-followup',
        action: 'send-message',
        target: {},
        payload: { content: 'Thanks! And how about entanglement?' },
        description: 'Continue chatting in the new version chat'
      },
      {
        id: 'verify-continued',
        action: 'verify-state',
        target: {},
        description: 'Verify message appended in version chat',
        expectedState: {
          currentChatId: 'chat_010_v2'
        }
      }
    ],
    expectedOutcomes: [
      {
        stepId: 'verify-post-stream',
        type: 'state',
        condition: {
          field: 'currentChatId',
          operator: 'equals',
          value: 'chat_010_v2'
        },
        description: 'Switched to new version chat id'
      }
    ]
  },

  // ========== ASSISTANT EDIT (NO STREAM) ==========
  {
    id: 'assistant-edit-no-stream',
    name: 'Assistant Edit Without Streaming',
    description: 'Editing assistant message should not start streaming and must create a version',
    category: 'edit',
    priority: 'medium',
    tags: ['assistant', 'edit', 'no-stream'],
    initialState: {
      chatId: 'chat_011',
      messages: [
        createMessage('chat_011_1', 'user', 'Summarize the plot.'),
        createMessage('chat_011_2', 'assistant', 'It is about...')
      ]
    },
    steps: [
      {
        id: 'edit-assistant',
        action: 'edit',
        target: { messageId: 'chat_011_2' },
        payload: { newContent: 'Updated summary content' },
        description: 'Edit assistant response content'
      },
      {
        id: 'verify-no-stream',
        action: 'verify-state',
        target: {},
        description: 'Verify no streaming occurred and version exists',
        expectedState: {
          isStreaming: false,
          sendButtonDisabled: false
        }
      }
    ],
    expectedOutcomes: [
      {
        stepId: 'verify-no-stream',
        type: 'state',
        condition: {
          field: 'versions.chat_011_2.length',
          operator: 'greater-than',
          value: 1
        },
        description: 'Assistant message has a new version'
      }
    ]
  },

  // ========== MID-STREAM DELETE CONTINUES STREAM ==========
  {
    id: 'mid-stream-delete-continues',
    name: 'Delete During Streaming Does Not Cancel',
    description: 'Perform delete while streaming continues in background (multiprocess safe). Verify stream completes successfully (not cancelled).',
    category: 'delete',
    priority: 'high',
    tags: ['delete', 'streaming', 'no-cancel'],
    initialState: {
      chatId: 'chat_012',
      messages: [
        createMessage('chat_012_1', 'user', 'Tell me a story'),
        createMessage('chat_012_2', 'assistant', 'Once upon a time...')
      ]
    },
    steps: [
      {
        id: 'retry-assistant',
        action: 'retry',
        target: { messageId: 'chat_012_2' },
        description: 'Trigger retry causing streaming in version chat'
      },
      {
        id: 'quick-delete',
        action: 'delete',
        target: { messageId: 'chat_012_1' },
        description: 'Delete earlier user message during streaming'
      },
      {
        id: 'verify-streaming-not-cancelled',
        action: 'verify-state',
        target: {},
        description: 'Verify streaming was not cancelled (completed successfully)',
        expectedState: { isStreaming: false }
      }
    ],
    expectedOutcomes: []
  },

  // ========== BRANCHING AND CONTINUE PER BRANCH ==========
  {
    id: 'branching-continue-after-switch',
    name: 'Branching and Continue Chat Per Branch',
    description: 'Create two edit branches, switch between them, and continue chatting in each',
    category: 'complex',
    priority: 'medium',
    tags: ['branching', 'edit', 'navigation', 'continuation'],
    initialState: {
      chatId: 'chat_013',
      messages: [
        createMessage('chat_013_1', 'user', 'Original prompt'),
        createMessage('chat_013_2', 'assistant', 'Original answer')
      ]
    },
    steps: [
      {
        id: 'edit-branch-a',
        action: 'edit',
        target: { messageId: 'chat_013_1' },
        payload: { newContent: 'Branch A prompt' },
        description: 'Create Branch A (v2)'
      },
      {
        id: 'switch-original',
        action: 'switch-version',
        target: { chatId: 'chat_013' },
        description: 'Switch back to original to start Branch B'
      },
      {
        id: 'edit-branch-b',
        action: 'edit',
        target: { messageId: 'chat_013_1' },
        payload: { newContent: 'Branch B prompt' },
        description: 'Create Branch B (v3)'
      },
      {
        id: 'switch-branch-a',
        action: 'switch-version',
        target: { chatId: 'chat_013_v2' },
        description: 'Switch to Branch A'
      },
      {
        id: 'continue-a',
        action: 'send-message',
        target: {},
        payload: { content: 'Continue in A' },
        description: 'Continue chatting in Branch A'
      },
      {
        id: 'verify-a',
        action: 'verify-state',
        target: {},
        description: 'Verify we are in Branch A',
        expectedState: {
          currentChatId: 'chat_013_v2'
        }
      },
      {
        id: 'switch-branch-b',
        action: 'switch-version',
        target: { chatId: 'chat_013_v3' },
        description: 'Switch to Branch B'
      },
      {
        id: 'continue-b',
        action: 'send-message',
        target: {},
        payload: { content: 'Continue in B' },
        description: 'Continue chatting in Branch B'
      },
      {
        id: 'verify-b',
        action: 'verify-state',
        target: {},
        description: 'Verify we are in Branch B',
        expectedState: {
          currentChatId: 'chat_013_v3'
        }
      }
    ],
    expectedOutcomes: []
  },

  // ========== SWITCHER EXPECTATIONS AFTER ASSISTANT RETRIES ==========
  {
    id: 'switchers-after-retries',
    name: 'Switcher Visibility and Versions After Assistant Retries',
    description: 'After multiple assistant retries, verify versions exist for both assistant and its parent user message, and switching works',
    category: 'switcher',
    priority: 'medium',
    tags: ['retry', 'switcher', 'ui'],
    initialState: {
      chatId: 'chat_014',
      messages: [
        createMessage('chat_014_1', 'user', 'Ask me something'),
        createMessage('chat_014_2', 'assistant', 'Here is an answer')
      ]
    },
    steps: [
      { id: 'r1', action: 'retry', target: { messageId: 'chat_014_2' }, description: 'First retry' },
      { id: 'r2', action: 'retry', target: { messageId: 'chat_014_2' }, description: 'Second retry' },
      { id: 'hover-assistant', action: 'hover-message', target: { messageId: 'chat_014_2' }, description: 'Hover assistant message' },
      { id: 'hover-user', action: 'hover-message', target: { messageId: 'chat_014_1' }, description: 'Hover user message' },
      { id: 'open-dropdown', action: 'click-switcher', target: { messageId: 'chat_014_2' }, description: 'Open switcher on assistant' },
      { id: 'select-original', action: 'select-version', target: { messageId: 'chat_014_2', versionNumber: 1 }, description: 'Select original version' }
    ],
    expectedOutcomes: [
      {
        stepId: 'r2',
        type: 'state',
        condition: { field: 'versions.chat_014_2', operator: 'exists' },
        description: 'Assistant has versions after retries'
      },
      {
        stepId: 'r2',
        type: 'state',
        condition: { field: 'versions.chat_014_1', operator: 'exists' },
        description: 'Parent user message has versions after retries'
      },
      {
        stepId: 'select-original',
        type: 'state',
        condition: { field: 'currentChatId', operator: 'equals', value: 'chat_014' },
        description: 'Switched back to original chat'
      }
    ]
  },

  // ========== RETRY SCENARIOS ==========
  {
    id: 'retry-assistant-multiple',
    name: 'Multiple Assistant Retries',
    description: 'Retry assistant message multiple times and switch between versions',
    category: 'retry',
    priority: 'high',
    tags: ['retry', 'assistant', 'version-switching'],
    initialState: {
      chatId: 'chat_002',
      messages: [
        createMessage('chat_002_1', 'user', 'Tell me a joke'),
        createMessage('chat_002_2', 'assistant', 'Why did the chicken cross the road?')
      ]
    },
    steps: [
      {
        id: 'retry1',
        action: 'retry',
        target: { messageId: 'chat_002_2' },
        description: 'First retry of assistant message'
      },
      {
        id: 'wait1',
        action: 'wait',
        target: {},
        delay: 100,
        description: 'Wait for version creation'
      },
      {
        id: 'retry2',
        action: 'retry',
        target: { messageId: 'chat_002_2' },
        description: 'Second retry of assistant message'
      },
      {
        id: 'hover1',
        action: 'hover-message',
        target: { messageId: 'chat_002_2' },
        description: 'Hover to show version switcher'
      },
      {
        id: 'click-switcher',
        action: 'click-switcher',
        target: { messageId: 'chat_002_2' },
        description: 'Open version dropdown'
      },
      {
        id: 'switch-version',
        action: 'select-version',
        target: { messageId: 'chat_002_2', versionNumber: 1 },
        description: 'Switch back to original version'
      }
    ],
    expectedOutcomes: [
      {
        stepId: 'retry2',
        type: 'state',
        condition: {
          field: 'versions.chat_002_1',
          operator: 'exists'
        },
        description: 'Versions created for user message (retry parent)'
      },
      {
        stepId: 'click-switcher',
        type: 'ui',
        condition: {
          field: 'activeDropdown',
          operator: 'equals',
          value: 'chat_002_2'
        },
        description: 'Version dropdown is open'
      }
    ]
  },

  // ========== DELETE SCENARIOS ==========
  {
    id: 'delete-message-chain',
    name: 'Delete Message with Chain',
    description: 'Delete a message and verify subsequent messages are removed',
    category: 'delete',
    priority: 'high',
    tags: ['delete', 'chain-removal'],
    initialState: {
      chatId: 'chat_003',
      messages: [
        createMessage('chat_003_1', 'user', 'First question'),
        createMessage('chat_003_2', 'assistant', 'First answer'),
        createMessage('chat_003_3', 'user', 'Second question'),
        createMessage('chat_003_4', 'assistant', 'Second answer')
      ]
    },
    steps: [
      {
        id: 'delete1',
        action: 'delete',
        target: { messageId: 'chat_003_2' },
        description: 'Delete first assistant message'
      },
      {
        id: 'verify-delete',
        action: 'verify-state',
        target: {},
        description: 'Verify messages after deleted one are removed'
      }
    ],
    expectedOutcomes: [
      {
        stepId: 'verify-delete',
        type: 'state',
        condition: {
          field: 'messages.length',
          operator: 'equals',
          value: 1
        },
        description: 'Only first message remains'
      },
      {
        stepId: 'verify-delete',
        type: 'state',
        condition: {
          field: 'messages[0].id',
          operator: 'equals',
          value: 'chat_003_1'
        },
        description: 'First remaining message has expected id'
      }
    ]
  },

  // ========== COMPLEX BRANCHING SCENARIOS ==========
  {
    id: 'complex-branching',
    name: 'Complex Version Branching',
    description: 'Create multiple edit branches and navigate between them',
    category: 'complex',
    priority: 'medium',
    tags: ['edit', 'branching', 'navigation'],
    initialState: {
      chatId: 'chat_004',
      messages: [
        createMessage('chat_004_1', 'user', 'Original question'),
        createMessage('chat_004_2', 'assistant', 'Original answer')
      ]
    },
    steps: [
      {
        id: 'edit1',
        action: 'edit',
        target: { messageId: 'chat_004_1' },
        payload: { newContent: 'Branch 1 question' },
        description: 'Create first branch'
      },
      {
        id: 'switch-original',
        action: 'switch-version',
        target: { chatId: 'chat_004' },
        description: 'Switch back to original'
      },
      {
        id: 'edit2',
        action: 'edit',
        target: { messageId: 'chat_004_1' },
        payload: { newContent: 'Branch 2 question' },
        description: 'Create second branch'
      },
      {
        id: 'verify-branches',
        action: 'verify-state',
        target: {},
        description: 'Verify multiple branches exist'
      }
    ],
    expectedOutcomes: [
      {
        stepId: 'verify-branches',
        type: 'state',
        condition: {
          field: 'versions.chat_004_1.length',
          operator: 'greater-than',
          value: 2
        },
        description: 'Multiple versions exist'
      }
    ]
  },

  // ========== EDGE CASES ==========

  {
    id: 'edge-rapid-switching',
    name: 'Rapid Version Switching',
    description: 'Switch between versions rapidly to test race conditions',
    category: 'edge-case',
    priority: 'medium',
    tags: ['switcher', 'race-condition', 'edge-case'],
    initialState: {
      chatId: 'chat_006',
      messages: [
        createMessage('chat_006_1', 'user', 'Question'),
        createMessage('chat_006_2', 'assistant', 'Answer')
      ],
      versions: {
        'chat_006_1': [
          {
            version_number: 1,
            chat_version_id: 'chat_006',
            operation: 'original',
            created_at: new Date().toISOString()
          },
          {
            version_number: 2,
            chat_version_id: 'chat_006_v2',
            operation: 'edit',
            created_at: new Date().toISOString()
          },
          {
            version_number: 3,
            chat_version_id: 'chat_006_v3',
            operation: 'edit',
            created_at: new Date().toISOString()
          }
        ]
      }
    },
    steps: [
      {
        id: 'rapid1',
        action: 'switch-version',
        target: { chatId: 'chat_006_v2' },
        delay: 0,
        description: 'Switch to version 2'
      },
      {
        id: 'rapid2',
        action: 'switch-version',
        target: { chatId: 'chat_006_v3' },
        delay: 10,
        description: 'Quickly switch to version 3'
      },
      {
        id: 'rapid3',
        action: 'switch-version',
        target: { chatId: 'chat_006' },
        delay: 10,
        description: 'Quickly switch back to original'
      },
      {
        id: 'verify-stable',
        action: 'verify-state',
        target: {},
        delay: 100,
        description: 'Verify system is stable'
      }
    ],
    expectedOutcomes: [
      {
        stepId: 'verify-stable',
        type: 'state',
        condition: {
          field: 'currentChatId',
          operator: 'equals',
          value: 'chat_006'
        },
        description: 'Ended on correct version'
      }
    ]
  },

  {
    id: 'edge-empty-edit',
    name: 'Edit with Empty Content',
    description: 'Test editing a message with empty content',
    category: 'edge-case',
    priority: 'low',
    tags: ['edit', 'validation', 'edge-case'],
    initialState: {
      chatId: 'chat_007',
      messages: [
        createMessage('chat_007_1', 'user', 'Original message'),
        createMessage('chat_007_2', 'assistant', 'Response')
      ]
    },
    steps: [
      {
        id: 'empty-edit',
        action: 'edit',
        target: { messageId: 'chat_007_1' },
        payload: { newContent: '' },
        description: 'Edit with empty content'
      },
      {
        id: 'verify-validation',
        action: 'verify-state',
        target: {},
        description: 'Verify validation handled'
      }
    ],
    expectedOutcomes: [
      {
        stepId: 'verify-validation',
        type: 'state',
        condition: {
          field: 'messages[0].content',
          operator: 'equals',
          value: 'Original message'
        },
        description: 'Empty edit was rejected and original content preserved'
      }
    ]
  },

  // ========== SWITCHER UI SCENARIOS ==========
  {
    id: 'switcher-ui-hover',
    name: 'Message Switcher Hover Behavior',
    description: 'Test version switcher visibility on hover',
    category: 'switcher',
    priority: 'medium',
    tags: ['switcher', 'ui', 'hover'],
    initialState: {
      chatId: 'chat_008',
      messages: [
        createMessage('chat_008_1', 'user', 'Question'),
        createMessage('chat_008_2', 'assistant', 'Answer')
      ],
      versions: {
        'chat_008_1': [
          {
            version_number: 1,
            chat_version_id: 'chat_008',
            operation: 'original',
            created_at: new Date().toISOString()
          },
          {
            version_number: 2,
            chat_version_id: 'chat_008_v2',
            operation: 'retry',
            created_at: new Date().toISOString()
          }
        ]
      }
    },
    steps: [
      {
        id: 'hover-on',
        action: 'hover-message',
        target: { messageId: 'chat_008_1' },
        description: 'Hover over message with versions'
      },
      {
        id: 'verify-visible',
        action: 'verify-state',
        target: {},
        description: 'Verify switcher is visible',
        expectedState: {
          visibleSwitchers: ['chat_008_1']
        }
      },
      {
        id: 'hover-off',
        action: 'hover-message',
        target: { element: 'chat-container' },
        description: 'Move hover away from message'
      },
      {
        id: 'verify-hidden',
        action: 'verify-state',
        target: {},
        description: 'Verify switcher is hidden',
        expectedState: {
          visibleSwitchers: []
        }
      }
    ],
    expectedOutcomes: [
      {
        stepId: 'verify-visible',
        type: 'ui',
        condition: {
          field: 'visibleSwitchers',
          operator: 'contains',
          value: 'chat_008_1'
        },
        description: 'Switcher visible on hover'
      },
      {
        stepId: 'verify-hidden',
        type: 'ui',
        condition: {
          field: 'visibleSwitchers.length',
          operator: 'equals',
          value: 0
        },
        description: 'Switcher hidden when not hovering'
      }
    ]
  },

  {
    id: 'switcher-visibility-user-edit',
    name: 'Switcher Visibility After User Edit',
    description: 'After editing a user message, both the edited user and regenerated assistant should show switchers',
    category: 'switcher',
    priority: 'high',
    tags: ['switcher', 'user-edit', 'visibility'],
    initialState: {
      chatId: 'chat_020',
      messages: [
        createMessage('chat_020_1', 'user', 'Prompt A'),
        createMessage('chat_020_2', 'assistant', 'Answer A')
      ]
    },
    steps: [
      { id: 'edit', action: 'edit', target: { messageId: 'chat_020_1' }, payload: { newContent: 'Prompt A (edited)' }, description: 'Edit user message' },
      { id: 'wait', action: 'wait', target: {}, delay: 150, description: 'Wait for regeneration to complete' },
      { id: 'hover-user', action: 'hover-message', target: { messageId: 'chat_020_1' }, description: 'Hover edited user message' },
      { id: 'hover-assistant', action: 'hover-message', target: { messageId: 'chat_020_v2_2' }, description: 'Hover regenerated assistant message' }
    ],
    expectedOutcomes: [
      { stepId: 'hover-user', type: 'ui', description: 'User switcher visible', condition: { field: 'visibleSwitchers', operator: 'contains', value: 'chat_020_1' } },
      { stepId: 'hover-assistant', type: 'ui', description: 'Assistant switcher visible via fallback', condition: { field: 'visibleSwitchers', operator: 'contains', value: 'chat_020_v2_2' } }
    ]
  },

  {
    id: 'switcher-visibility-assistant-edit',
    name: 'Switcher Visibility After Assistant Edit',
    description: 'Editing an assistant message should only show switcher on the assistant, not the user',
    category: 'switcher',
    priority: 'medium',
    tags: ['switcher', 'assistant-edit', 'visibility'],
    initialState: {
      chatId: 'chat_021',
      messages: [
        createMessage('chat_021_1', 'user', 'Prompt B'),
        createMessage('chat_021_2', 'assistant', 'Answer B')
      ]
    },
    steps: [
      { id: 'edit-assistant', action: 'edit', target: { messageId: 'chat_021_2' }, payload: { newContent: 'Answer B (edited)' }, description: 'Edit assistant' },
      { id: 'hover-assistant', action: 'hover-message', target: { messageId: 'chat_021_2' }, description: 'Hover assistant message' },
      { id: 'hover-user', action: 'hover-message', target: { messageId: 'chat_021_1' }, description: 'Hover user message' }
    ],
    expectedOutcomes: [
      { stepId: 'hover-assistant', type: 'ui', description: 'Assistant switcher visible', condition: { field: 'visibleSwitchers', operator: 'contains', value: 'chat_021_2' } },
      { stepId: 'hover-user', type: 'ui', description: 'User switcher hidden', condition: { field: 'visibleSwitchers', operator: 'not-exists', value: 'chat_021_1' } }
    ]
  },

  // ========== VERSION NUMBERING AND SWITCHING ==========
  {
    id: 'version-numbering-multi-retry',
    name: 'Version Numbering With Multiple Retries',
    description: 'Retry assistant twice and validate version numbers and switching to each version chat',
    category: 'retry',
    priority: 'high',
    tags: ['retry', 'versioning', 'switching'],
    initialState: {
      chatId: 'chat_022',
      messages: [
        createMessage('chat_022_1', 'user', 'Prompt C'),
        createMessage('chat_022_2', 'assistant', 'Answer C')
      ]
    },
    steps: [
      { id: 'r1', action: 'retry', target: { messageId: 'chat_022_2' }, description: 'First retry' },
      { id: 'wait1', action: 'wait', target: {}, delay: 120, description: 'Wait for stream' },
      { id: 'r2', action: 'retry', target: { messageId: 'chat_022_2' }, description: 'Second retry' },
      { id: 'wait2', action: 'wait', target: {}, delay: 120, description: 'Wait for stream' },
      { id: 'open-assistant', action: 'hover-message', target: { messageId: 'chat_022_2' }, description: 'Hover assistant' },
      { id: 'open-dropdown', action: 'click-switcher', target: { messageId: 'chat_022_2' }, description: 'Open dropdown' },
      { id: 'select-original', action: 'select-version', target: { messageId: 'chat_022_2', versionNumber: 1 }, description: 'Select original chat' }
    ],
    expectedOutcomes: [
      { stepId: 'r2', type: 'state', description: 'User parent versions exist', condition: { field: 'versions.chat_022_1', operator: 'exists' } },
      { stepId: 'select-original', type: 'state', description: 'Switched to original chat', condition: { field: 'currentChatId', operator: 'equals', value: 'chat_022' } }
    ]
  },

  // ========== SEND BUTTON STATE DURING STREAMING ==========
  {
    id: 'send-button-during-stream',
    name: 'Send Button During Streaming',
    description: 'Send button is disabled while streaming and re-enabled after completion',
    category: 'edge-case',
    priority: 'medium',
    tags: ['streaming', 'ui'],
    initialState: {
      chatId: 'chat_023',
      messages: [
        createMessage('chat_023_1', 'user', 'Prompt D'),
        createMessage('chat_023_2', 'assistant', 'Answer D')
      ]
    },
    steps: [
      { id: 'edit', action: 'edit', target: { messageId: 'chat_023_1' }, payload: { newContent: 'Prompt D (edited)' }, description: 'Edit user message triggers stream' },
      { id: 'verify-during', action: 'verify-state', target: {}, description: 'Verify disabled during stream', expectedState: { sendButtonDisabled: true, isStreaming: true } },
      { id: 'wait', action: 'wait', target: {}, delay: 150, description: 'Wait to finish stream' },
      { id: 'verify-after', action: 'verify-state', target: {}, description: 'Verify enabled after stream', expectedState: { sendButtonDisabled: false, isStreaming: false } }
    ],
    expectedOutcomes: []
  },
  {
    id: 'switcher-dropdown-interaction',
    name: 'Version Dropdown Interaction',
    description: 'Test opening and interacting with version dropdown',
    category: 'switcher',
    priority: 'high',
    tags: ['switcher', 'dropdown', 'ui'],
    initialState: {
      chatId: 'chat_009',
      messages: [
        createMessage('chat_009_1', 'user', 'Message with versions'),
        createMessage('chat_009_2', 'assistant', 'Response')
      ],
      versions: {
        'chat_009_1': [
          {
            version_number: 1,
            chat_version_id: 'chat_009',
            operation: 'original',
            created_at: new Date(Date.now() - 3600000).toISOString(),
            content: 'Original message'
          },
          {
            version_number: 2,
            chat_version_id: 'chat_009_v2',
            operation: 'edit',
            created_at: new Date(Date.now() - 1800000).toISOString(),
            content: 'First edit'
          },
          {
            version_number: 3,
            chat_version_id: 'chat_009_v3',
            operation: 'edit',
            created_at: new Date().toISOString(),
            content: 'Second edit'
          }
        ]
      }
    },
    steps: [
      {
        id: 'hover-message',
        action: 'hover-message',
        target: { messageId: 'chat_009_1' },
        description: 'Hover to show switcher'
      },
      {
        id: 'open-dropdown',
        action: 'click-switcher',
        target: { messageId: 'chat_009_1' },
        description: 'Click to open dropdown'
      },
      {
        id: 'verify-dropdown',
        action: 'verify-state',
        target: {},
        description: 'Verify dropdown is open with versions',
        expectedState: {
          activeDropdown: 'chat_009_1'
        }
      },
      {
        id: 'select-version',
        action: 'select-version',
        target: { messageId: 'chat_009_1', versionNumber: 2 },
        description: 'Select version 2'
      },
      {
        id: 'verify-switch',
        action: 'verify-state',
        target: {},
        description: 'Verify switched to version 2',
        expectedState: {
          currentChatId: 'chat_009_v2',
          activeDropdown: null
        }
      }
    ],
    expectedOutcomes: [
      {
        stepId: 'verify-dropdown',
        type: 'ui',
        condition: {
          field: 'activeDropdown',
          operator: 'equals',
          value: 'chat_009_1'
        },
        description: 'Dropdown opened successfully'
      },
      {
        stepId: 'verify-switch',
        type: 'state',
        condition: {
          field: 'currentChatId',
          operator: 'equals',
          value: 'chat_009_v2'
        },
        description: 'Version switch successful'
      }
    ]
  },

  // ========== COMPLEX VERSION TREE NAVIGATION ==========
  {
    id: 'deep-version-branching',
    name: 'Deep Version Tree with 3+ Levels',
    description: 'Test navigation through deep version tree with multiple branches at each level',
    category: 'complex',
    priority: 'high',
    tags: ['version-tree', 'deep-branching', 'navigation'],
    initialState: {
      chatId: 'chat_100',
      messages: [
        createMessage('chat_100_1', 'user', 'Root message'),
        createMessage('chat_100_2', 'assistant', 'Root response')
      ]
    },
    steps: [
      // Level 1: Create first branch
      { id: 'edit1', action: 'edit', target: { messageId: 'chat_100_1' }, payload: { newContent: 'Branch A Level 1' }, description: 'Create Branch A' },
      { id: 'wait1', action: 'wait', target: {}, delay: 150, description: 'Wait for stream completion' },
      
      // Level 2: Create sub-branch from Branch A
      { id: 'edit2', action: 'edit', target: { messageId: 'chat_100_1' }, payload: { newContent: 'Branch A.1 Level 2' }, description: 'Create sub-branch A.1' },
      { id: 'wait2', action: 'wait', target: {}, delay: 150, description: 'Wait for stream completion' },
      
      // Level 3: Create another sub-branch
      { id: 'edit3', action: 'edit', target: { messageId: 'chat_100_1' }, payload: { newContent: 'Branch A.1.1 Level 3' }, description: 'Create sub-branch A.1.1' },
      { id: 'wait3', action: 'wait', target: {}, delay: 150, description: 'Wait for stream completion' },
      
      // Navigate back to root
      { id: 'switch-root', action: 'switch-version', target: { chatId: 'chat_100' }, description: 'Switch back to root' },
      { id: 'verify-root', action: 'verify-state', target: {}, expectedState: { currentChatId: 'chat_100' }, description: 'Verify at root' },
      
      // Create parallel branch from root
      { id: 'edit4', action: 'edit', target: { messageId: 'chat_100_1' }, payload: { newContent: 'Branch B Level 1' }, description: 'Create Branch B from root' },
      { id: 'wait4', action: 'wait', target: {}, delay: 150, description: 'Wait for stream completion' },
      
      // Verify version count
      { id: 'hover-check', action: 'hover-message', target: { messageId: 'chat_100_1' }, description: 'Check versions exist' }
    ],
    expectedOutcomes: [
      { stepId: 'verify-root', type: 'state', condition: { field: 'currentChatId', operator: 'equals', value: 'chat_100' }, description: 'Navigation to root successful' },
      { stepId: 'hover-check', type: 'state', condition: { field: 'versions.chat_100_1.length', operator: 'greater-than', value: 4 }, description: 'All version branches created' }
    ]
  },

  {
    id: 'version-parent-child-coherence',
    name: 'Version Parent-Child Relationship Integrity',
    description: 'Verify parent-child relationships remain intact through complex operations',
    category: 'complex',
    priority: 'high',
    tags: ['version-tree', 'integrity', 'relationships'],
    initialState: {
      chatId: 'chat_101',
      messages: [
        createMessage('chat_101_1', 'user', 'Question 1'),
        createMessage('chat_101_2', 'assistant', 'Answer 1'),
        createMessage('chat_101_3', 'user', 'Question 2'),
        createMessage('chat_101_4', 'assistant', 'Answer 2')
      ]
    },
    steps: [
      // Create version from middle message
      { id: 'edit-middle', action: 'edit', target: { messageId: 'chat_101_3' }, payload: { newContent: 'Modified Question 2' }, description: 'Edit middle message' },
      { id: 'wait1', action: 'wait', target: {}, delay: 150, description: 'Wait for regeneration' },
      
      // Verify messages after edit point are removed
      { id: 'verify-removal', action: 'verify-state', target: {}, description: 'Verify later messages removed' },
      
      // Add new message in version
      { id: 'continue-chat', action: 'send-message', target: {}, payload: { content: 'Question 3 in version' }, description: 'Continue in version' },
      { id: 'wait2', action: 'wait', target: {}, delay: 100, description: 'Wait for response' },
      
      // Switch back to original
      { id: 'switch-original', action: 'switch-version', target: { chatId: 'chat_101' }, description: 'Return to original' },
      
      // Verify original is intact
      { id: 'verify-original', action: 'verify-state', target: {}, description: 'Original chat intact', expectedState: { currentChatId: 'chat_101' } }
    ],
    expectedOutcomes: [
      { stepId: 'verify-removal', type: 'state', condition: { field: 'messages.length', operator: 'equals', value: 3 }, description: 'Messages after edit removed correctly' },
      { stepId: 'verify-original', type: 'state', condition: { field: 'messages.length', operator: 'equals', value: 4 }, description: 'Original chat preserved' }
    ]
  },

  // ========== ERROR RECOVERY & RESILIENCE ==========
  {
    id: 'recovery-from-failed-stream',
    name: 'Recovery from Failed Streaming Operation',
    description: 'Test system recovery when streaming fails during version operation',
    category: 'edge-case',
    priority: 'high',
    tags: ['error-recovery', 'streaming', 'resilience'],
    initialState: {
      chatId: 'chat_102',
      messages: [
        createMessage('chat_102_1', 'user', 'Test prompt'),
        createMessage('chat_102_2', 'assistant', 'Test response')
      ]
    },
    steps: [
      // Simulate stream failure by cancelling mid-operation
      { id: 'start-retry', action: 'retry', target: { messageId: 'chat_102_2' }, description: 'Start retry operation' },
      { id: 'wait-partial', action: 'wait', target: {}, delay: 50, description: 'Wait for partial stream' },
      
      // Cancel streaming to simulate failure
      { id: 'cancel-stream', action: 'cancel-streaming', target: { chatId: 'chat_102_v2' }, description: 'Cancel streaming to simulate failure' },
      
      // Verify system state after cancellation
      { id: 'verify-state', action: 'verify-state', target: {}, description: 'Verify recoverable state', expectedState: { isStreaming: false, sendButtonDisabled: false } },
      
      // Retry the operation
      { id: 'retry-again', action: 'retry', target: { messageId: 'chat_102_2' }, description: 'Retry after failure' },
      { id: 'wait-complete', action: 'wait', target: {}, delay: 150, description: 'Wait for successful completion' },
      
      // Verify successful recovery
      { id: 'verify-recovery', action: 'verify-state', target: {}, description: 'Verify successful recovery', expectedState: { isStreaming: false, sendButtonDisabled: false } }
    ],
    expectedOutcomes: [
      { stepId: 'verify-state', type: 'state', condition: { field: 'sendButtonDisabled', operator: 'equals', value: false }, description: 'System recoverable after cancel' },
      { stepId: 'verify-recovery', type: 'state', condition: { field: 'operationInProgress', operator: 'equals', value: null }, description: 'Operation completed successfully' }
    ]
  },

  {
    id: 'orphaned-version-handling',
    name: 'Orphaned Version Detection and Handling',
    description: 'Test handling of versions that lose their parent reference',
    category: 'edge-case',
    priority: 'medium',
    tags: ['error-recovery', 'orphaned-versions', 'integrity'],
    initialState: {
      chatId: 'chat_103',
      messages: [
        createMessage('chat_103_1', 'user', 'Original'),
        createMessage('chat_103_2', 'assistant', 'Response')
      ],
      versions: {
        'chat_103_1': [
          { version_number: 1, chat_version_id: 'chat_103', operation: 'original', created_at: new Date().toISOString() },
          { version_number: 2, chat_version_id: 'chat_103_v2', operation: 'edit', created_at: new Date().toISOString() },
          { version_number: 3, chat_version_id: 'orphan_version', operation: 'edit', created_at: new Date().toISOString() }
        ]
      }
    },
    steps: [
      // Try to switch to orphaned version
      { id: 'hover-message', action: 'hover-message', target: { messageId: 'chat_103_1' }, description: 'Show version switcher' },
      { id: 'open-dropdown', action: 'click-switcher', target: { messageId: 'chat_103_1' }, description: 'Open version dropdown' },
      
      // Verify orphaned version is handled gracefully
      { id: 'verify-dropdown', action: 'verify-state', target: {}, description: 'Dropdown shows valid versions', expectedState: { activeDropdown: 'chat_103_1' } },
      
      // Try selecting orphaned version
      { id: 'select-orphan', action: 'select-version', target: { messageId: 'chat_103_1', versionNumber: 3 }, description: 'Try selecting orphaned version' },
      
      // Verify graceful handling
      { id: 'verify-handling', action: 'verify-state', target: {}, description: 'System handles orphan gracefully', expectedState: { currentChatId: 'orphan_version' } }
    ],
    expectedOutcomes: [
      { stepId: 'verify-dropdown', type: 'ui', condition: { field: 'activeDropdown', operator: 'equals', value: 'chat_103_1' }, description: 'Dropdown opened despite orphan' }
    ]
  },

  // ========== MESSAGE ID SYNCHRONIZATION ==========
  {
    id: 'temp-id-resolution-in-versions',
    name: 'Temporary ID Resolution in Versioned Context',
    description: 'Test proper resolution of temporary IDs across version switches',
    category: 'edge-case',
    priority: 'high',
    tags: ['message-id', 'temp-ids', 'synchronization'],
    initialState: {
      chatId: 'chat_104',
      messages: [
        createMessage('chat_104_1', 'user', 'Initial message'),
        { ...createMessage('temp_123_assistant', 'assistant', 'Streaming...'), isStreaming: true }
      ],
      isStreaming: true
    },
    steps: [
      // Perform operation while temp ID exists
      { id: 'edit-during-stream', action: 'edit', target: { messageId: 'chat_104_1' }, payload: { newContent: 'Edited during stream' }, description: 'Edit while temp ID exists' },
      
      // Wait for both streams to stabilize
      { id: 'wait-streams', action: 'wait', target: {}, delay: 200, description: 'Wait for all streams to complete' },
      
      // Verify IDs are properly resolved
      { id: 'verify-ids', action: 'verify-state', target: {}, description: 'Verify no temp IDs remain', expectedState: { isStreaming: false } },
      
      // Switch between versions to test ID consistency
      { id: 'switch-original', action: 'switch-version', target: { chatId: 'chat_104' }, description: 'Switch to original' },
      { id: 'verify-original-ids', action: 'verify-state', target: {}, description: 'Original has proper IDs', expectedState: { currentChatId: 'chat_104' } },
      
      { id: 'switch-version', action: 'switch-version', target: { chatId: 'chat_104_v2' }, description: 'Switch to version' },
      { id: 'verify-version-ids', action: 'verify-state', target: {}, description: 'Version has proper IDs', expectedState: { currentChatId: 'chat_104_v2' } }
    ],
    expectedOutcomes: [
      { stepId: 'verify-ids', type: 'state', condition: { field: 'isStreaming', operator: 'equals', value: false }, description: 'All streams completed' }
    ]
  },

  {
    id: 'cross-version-message-references',
    name: 'Cross-Version Message Reference Integrity',
    description: 'Test that message references remain valid across version boundaries',
    category: 'complex',
    priority: 'medium',
    tags: ['message-id', 'references', 'integrity'],
    initialState: {
      chatId: 'chat_105',
      messages: [
        createMessage('chat_105_1', 'user', 'Message A'),
        createMessage('chat_105_2', 'assistant', 'Response A'),
        createMessage('chat_105_3', 'user', 'Message B'),
        createMessage('chat_105_4', 'assistant', 'Response B')
      ]
    },
    steps: [
      // Create version from first message
      { id: 'version1', action: 'edit', target: { messageId: 'chat_105_1' }, payload: { newContent: 'Message A v2' }, description: 'Create first version' },
      { id: 'wait1', action: 'wait', target: {}, delay: 150, description: 'Wait for stream' },
      
      // Add messages in version
      { id: 'add-msg1', action: 'send-message', target: {}, payload: { content: 'New message in v2' }, description: 'Add message in version' },
      { id: 'wait2', action: 'wait', target: {}, delay: 100, description: 'Wait for response' },
      
      // Create another version from the version
      { id: 'version2', action: 'retry', target: { messageId: 'chat_105_v2_2' }, description: 'Retry in version creates v3' },
      { id: 'wait3', action: 'wait', target: {}, delay: 150, description: 'Wait for stream' },
      
      // Verify message IDs maintain proper prefixes
      { id: 'verify-v3-ids', action: 'verify-state', target: {}, description: 'V3 has proper ID structure', expectedState: { currentChatId: 'chat_105_v3' } },
      
      // Navigate through versions and verify ID consistency
      { id: 'switch-v2', action: 'switch-version', target: { chatId: 'chat_105_v2' }, description: 'Switch to v2' },
      { id: 'verify-v2', action: 'verify-state', target: {}, description: 'V2 IDs intact', expectedState: { currentChatId: 'chat_105_v2' } },
      
      { id: 'switch-original', action: 'switch-version', target: { chatId: 'chat_105' }, description: 'Switch to original' },
      { id: 'verify-original', action: 'verify-state', target: {}, description: 'Original IDs intact', expectedState: { currentChatId: 'chat_105' } }
    ],
    expectedOutcomes: [
      { stepId: 'verify-v3-ids', type: 'state', condition: { field: 'currentChatId', operator: 'equals', value: 'chat_105_v3' }, description: 'V3 created successfully' },
      { stepId: 'verify-original', type: 'state', condition: { field: 'messages.length', operator: 'equals', value: 4 }, description: 'Original messages preserved' }
    ]
  },

  // ========== UI STATE SYNCHRONIZATION ==========
  {
    id: 'skeleton-loader-accuracy',
    name: 'Skeleton Loader State During Complex Operations',
    description: 'Verify skeleton loader shows accurate state during version operations',
    category: 'edge-case',
    priority: 'medium',
    tags: ['ui-state', 'skeleton-loader', 'loading'],
    initialState: {
      chatId: 'chat_106',
      messages: [
        createMessage('chat_106_1', 'user', 'Test message'),
        createMessage('chat_106_2', 'assistant', 'Test response')
      ]
    },
    steps: [
      // Start operation that triggers loading
      { id: 'start-edit', action: 'edit', target: { messageId: 'chat_106_1' }, payload: { newContent: 'Edited message' }, description: 'Start edit operation' },
      
      // Immediately check loading state
      { id: 'verify-loading', action: 'verify-state', target: {}, description: 'Loading state active', expectedState: { operationInProgress: 'edit' } },
      
      // Wait for completion
      { id: 'wait-complete', action: 'wait', target: {}, delay: 150, description: 'Wait for operation' },
      
      // Verify loading cleared
      { id: 'verify-clear', action: 'verify-state', target: {}, description: 'Loading state cleared', expectedState: { operationInProgress: null, isStreaming: false } },
      
      // Start rapid operations
      { id: 'rapid-retry', action: 'retry', target: { messageId: 'chat_106_v2_2' }, description: 'Quick retry' },
      { id: 'rapid-edit', action: 'edit', target: { messageId: 'chat_106_v2_2' }, payload: { newContent: 'Quick edit' }, description: 'Quick edit during retry' },
      
      // Verify state remains coherent
      { id: 'wait-final', action: 'wait', target: {}, delay: 200, description: 'Wait for all operations' },
      { id: 'verify-final', action: 'verify-state', target: {}, description: 'Final state coherent', expectedState: { operationInProgress: null, isStreaming: false } }
    ],
    expectedOutcomes: [
      { stepId: 'verify-loading', type: 'state', condition: { field: 'operationInProgress', operator: 'equals', value: 'edit' }, description: 'Loading state shown' },
      { stepId: 'verify-clear', type: 'state', condition: { field: 'operationInProgress', operator: 'equals', value: null }, description: 'Loading cleared properly' },
      { stepId: 'verify-final', type: 'state', condition: { field: 'isStreaming', operator: 'equals', value: false }, description: 'All operations completed' }
    ]
  },

  {
    id: 'version-dropdown-state-persistence',
    name: 'Version Dropdown State Across Operations',
    description: 'Test dropdown state persistence during various operations',
    category: 'switcher',
    priority: 'medium',
    tags: ['ui-state', 'dropdown', 'persistence'],
    initialState: {
      chatId: 'chat_107',
      messages: [
        createMessage('chat_107_1', 'user', 'Message'),
        createMessage('chat_107_2', 'assistant', 'Response')
      ],
      versions: {
        'chat_107_1': [
          { version_number: 1, chat_version_id: 'chat_107', operation: 'original', created_at: new Date().toISOString() },
          { version_number: 2, chat_version_id: 'chat_107_v2', operation: 'edit', created_at: new Date().toISOString() }
        ]
      }
    },
    steps: [
      // Open dropdown
      { id: 'hover', action: 'hover-message', target: { messageId: 'chat_107_1' }, description: 'Hover message' },
      { id: 'open', action: 'click-switcher', target: { messageId: 'chat_107_1' }, description: 'Open dropdown' },
      { id: 'verify-open', action: 'verify-state', target: {}, expectedState: { activeDropdown: 'chat_107_1' }, description: 'Dropdown is open' },
      
      // Perform operation while dropdown is open
      { id: 'send-msg', action: 'send-message', target: {}, payload: { content: 'New message' }, description: 'Send message with dropdown open' },
      
      // Verify dropdown closed automatically
      { id: 'verify-closed', action: 'verify-state', target: {}, expectedState: { activeDropdown: null }, description: 'Dropdown auto-closed' },
      
      // Re-open and perform version switch
      { id: 'hover2', action: 'hover-message', target: { messageId: 'chat_107_1' }, description: 'Hover again' },
      { id: 'open2', action: 'click-switcher', target: { messageId: 'chat_107_1' }, description: 'Open dropdown again' },
      { id: 'select', action: 'select-version', target: { messageId: 'chat_107_1', versionNumber: 2 }, description: 'Select version' },
      
      // Verify dropdown closed after selection
      { id: 'verify-closed2', action: 'verify-state', target: {}, expectedState: { activeDropdown: null, currentChatId: 'chat_107_v2' }, description: 'Dropdown closed on selection' }
    ],
    expectedOutcomes: [
      { stepId: 'verify-open', type: 'ui', condition: { field: 'activeDropdown', operator: 'equals', value: 'chat_107_1' }, description: 'Dropdown opened' },
      { stepId: 'verify-closed', type: 'ui', condition: { field: 'activeDropdown', operator: 'equals', value: null }, description: 'Dropdown closed on operation' },
      { stepId: 'verify-closed2', type: 'ui', condition: { field: 'activeDropdown', operator: 'equals', value: null }, description: 'Dropdown closed on selection' }
    ]
  },

  // ========== PERFORMANCE & SCALE TESTS ==========
  {
    id: 'many-versions-performance',
    name: 'Performance with 20+ Versions',
    description: 'Test system performance with many versions of same message',
    category: 'edge-case',
    priority: 'low',
    tags: ['performance', 'scale', 'stress-test'],
    initialState: {
      chatId: 'chat_108',
      messages: [
        createMessage('chat_108_1', 'user', 'Base message'),
        createMessage('chat_108_2', 'assistant', 'Base response')
      ]
    },
    steps: [
      // Create many versions rapidly by retrying the user message
      { id: 'v1', action: 'retry', target: { messageId: 'chat_108_1' }, description: 'Version 1' },
      { id: 'w1', action: 'wait', target: {}, delay: 100, description: 'Wait' },
      { id: 'v2', action: 'retry', target: { messageId: 'chat_108_1' }, description: 'Version 2' },
      { id: 'w2', action: 'wait', target: {}, delay: 100, description: 'Wait' },
      { id: 'v3', action: 'retry', target: { messageId: 'chat_108_1' }, description: 'Version 3' },
      { id: 'w3', action: 'wait', target: {}, delay: 100, description: 'Wait' },
      { id: 'v4', action: 'retry', target: { messageId: 'chat_108_1' }, description: 'Version 4' },
      { id: 'w4', action: 'wait', target: {}, delay: 100, description: 'Wait' },
      { id: 'v5', action: 'retry', target: { messageId: 'chat_108_1' }, description: 'Version 5' },
      { id: 'w5', action: 'wait', target: {}, delay: 100, description: 'Wait' },
      
      // Test dropdown performance with many versions
      { id: 'hover-many', action: 'hover-message', target: { messageId: 'chat_108_1' }, description: 'Hover with many versions' },
      { id: 'open-many', action: 'click-switcher', target: { messageId: 'chat_108_1' }, description: 'Open large dropdown' },
      
      // Verify dropdown renders all versions
      { id: 'verify-dropdown', action: 'verify-state', target: {}, expectedState: { activeDropdown: 'chat_108_1' }, description: 'Dropdown handles many versions' },
      
      // Test switching between distant versions
      { id: 'switch-first', action: 'select-version', target: { messageId: 'chat_108_1', versionNumber: 1 }, description: 'Switch to first' },
      { id: 'verify-first', action: 'verify-state', target: {}, expectedState: { currentChatId: 'chat_108' }, description: 'At first version' },
      
      { id: 'hover-again', action: 'hover-message', target: { messageId: 'chat_108_1' }, description: 'Hover again' },
      { id: 'open-again', action: 'click-switcher', target: { messageId: 'chat_108_1' }, description: 'Open dropdown again' },
      { id: 'switch-last', action: 'select-version', target: { messageId: 'chat_108_1', versionNumber: 6 }, description: 'Switch to last' },
      { id: 'verify-last', action: 'verify-state', target: {}, expectedState: { currentChatId: 'chat_108_v6' }, description: 'At last version' }
    ],
    expectedOutcomes: [
      { stepId: 'verify-dropdown', type: 'ui', condition: { field: 'activeDropdown', operator: 'equals', value: 'chat_108_1' }, description: 'Dropdown opened with many versions' },
      { stepId: 'verify-first', type: 'state', condition: { field: 'currentChatId', operator: 'equals', value: 'chat_108' }, description: 'Switched to first version' },
      { stepId: 'verify-last', type: 'state', condition: { field: 'currentChatId', operator: 'equals', value: 'chat_108_v6' }, description: 'Switched to last version' }
    ]
  },

  // ========== DATA INTEGRITY TESTS ==========
  {
    id: 'message-content-preservation',
    name: 'Message Content Preservation Across Versions',
    description: 'Verify message content is preserved correctly in each version',
    category: 'complex',
    priority: 'high',
    tags: ['data-integrity', 'content', 'preservation'],
    initialState: {
      chatId: 'chat_109',
      messages: [
        createMessage('chat_109_1', 'user', 'Original content with special chars: <>&"\''),
        createMessage('chat_109_2', 'assistant', 'Response with markdown **bold** _italic_ `code`')
      ]
    },
    steps: [
      // Edit with special characters
      { id: 'edit-special', action: 'edit', target: { messageId: 'chat_109_1' }, payload: { newContent: 'Edited with emojis 🎉 and symbols @#$%' }, description: 'Edit with special content' },
      { id: 'wait1', action: 'wait', target: {}, delay: 150, description: 'Wait for stream' },
      
      // Switch back to original
      { id: 'switch-orig', action: 'switch-version', target: { chatId: 'chat_109' }, description: 'Switch to original' },
      
      // Verify original content intact
      { id: 'verify-orig', action: 'verify-state', target: {}, expectedState: { currentChatId: 'chat_109' }, description: 'Original content preserved' },
      
      // Switch to version
      { id: 'switch-version', action: 'switch-version', target: { chatId: 'chat_109_v2' }, description: 'Switch to version' },
      
      // Verify edited content
      { id: 'verify-version', action: 'verify-state', target: {}, expectedState: { currentChatId: 'chat_109_v2' }, description: 'Edited content correct' }
    ],
    expectedOutcomes: [
      { stepId: 'verify-orig', type: 'state', condition: { field: 'messages[0].content', operator: 'contains', value: 'special chars' }, description: 'Original preserved' },
      { stepId: 'verify-version', type: 'state', condition: { field: 'messages[0].content', operator: 'contains', value: 'emojis' }, description: 'Edit preserved' }
    ]
  },

  {
    id: 'version-metadata-consistency',
    name: 'Version Metadata Consistency Check',
    description: 'Verify version metadata remains consistent through operations',
    category: 'complex',
    priority: 'medium',
    tags: ['data-integrity', 'metadata', 'consistency'],
    initialState: {
      chatId: 'chat_110',
      messages: [
        createMessage('chat_110_1', 'user', 'Test'),
        createMessage('chat_110_2', 'assistant', 'Response')
      ]
    },
    steps: [
      // Create versions with different operations
      { id: 'edit1', action: 'edit', target: { messageId: 'chat_110_1' }, payload: { newContent: 'Edit 1' }, description: 'First edit' },
      { id: 'wait1', action: 'wait', target: {}, delay: 150, description: 'Wait' },
      
      { id: 'retry1', action: 'retry', target: { messageId: 'chat_110_v2_2' }, description: 'Retry after edit' },
      { id: 'wait2', action: 'wait', target: {}, delay: 150, description: 'Wait' },
      
      { id: 'delete1', action: 'delete', target: { messageId: 'chat_110_v3_2' }, description: 'Delete in version' },
      
      // Load versions and verify metadata
      { id: 'hover-check', action: 'hover-message', target: { messageId: 'chat_110_1' }, description: 'Load versions' },
      { id: 'open-dropdown', action: 'click-switcher', target: { messageId: 'chat_110_1' }, description: 'Open version list' },
      
      // Verify version metadata
      { id: 'verify-versions', action: 'verify-state', target: {}, description: 'Version metadata exists', expectedState: { activeDropdown: 'chat_110_1' } }
    ],
    expectedOutcomes: [
      { stepId: 'verify-versions', type: 'state', condition: { field: 'versions.chat_110_1', operator: 'exists' }, description: 'Versions tracked correctly' }
    ]
  },

  // ========== STREAM MANAGEMENT EDGE CASES ==========
  {
    id: 'concurrent-streams-different-versions',
    name: 'Concurrent Streams in Different Versions',
    description: 'Test handling of simultaneous streams in different version branches',
    category: 'edge-case',
    priority: 'high',
    tags: ['streaming', 'concurrent', 'multiprocessing'],
    initialState: {
      chatId: 'chat_111',
      messages: [
        createMessage('chat_111_1', 'user', 'Question'),
        createMessage('chat_111_2', 'assistant', 'Answer')
      ]
    },
    steps: [
      // Start first stream
      { id: 'retry1', action: 'retry', target: { messageId: 'chat_111_2' }, description: 'Start first stream' },
      
      // Wait for first to complete
      { id: 'wait1', action: 'wait', target: {}, delay: 150, description: 'Wait for first stream' },
      
      // Start second stream
      { id: 'retry2', action: 'retry', target: { messageId: 'chat_111_2' }, description: 'Start second stream' },
      
      // Should be streaming
      { id: 'verify-streaming', action: 'verify-state', target: {}, description: 'Streaming active', expectedState: { isStreaming: true } },
      
      // Wait for completion
      { id: 'wait-both', action: 'wait', target: {}, delay: 200, description: 'Wait for both streams' },
      
      // Verify both completed
      { id: 'verify-complete', action: 'verify-state', target: {}, description: 'Both streams completed', expectedState: { isStreaming: false } },
      
      // Check version count increased by 2
      { id: 'hover-versions', action: 'hover-message', target: { messageId: 'chat_111_1' }, description: 'Check versions' }
    ],
    expectedOutcomes: [
      { stepId: 'verify-streaming', type: 'state', condition: { field: 'isStreaming', operator: 'equals', value: true }, description: 'Streaming was active' },
      { stepId: 'verify-complete', type: 'state', condition: { field: 'isStreaming', operator: 'equals', value: false }, description: 'Streams completed' },
      { stepId: 'hover-versions', type: 'state', condition: { field: 'versions.chat_111_1.length', operator: 'greater-than', value: 2 }, description: 'Multiple versions created' }
    ]
  },

  {
    id: 'stream-rejoin-after-navigation',
    name: 'Stream Rejoin After Version Navigation',
    description: 'Test rejoining an active stream after navigating away and back',
    category: 'edge-case',
    priority: 'medium',
    tags: ['streaming', 'navigation', 'rejoin'],
    initialState: {
      chatId: 'chat_112',
      messages: [
        createMessage('chat_112_1', 'user', 'Long prompt for slow response'),
        createMessage('chat_112_2', 'assistant', 'Initial response')
      ]
    },
    steps: [
      // Start long-running stream
      { id: 'start-stream', action: 'retry', target: { messageId: 'chat_112_2' }, description: 'Start long stream' },
      
      // Navigate away while streaming
      { id: 'navigate-away', action: 'switch-version', target: { chatId: 'chat_112' }, description: 'Navigate to original while streaming' },
      
      // Verify original is not streaming
      { id: 'verify-no-stream', action: 'verify-state', target: {}, expectedState: { currentChatId: 'chat_112', isStreaming: false }, description: 'Original not streaming' },
      
      // Navigate back to streaming version
      { id: 'navigate-back', action: 'switch-version', target: { chatId: 'chat_112_v2' }, description: 'Return to streaming version' },
      
      // Should rejoin the stream
      { id: 'verify-rejoined', action: 'verify-state', target: {}, expectedState: { currentChatId: 'chat_112_v2' }, description: 'Back in streaming version' },
      
      // Wait for completion
      { id: 'wait-complete', action: 'wait', target: {}, delay: 150, description: 'Wait for stream to finish' },
      
      // Verify completed
      { id: 'verify-done', action: 'verify-state', target: {}, expectedState: { isStreaming: false }, description: 'Stream completed' }
    ],
    expectedOutcomes: [
      { stepId: 'verify-no-stream', type: 'state', condition: { field: 'isStreaming', operator: 'equals', value: false }, description: 'Original not streaming' },
      { stepId: 'verify-done', type: 'state', condition: { field: 'isStreaming', operator: 'equals', value: false }, description: 'Stream completed successfully' }
    ]
  },

  // ========== EDGE CASES FOR VERSION SWITCHERS ==========
  {
    id: 'switcher-after-delete-operation',
    name: 'Switcher Behavior After Delete Creates Version',
    description: 'Test switcher visibility after delete operation creates a version',
    category: 'switcher',
    priority: 'medium',
    tags: ['switcher', 'delete', 'visibility'],
    initialState: {
      chatId: 'chat_113',
      messages: [
        createMessage('chat_113_1', 'user', 'Message 1'),
        createMessage('chat_113_2', 'assistant', 'Response 1'),
        createMessage('chat_113_3', 'user', 'Message 2'),
        createMessage('chat_113_4', 'assistant', 'Response 2')
      ]
    },
    steps: [
      // Delete middle message
      { id: 'delete-middle', action: 'delete', target: { messageId: 'chat_113_3' }, description: 'Delete creates version' },
      
      // Hover over remaining messages - they should NOT show switchers for delete
      { id: 'hover-first', action: 'hover-message', target: { messageId: 'chat_113_1' }, description: 'Hover first message' },
      { id: 'verify-no-switcher1', action: 'verify-state', target: {}, expectedState: { visibleSwitchers: [] }, description: 'No switcher for delete' },
      
      { id: 'hover-second', action: 'hover-message', target: { messageId: 'chat_113_2' }, description: 'Hover second message' },
      { id: 'verify-no-switcher2', action: 'verify-state', target: {}, expectedState: { visibleSwitchers: [] }, description: 'No switcher for delete' },
      
      // Now edit a message to create a "real" version with switcher
      { id: 'edit-message', action: 'edit', target: { messageId: 'chat_113_1' }, payload: { newContent: 'Edited Message 1' }, description: 'Edit creates version with switcher' },
      { id: 'wait-stream', action: 'wait', target: {}, delay: 150, description: 'Wait for stream' },
      
      // Now hover should show switcher
      { id: 'hover-after-edit', action: 'hover-message', target: { messageId: 'chat_113_1' }, description: 'Hover after edit' },
      { id: 'verify-switcher', action: 'verify-state', target: {}, expectedState: { visibleSwitchers: ['chat_113_1'] }, description: 'Switcher visible after edit' }
    ],
    expectedOutcomes: [
      { stepId: 'verify-no-switcher1', type: 'ui', condition: { field: 'visibleSwitchers.length', operator: 'equals', value: 0 }, description: 'No switcher after delete' },
      { stepId: 'verify-switcher', type: 'ui', condition: { field: 'visibleSwitchers', operator: 'contains', value: 'chat_113_1' }, description: 'Switcher visible after edit' }
    ]
  },

  {
    id: 'switcher-max-versions-display',
    name: 'Switcher Display with Maximum Versions',
    description: 'Test switcher dropdown behavior when hitting display limits',
    category: 'switcher',
    priority: 'low',
    tags: ['switcher', 'limits', 'ui'],
    initialState: {
      chatId: 'chat_114',
      messages: [
        createMessage('chat_114_1', 'user', 'Base'),
        createMessage('chat_114_2', 'assistant', 'Response')
      ],
      versions: {
        'chat_114_1': Array.from({ length: 15 }, (_, i) => ({
          version_number: i + 1,
          chat_version_id: i === 0 ? 'chat_114' : `chat_114_v${i + 1}`,
          operation: i === 0 ? 'original' : 'retry',
          created_at: new Date(Date.now() - (15 - i) * 60000).toISOString()
        }))
      }
    },
    steps: [
      // Open dropdown with many versions
      { id: 'hover', action: 'hover-message', target: { messageId: 'chat_114_1' }, description: 'Hover message' },
      { id: 'open', action: 'click-switcher', target: { messageId: 'chat_114_1' }, description: 'Open large dropdown' },
      
      // Verify dropdown opened
      { id: 'verify-open', action: 'verify-state', target: {}, expectedState: { activeDropdown: 'chat_114_1' }, description: 'Dropdown opened' },
      
      // Select a middle version
      { id: 'select-middle', action: 'select-version', target: { messageId: 'chat_114_1', versionNumber: 8 }, description: 'Select middle version' },
      
      // Verify switched
      { id: 'verify-switch', action: 'verify-state', target: {}, expectedState: { currentChatId: 'chat_114_v8' }, description: 'Switched to v8' },
      
      // Re-open and select last
      { id: 'hover2', action: 'hover-message', target: { messageId: 'chat_114_1' }, description: 'Hover again' },
      { id: 'open2', action: 'click-switcher', target: { messageId: 'chat_114_1' }, description: 'Open again' },
      { id: 'select-last', action: 'select-version', target: { messageId: 'chat_114_1', versionNumber: 15 }, description: 'Select last version' },
      
      // Verify switched to last
      { id: 'verify-last', action: 'verify-state', target: {}, expectedState: { currentChatId: 'chat_114_v15' }, description: 'Switched to last' }
    ],
    expectedOutcomes: [
      { stepId: 'verify-open', type: 'ui', condition: { field: 'activeDropdown', operator: 'equals', value: 'chat_114_1' }, description: 'Large dropdown opened' },
      { stepId: 'verify-switch', type: 'state', condition: { field: 'currentChatId', operator: 'equals', value: 'chat_114_v8' }, description: 'Switched to middle' },
      { stepId: 'verify-last', type: 'state', condition: { field: 'currentChatId', operator: 'equals', value: 'chat_114_v15' }, description: 'Switched to last' }
    ]
  },

  // ========== VERSION CLEANUP & MAINTENANCE ==========
  {
    id: 'version-chain-after-main-delete',
    name: 'Version Chain Behavior When Main Chat Deleted',
    description: 'Test version handling when the main chat is deleted',
    category: 'edge-case',
    priority: 'medium',
    tags: ['cleanup', 'delete', 'orphaned'],
    initialState: {
      chatId: 'chat_115',
      messages: [
        createMessage('chat_115_1', 'user', 'Main chat message'),
        createMessage('chat_115_2', 'assistant', 'Main response')
      ]
    },
    steps: [
      // Create versions
      { id: 'create-v1', action: 'edit', target: { messageId: 'chat_115_1' }, payload: { newContent: 'Version 1' }, description: 'Create version 1' },
      { id: 'wait1', action: 'wait', target: {}, delay: 150, description: 'Wait' },
      
      { id: 'create-v2', action: 'retry', target: { messageId: 'chat_115_v2_2' }, description: 'Create version 2' },
      { id: 'wait2', action: 'wait', target: {}, delay: 150, description: 'Wait' },
      
      // Switch back to main
      { id: 'switch-main', action: 'switch-version', target: { chatId: 'chat_115' }, description: 'Switch to main' },
      
      // Delete main chat (simulated - in real scenario this would be through UI)
      { id: 'delete-main', action: 'delete-chat', target: { chatId: 'chat_115' }, description: 'Delete main chat' },
      
      // Try to access versions (should handle gracefully)
      { id: 'try-access-v1', action: 'switch-version', target: { chatId: 'chat_115_v2' }, description: 'Try accessing version 1' },
      
      // Verify graceful handling
      { id: 'verify-handling', action: 'verify-state', target: {}, description: 'System handles orphaned versions' }
    ],
    expectedOutcomes: [
      { stepId: 'verify-handling', type: 'state', condition: { field: 'operationInProgress', operator: 'equals', value: null }, description: 'System stable after main delete' }
    ]
  }
];

// Helper function to get scenarios by category
export const getScenariosByCategory = (category: string): TestScenario[] => {
  return testScenarios.filter(s => s.category === category);
};

// Helper function to get scenarios by tags
export const getScenariosByTags = (tags: string[]): TestScenario[] => {
  return testScenarios.filter(s => 
    tags.some(tag => s.tags.includes(tag))
  );
};

// Helper function to get high priority scenarios
export const getHighPriorityScenarios = (): TestScenario[] => {
  return testScenarios.filter(s => s.priority === 'high');
};
