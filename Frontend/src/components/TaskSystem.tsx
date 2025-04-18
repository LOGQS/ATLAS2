import React, { useState, useRef, useEffect, useCallback } from 'react';
import '../styles/task-system.css';

interface TaskSystemProps {
  isOpen: boolean;
  onClose: () => void;
}

interface TaskStep {
  id: string;
  timestamp: Date;
  title: string;
  description: string;
  screenshot: string; // URL to screenshot
  status: 'planned' | 'in-progress' | 'completed' | 'error';
}

interface ChatMessage {
  id: string;
  sender: 'user' | 'agent';
  content: string;
  timestamp: Date;
  relatedStepId?: string; // Optional reference to a task step
  isThinking?: boolean;
}

// New interfaces for task backend integration
interface TaskData {
  id: string;
  title: string;
  model: string;
  created_at: string;
  updated_at: string;
  status: string;
  message_count?: number;
  first_message?: string;
}

interface TaskMessage {
  role: 'user' | 'assistant';
  content: string;
}

// Add type for task chat request
interface TaskChatRequest {
  messages: { role: 'user' | 'assistant'; content: string; }[];
  model: string;
  task_id?: string;
}

const TaskSystem: React.FC<TaskSystemProps> = ({ isOpen, onClose }) => {
  const [inputValue, setInputValue] = useState('');
  const [isExpanded, setIsExpanded] = useState(false);
  const [fileAttachments, setFileAttachments] = useState<File[]>([]);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [chatHistory, setChatHistory] = useState<ChatMessage[]>([]);
  
  // New state variables for backend integration
  const [taskId, setTaskId] = useState<string | null>(null);
  const [isLoadingTask, setIsLoadingTask] = useState(false); 
  const [isStreaming, setIsStreaming] = useState(false);
  const [taskData, setTaskData] = useState<TaskData | null>(null);
  
  // Add state for task title
  const [taskTitle, setTaskTitle] = useState<string>('');
  
  const [isPlanVisible, setIsPlanVisible] = useState(false);
  const [isScreenshotVisible, setIsScreenshotVisible] = useState(false);
  
  const fileInputRef = useRef<HTMLInputElement>(null);
  const chatEndRef = useRef<HTMLDivElement>(null);
  
  // Initialize with empty plan instead of placeholder
  const [plan, setPlan] = useState<string>('');
  
  // Start with empty steps array instead of placeholder
  const [planSteps, setPlanSteps] = useState<TaskStep[]>([]);
  
  const [currentStepIndex, setCurrentStepIndex] = useState(0);
  
  // Add state for objective
  const [objective, setObjective] = useState<string>('');
  
  // Function declarations at the top level, before they are used
  const extractTitleFromPlan = (planContent: string): string => {
    // First, try looking for the exact "# TASK TITLE:" format
    const titlePattern = /# TASK TITLE:\s*(.*?)(?=\n##|\n$|$)/s;
    const titleMatch = planContent.match(titlePattern);
    
    if (titleMatch && titleMatch[1]) {
      return titleMatch[1].trim();
    }
    
    // Fallback: look for any first-level heading if TASK TITLE not found
    const firstHeadingPattern = /^#\s+([^#\n]+)/m;
    const headingMatch = planContent.match(firstHeadingPattern);
    
    if (headingMatch && headingMatch[1]) {
      return headingMatch[1].trim();
    }
    
    return '';
  };
  
  // Function to extract steps from a markdown plan
  const extractStepsFromPlan = (planContent: string): TaskStep[] => {
    const steps: TaskStep[] = [];
    
    // Find the Steps section in the plan
    const stepsSection = planContent.match(/## Steps\s*([\s\S]*?)(?=##|$)/);
    const stepsContent = stepsSection ? stepsSection[1] : planContent;
    
    // Look for numbered steps in the plan (1. Step name)
    const stepRegex = /^\s*(\d+)\.\s+(.+?)$/gm;
    let match;
    
    while ((match = stepRegex.exec(stepsContent)) !== null) {
      const stepNumber = match[1];
      const stepTitle = match[2].trim();
      
      // Determine status based on emojis or keywords
      let status: 'planned' | 'in-progress' | 'completed' | 'error' = 'planned';
      
      if (stepTitle.includes('✅') || stepTitle.includes('✓') || stepTitle.includes('done') || stepTitle.includes('complete')) {
        status = 'completed';
      } else if (stepTitle.includes('🔄') || stepTitle.includes('→') || stepTitle.includes('in progress') || stepTitle.includes('working')) {
        status = 'in-progress';
      } else if (stepTitle.includes('❌') || stepTitle.includes('✗') || stepTitle.includes('error') || stepTitle.includes('failed')) {
        status = 'error';
      }
      
      // Create a clean title without status emojis
      const cleanTitle = stepTitle
        .replace(/[\u2705\u2713\u{1F504}\u2192\u274C\u2717]/gu, '')
        .trim();
      
      steps.push({
        id: `step-${stepNumber}`,
        timestamp: new Date(),
        title: cleanTitle,
        description: cleanTitle,
        screenshot: '',
        status
      });
    }
    
    // If no steps found using the regex, try a more lenient approach
    if (steps.length === 0) {
      const simpleSplit = stepsContent.split('\n');
      let currentStep = 1;
      
      for (const line of simpleSplit) {
        const trimmedLine = line.trim();
        if (trimmedLine && !trimmedLine.startsWith('#') && /^\d+\./.test(trimmedLine)) {
          const stepText = trimmedLine.replace(/^\d+\.\s*/, '').trim();
          if (stepText) {
            steps.push({
              id: `step-${currentStep}`,
              timestamp: new Date(),
              title: stepText,
              description: stepText,
              screenshot: '',
              status: 'planned'
            });
            currentStep++;
          }
        }
      }
    }
    
    return steps.length > 0 ? steps : [
    {
      id: '1',
        timestamp: new Date(),
        title: 'Task Initialization',
        description: 'Setting up the task...',
        screenshot: '',
      status: 'in-progress'
      }
    ];
  };
  
  // Function to extract objective from plan content
  const extractObjectiveFromPlan = (planContent: string): string => {
    if (!planContent) return '';
    
    // Find the Objective section in the plan
    const objectiveRegex = /## Objective\s*([^#]*)/;
    const match = planContent.match(objectiveRegex);
    
    if (match && match[1]) {
      return match[1].trim();
    }
    
    return '';
  };
  
  // Wrap extractPlanFromMessages in useCallback to memoize it
  const extractPlanFromMessages = useCallback((messages: TaskMessage[]): string | null => {
    // Look for a markdown-formatted plan in the messages
    for (const message of messages) {
      if (message.role === 'assistant' && message.content) {
        // Look for the plan delimiters
        const planStartMarker = '$$Plan$$';
        const planEndMarker = '$PlanEnd$';
        
        const planStartIndex = message.content.indexOf(planStartMarker);
        const planEndIndex = message.content.indexOf(planEndMarker);
        
        console.log('Plan markers found:', {
          planStartMarker,
          planEndMarker,
          planStartIndex,
          planEndIndex,
          messageContent: message.content.substring(0, 50) + '...',
        });
        
        if (planStartIndex !== -1 && planEndIndex !== -1 && planEndIndex > planStartIndex) {
          // Extract the plan content between the markers
          const planContent = message.content.substring(
            planStartIndex + planStartMarker.length, 
            planEndIndex
          ).trim();
          
          console.log('Extracted plan content:', planContent.substring(0, 50) + '...');
          
          if (planContent) {
            // Update the task title based on the plan content
            const extractedTitle = extractTitleFromPlan(planContent);
            console.log('Extracted title:', extractedTitle);
            
            if (extractedTitle) {
              setTaskTitle(extractedTitle);
            }
            
            // Extract objective from the plan
            const extractedObjective = extractObjectiveFromPlan(planContent);
            setObjective(extractedObjective);
            
            // Return the plan content
            return planContent;
          }
        }
      }
    }
    
    return null;
  }, [setTaskTitle, setObjective]);
  
  // Function to fetch task data from the backend
  const fetchTaskData = useCallback(async (id: string) => {
    try {
      setIsLoadingTask(true);
      const response = await fetch(`/api/tasks/${id}`);
      
      if (!response.ok) {
        throw new Error(`Failed to fetch task: ${response.status}`);
      }
      
      const data = await response.json();
      
      if (data.success) {
        setTaskData(data.task);
        
        // Only set chat history if it's empty - this prevents overwriting existing messages
        if (chatHistory.length === 0) {
          // Convert API messages to our ChatMessage format
          const formattedMessages: ChatMessage[] = data.messages.map((msg: TaskMessage, index: number) => ({
            id: `${index}`,
            sender: msg.role === 'user' ? 'user' : 'agent',
            content: msg.content,
            timestamp: new Date(),
          }));
          
          setChatHistory(formattedMessages);
        }
        
        // Try to extract a plan from assistant messages
        const assistantMessages = data.messages.filter((msg: TaskMessage) => msg.role === 'assistant');
        if (assistantMessages.length > 0) {
          // Look for a markdown-formatted plan in the messages
          const planContent = extractPlanFromMessages(assistantMessages);
          if (planContent) {
            console.log("Task plan extracted successfully:", planContent.substring(0, 100) + "...");
            setPlan(planContent);
            
            // Extract objective from the plan
            const extractedObjective = extractObjectiveFromPlan(planContent);
            setObjective(extractedObjective);
            
            // Also try to extract steps from the plan
            const extractedSteps = extractStepsFromPlan(planContent);
            console.log("Steps extracted:", extractedSteps);
            
            if (extractedSteps.length > 0) {
              setPlanSteps(extractedSteps);
              // Don't make plan visible automatically - leave it closed by default
              // setIsPlanVisible(true); // Removed
            }
          } else {
            console.log("No plan found in assistant messages");
          }
        }
      }
    } catch (error) {
      console.error('Error fetching task data:', error);
    } finally {
      setIsLoadingTask(false);
    }
  }, [extractPlanFromMessages, chatHistory.length]);
  
  // Fetch task data if we have a taskId
  useEffect(() => {
    if (taskId && isExpanded) {
      // Only fetch task data if there are no messages in the chat
      // This prevents overwriting the existing conversation
      if (chatHistory.length === 0) {
        fetchTaskData(taskId);
      } else {
        // If we already have chat messages, just update the task metadata
        // without fetching the entire chat history
        const updateTaskMetadata = async () => {
          try {
            const response = await fetch(`/api/tasks/${taskId}`);
            if (response.ok) {
              const data = await response.json();
              if (data.success && data.task) {
                setTaskData(data.task);
                
                // We already have chat messages, so we don't update those
                // But we can still check for plan data if needed
                if (!plan || plan.trim() === '') {
                  const assistantMessages = data.messages
                    .filter((msg: TaskMessage) => msg.role === 'assistant');
                  
                  if (assistantMessages.length > 0) {
                    const planContent = extractPlanFromMessages(assistantMessages);
                    if (planContent) {
                      setPlan(planContent);
                      
                      const extractedSteps = extractStepsFromPlan(planContent);
                      if (extractedSteps.length > 0) {
                        setPlanSteps(extractedSteps);
                        // Don't set isPlanVisible to true automatically
                        // if (!isPlanVisible) {
                        //   setIsPlanVisible(true);
                        // }
                      }
                    }
                  }
                }
              }
            }
          } catch (error) {
            console.error('Error updating task metadata:', error);
          }
        };
        
        updateTaskMetadata();
      }
    }
  }, [taskId, isExpanded, fetchTaskData, chatHistory.length, plan, extractPlanFromMessages, isPlanVisible]);
  
  // Scroll to bottom of chat when messages change
  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [chatHistory]);
  
  useEffect(() => {
    if (isOpen) {
      document.body.classList.add('task-mode');
      
      // Add auto-focus on the input field when it opens
      setTimeout(() => {
        const inputElement = document.querySelector('.task-input') as HTMLInputElement;
        if (inputElement) {
          inputElement.focus();
        }
      }, 500); // Wait for animation to mostly complete
      
      // Add keyboard navigation
      const handleKeyDown = (e: KeyboardEvent) => {
        if (isExpanded) {
          if (e.key === 'ArrowLeft') {
            // Navigate to previous step
            setCurrentStepIndex(prevIndex => 
              prevIndex > 0 ? prevIndex - 1 : prevIndex
            );
          } else if (e.key === 'ArrowRight') {
            // Navigate to next step
            setCurrentStepIndex(prevIndex => 
              prevIndex < planSteps.length - 1 ? prevIndex + 1 : prevIndex
            );
          } else if (e.key === 'Escape') {
            // Close task system
            onClose();
          }
        }
      };
      
      window.addEventListener('keydown', handleKeyDown);
      
      // Clean up event listener
      return () => {
        window.removeEventListener('keydown', handleKeyDown);
      };
    } else {
      document.body.classList.remove('task-mode');
      // Reset state when closing
      setIsExpanded(false);
      setInputValue('');
      setFileAttachments([]);
    }
  }, [isOpen, isExpanded, planSteps.length, onClose]);
  
  // Handle submitting a message to the task chat
  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!inputValue.trim()) return;
    
    // Add user message to chat
    if (isExpanded) {
      const newMessage: ChatMessage = {
        id: Date.now().toString(),
        sender: 'user',
        content: inputValue,
        timestamp: new Date()
      };
      
      setChatHistory(prev => [...prev, newMessage]);
      
      // Add thinking message
      const thinkingMessage: ChatMessage = {
        id: Date.now().toString() + '-thinking',
        sender: 'agent',
        content: 'Thinking...',
        timestamp: new Date(),
        isThinking: true
      };
      
      setChatHistory(prev => [...prev, thinkingMessage]);
      
      // Send the message to the backend
      sendMessageToTaskChat(inputValue, thinkingMessage.id);
      
      // Clear input
      setInputValue('');
    } else {
      // Store the message content for later sending
      const messageContent = inputValue;
      
      // Create a new message
      const newMessage: ChatMessage = {
        id: Date.now().toString(),
        sender: 'user',
        content: messageContent,
        timestamp: new Date()
      };
      
      // First, expand the UI
      setIsExpanded(true);
      
      // Add the user message to chat history
      setChatHistory([newMessage]);
      
      // Clear input immediately for better UX
      setInputValue('');
      
      // DELAY THE API REQUEST - wait for UI to be fully loaded and rendered
      // Use a timeout to ensure the UI has fully rendered
      setTimeout(() => {
        console.log("UI fully loaded, now sending the initial message");
        
        // Add thinking message after UI is fully loaded
        const thinkingMessage: ChatMessage = {
          id: Date.now().toString() + '-thinking',
          sender: 'agent',
          content: 'Processing your request...',
          timestamp: new Date(),
          isThinking: true
        };
        
        setChatHistory(prev => [...prev, thinkingMessage]);
        
        // Now send the message to create a new task after UI is fully loaded
        sendMessageToTaskChat(messageContent, thinkingMessage.id, true);
      }, 2000); // Increased from 500ms to 1000ms to ensure UI is fully loaded
    }
  };
  
  // Function to send a message to the task chat API
  const sendMessageToTaskChat = async (message: string, thinkingMessageId: string, isNewTask = false) => {
    try {
      // Create a request object
      const requestBody: TaskChatRequest = {
        messages: [
          ...chatHistory.filter(msg => msg.sender === 'user' || msg.sender === 'agent')
            .map(msg => ({
              role: msg.sender === 'user' ? 'user' : 'assistant' as 'user' | 'assistant',
              content: msg.content
            })),
          { role: 'user' as 'user' | 'assistant', content: message }
        ],
        model: "gemini-2.5-flash-preview-04-17",
      };

      // If we have an existing task ID and this is not a new task request, include it
      if (taskId && !isNewTask) {
        requestBody.task_id = taskId;
      }

      // Set loading and streaming states
      setIsLoadingTask(isNewTask); // Only show loading for new tasks
      setIsStreaming(true);

      // Update thinking message to show we're connecting to the backend
      setChatHistory(prev => 
        prev.map(msg => 
          msg.id === thinkingMessageId 
            ? { ...msg, content: "Connecting to the backend...", isThinking: true } 
            : msg
        )
      );

      console.log("Sending message to task chat API:", message.substring(0, 50) + (message.length > 50 ? "..." : ""));
      
      // Make the fetch request to the backend API
      const response = await fetch('/api/tasks/chat', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(requestBody),
      });

      if (!response.ok) {
        throw new Error(`API returned ${response.status}: ${response.statusText}`);
      }

      console.log("Connection established, starting to read stream");
      
      // Now we can start reading from the response stream
      const reader = response.body?.getReader();
      if (!reader) {
        throw new Error('Failed to get reader from response');
      }

      const decoder = new TextDecoder();
      const chunks: string[] = [];
      let responseContent = '';
      let partialPlan = '';
      let isPlanStarted = false;
      let taskIdFromResponse: string | null = null;

      // Keep reading from the stream until it's done
      let updateTimeout: number | null = null;
      let lastUpdateTime = 0;
      const updateThrottle = 200; // Increased from 100ms to 200ms for fewer UI updates
      
      // Add debounce variables for plan updates
      let planUpdateTimeout: number | null = null;
      const planUpdateThrottle = 500; // Only update plan-related UI every 500ms
      let lastPlanUpdateTime = 0;
      
      // Add buffer for incomplete SSE data
      let buffer = '';
      
      console.log("Starting to read stream chunks...");
      
      while (true) {
        const { value, done } = await reader.read();
        
        if (done) {
          console.log("Stream reading complete");
          break;
        }
        
        // Decode the chunk and add it to our buffer
        const rawChunk = decoder.decode(value, { stream: true });
        console.log(`Raw chunk received: ${rawChunk.length} chars`);
        
        // Append to buffer for proper SSE parsing
        buffer += rawChunk;
        
        // Process complete SSE messages from buffer
        while (buffer.includes('\n\n')) {
          const endOfMessage = buffer.indexOf('\n\n');
          const message = buffer.substring(0, endOfMessage);
          buffer = buffer.substring(endOfMessage + 2);
          
          if (message.startsWith('data: ')) {
            const data = message.substring(6);
            console.log(`Processing SSE message: ${data.substring(0, 20)}... (${data.length} chars)`);
            
            // Check if it's a JSON object
            try {
              const jsonData = JSON.parse(data);
              
              // Check if this is a task ID message
              if (jsonData.task_id) {
                taskIdFromResponse = jsonData.task_id;
                setTaskId(jsonData.task_id);
                console.log(`Received task ID: ${jsonData.task_id}`);
                continue; // Skip to next message
              }
              
              // If it's the done message, we can break out of the loop
              if (jsonData.done) {
                console.log("Received done signal");
                break;
              }

              // Handle heartbeat messages to maintain connection
              if (jsonData.heartbeat) {
                console.log(`Received heartbeat at ${new Date().toISOString()}`);
                continue; // Skip to next message
              }

              // If it's an error message, handle it
              if (jsonData.error) {
                throw new Error(jsonData.error);
              }
              
              console.log("Skipping JSON control message");
              continue; // Skip to next message if we got a JSON object
            } catch (e) {
              // Not JSON data, so it's actual content
              // Log the parse error for debugging purposes
              console.log(`Not JSON data (parse error: ${e instanceof Error ? e.message : "unknown error"})`);
              // CRITICAL FIX: Preserve the exact data string without modification
              console.log(`Content chunk: ${data.substring(0, 20)}... (${data.length} chars)`);
              chunks.push(data);
              
              // When reconstructing the full content, join with proper newlines
              // This is crucial for preserving the markdown format
              responseContent = chunks.join('');
              
              console.log(`Total accumulated length: ${responseContent.length} chars`);
              
              // Check for plan delimiters in the current accumulated response
              const planStartIndex = responseContent.indexOf('$$Plan$$');
              const planEndIndex = responseContent.indexOf('$PlanEnd$');
              
              // If we see the start of a plan and haven't processed it yet
              if (planStartIndex !== -1 && !isPlanStarted) {
                isPlanStarted = true;
                partialPlan = responseContent.substring(planStartIndex + '$$Plan$$'.length);
                
                // Extract and set the partial plan - use debounce for plan updates
                if (partialPlan.trim()) {
                  if (planUpdateTimeout) {
                    clearTimeout(planUpdateTimeout);
                  }
                  
                  const now = Date.now();
                  if (now - lastPlanUpdateTime > planUpdateThrottle) {
                    // Update immediately if enough time has passed
                    setPlan(partialPlan);
                    
                    // Extract objective from the plan
                    const extractedObjective = extractObjectiveFromPlan(partialPlan);
                    setObjective(extractedObjective);
                    
                    // Extract title from the plan
                    const extractedTitle = extractTitleFromPlan(partialPlan);
                    if (extractedTitle) {
                      setTaskTitle(extractedTitle);
                    }
                    
                    // Try to extract steps, even if the plan is partial
                    const extractedSteps = extractStepsFromPlan(partialPlan);
                    if (extractedSteps.length > 0) {
                      setPlanSteps(extractedSteps);
                      // Don't set isPlanVisible to true automatically
                      // if (!isPlanVisible) {
                      //   setIsPlanVisible(true); // Make plan visible automatically
                      // }
                    }
                    
                    lastPlanUpdateTime = now;
                  } else {
                    // Schedule a throttled update
                    planUpdateTimeout = setTimeout(() => {
                      setPlan(partialPlan);
                      
                      // Extract objective from the plan
                      const extractedObjective = extractObjectiveFromPlan(partialPlan);
                      setObjective(extractedObjective);
                      
                      // Extract title from the plan
                      const extractedTitle = extractTitleFromPlan(partialPlan);
                      if (extractedTitle) {
                        setTaskTitle(extractedTitle);
                      }
                      
                      // Try to extract steps, even if the plan is partial
                      const extractedSteps = extractStepsFromPlan(partialPlan);
                      if (extractedSteps.length > 0) {
                        setPlanSteps(extractedSteps);
                        // Don't set isPlanVisible to true automatically
                        // if (!isPlanVisible) {
                        //   setIsPlanVisible(true); // Make plan visible automatically
                        // }
                      }
                      
                      lastPlanUpdateTime = Date.now();
                    }, planUpdateThrottle);
                  }
                }
              } 
              // If we're in the middle of a plan and receiving more chunks
              else if (isPlanStarted && planEndIndex === -1) {
                partialPlan = responseContent.substring(responseContent.indexOf('$$Plan$$') + '$$Plan$$'.length);
                
                // Update the plan as more content comes in - use debounce for plan updates
                if (partialPlan.trim()) {
                  if (planUpdateTimeout) {
                    clearTimeout(planUpdateTimeout);
                  }
                  
                  const now = Date.now();
                  if (now - lastPlanUpdateTime > planUpdateThrottle) {
                    // Update immediately if enough time has passed
                    setPlan(partialPlan);
                    
                    // Extract objective from the plan
                    const extractedObjective = extractObjectiveFromPlan(partialPlan);
                    setObjective(extractedObjective);
                    
                    // Extract title from the updated plan
                    const extractedTitle = extractTitleFromPlan(partialPlan);
                    if (extractedTitle) {
                      setTaskTitle(extractedTitle);
                    }
                    
                    // Try to extract steps from partial plan
                    const extractedSteps = extractStepsFromPlan(partialPlan);
                    if (extractedSteps.length > 0) {
                      setPlanSteps(extractedSteps);
                      // Don't set isPlanVisible to true automatically
                      // if (!isPlanVisible) {
                      //   setIsPlanVisible(true); // Make plan visible automatically
                      // }
                    }
                    
                    lastPlanUpdateTime = now;
                  } else {
                    // Schedule a throttled update
                    planUpdateTimeout = setTimeout(() => {
                      setPlan(partialPlan);
                      
                      // Extract objective from the plan
                      const extractedObjective = extractObjectiveFromPlan(partialPlan);
                      setObjective(extractedObjective);
                      
                      // Extract title from the updated plan
                      const extractedTitle = extractTitleFromPlan(partialPlan);
                      if (extractedTitle) {
                        setTaskTitle(extractedTitle);
                      }
                      
                      // Try to extract steps from partial plan
                      const extractedSteps = extractStepsFromPlan(partialPlan);
                      if (extractedSteps.length > 0) {
                        setPlanSteps(extractedSteps);
                        // Don't set isPlanVisible to true automatically
                        // if (!isPlanVisible) {
                        //   setIsPlanVisible(true); // Make plan visible automatically
                        // }
                      }
                      
                      lastPlanUpdateTime = Date.now();
                    }, planUpdateThrottle);
                  }
                }
              }
              // If we've received the end of the plan
              else if (isPlanStarted && planEndIndex !== -1) {
                isPlanStarted = false;
                const completePlan = responseContent.substring(
                  responseContent.indexOf('$$Plan$$') + '$$Plan$$'.length,
                  planEndIndex
                );
                
                // Set the complete plan
                if (completePlan.trim()) {
                  setPlan(completePlan);
                  
                  // Extract objective from the complete plan
                  const extractedObjective = extractObjectiveFromPlan(completePlan);
                  setObjective(extractedObjective);
                  
                  // Extract title from the complete plan
                  const extractedTitle = extractTitleFromPlan(completePlan);
                  if (extractedTitle) {
                    setTaskTitle(extractedTitle);
                  }
                  
                  // Extract steps from complete plan
                  const extractedSteps = extractStepsFromPlan(completePlan);
                  if (extractedSteps.length > 0) {
                    setPlanSteps(extractedSteps);
                    // Don't set isPlanVisible to true automatically
                    // if (!isPlanVisible) {
                    //   setIsPlanVisible(true); // Make plan visible automatically
                    // }
                  }
                }
              }
              
              // Throttle UI updates during streaming for better performance
              const now = Date.now();
              if (now - lastUpdateTime > updateThrottle) {
                // Update the message in real-time with the streaming content
                if (updateTimeout) {
                  clearTimeout(updateTimeout);
                }
                
                // Update immediately if enough time has passed
                setChatHistory(prev => 
                  prev.map(msg => 
                    msg.id === thinkingMessageId 
                      ? { ...msg, content: responseContent, isThinking: false } 
                      : msg
                  )
                );
                lastUpdateTime = now;
              } else {
                // Schedule a throttled update
                if (updateTimeout) {
                  clearTimeout(updateTimeout);
                }
                updateTimeout = setTimeout(() => {
                  // Make sure we're using the latest response content with newlines preserved
                  const latestContent = chunks.join('');
                  setChatHistory(prev => 
                    prev.map(msg => 
                      msg.id === thinkingMessageId 
                        ? { ...msg, content: latestContent, isThinking: false } 
                        : msg
                    )
                  );
                  lastUpdateTime = Date.now();
                }, updateThrottle);
              }
            }
          }
        }
      }

      // Final update with the complete response
      // IMPORTANT FIX: Properly join the chunks to preserve the response format
      let finalMessageContent = chunks.join('');
      console.log(`Final message content length: ${finalMessageContent.length} characters`);
      
      // Clear any pending timeouts to prevent late updates
      if (updateTimeout) {
        clearTimeout(updateTimeout);
        updateTimeout = null;
      }
      
      if (planUpdateTimeout) {
        clearTimeout(planUpdateTimeout);
        planUpdateTimeout = null;
      }
      
      // Add a small delay before applying final updates
      // This helps ensure the UI doesn't refresh too quickly after streaming is complete
      await new Promise(resolve => setTimeout(resolve, 800));
      
      // Force a final decoder flush to ensure we get all data
      if (chunks.length > 0) {
        console.log("Applying final message update to chat");
        
        // IMPORTANT: Update only the thinking message, not the entire chat history
        // Use the complete final message content
        setChatHistory(prev => 
          prev.map(msg => 
            msg.id === thinkingMessageId 
              ? { ...msg, content: finalMessageContent, isThinking: false } 
              : msg
          )
        );
        
        // IMPROVED: Always verify with server for all messages, not just new tasks
        try {
          console.log(`Verifying message completeness with server for task ID: ${taskId || taskIdFromResponse}`);
          const verifyTaskId = taskId || taskIdFromResponse;
          
          if (verifyTaskId) {
            const verifyResponse = await fetch(`/api/tasks/${verifyTaskId}`);
            if (verifyResponse.ok) {
              const verifyData = await verifyResponse.json();
              if (verifyData.success && verifyData.messages) {
                // Find the assistant message that should match our streamed content
                const assistantMessages = verifyData.messages.filter(
                  (msg: TaskMessage) => msg.role === 'assistant'
                );
                
                // For non-first messages, we need to match the most recent assistant message
                // that corresponds to the current thinking message
                let messageIndex = -1;
                
                // Get the index of the thinking message in our chat history
                const thinkingMsgIndex = chatHistory.findIndex(msg => msg.id === thinkingMessageId);
                
                if (thinkingMsgIndex !== -1) {
                  // Count how many assistant messages came before this one
                  const previousAssistantCount = chatHistory
                    .slice(0, thinkingMsgIndex)
                    .filter(msg => msg.sender === 'agent')
                    .length;
                  
                  // We need the corresponding message from the server
                  if (assistantMessages.length > previousAssistantCount) {
                    messageIndex = previousAssistantCount;
                  }
                }
                
                // If we couldn't determine the index, use the last message
                if (messageIndex === -1 && assistantMessages.length > 0) {
                  messageIndex = assistantMessages.length - 1;
                }
                
                if (messageIndex !== -1 && assistantMessages[messageIndex]) {
                  const serverMessage = assistantMessages[messageIndex].content;
                  
                  console.log("Server message sample: ", serverMessage.substring(0, 100) + "...");
                  console.log("Client message sample: ", finalMessageContent.substring(0, 100) + "...");
                  console.log(`Server message length: ${serverMessage.length}, Client message length: ${finalMessageContent.length}`);
                  
                  // If server message is longer or different than what we have, use the server's complete version
                  if (serverMessage.length > finalMessageContent.length || 
                      serverMessage.trim() !== finalMessageContent.trim()) {
                    console.log(`Message verification detected differences. Using server version.`);
                    
                    // IMPORTANT: Ensure the server message preserves its formatting
                    setChatHistory(prev => 
                      prev.map(msg => 
                        msg.id === thinkingMessageId 
                          ? { ...msg, content: serverMessage, isThinking: false } 
                          : msg
                      )
                    );
                    
                    // Update finalMessageContent to use the complete server version
                    finalMessageContent = serverMessage;
                  } else {
                    console.log("Streamed message matches server version, no update needed");
                  }
                }
                
                // Also update task data
                if (verifyData.task) {
                  setTaskData(verifyData.task);
                }
              }
            }
          }
        } catch (error) {
          console.error("Error verifying complete message:", error);
        }
      } else {
        console.warn("No chunks received during streaming");
      }
      
      // Extract plan if it hasn't been extracted during streaming
      const planStartIndex = finalMessageContent.indexOf('$$Plan$$');
      const planEndIndex = finalMessageContent.indexOf('$PlanEnd$');
      
      if (planStartIndex !== -1 && planEndIndex !== -1 && planStartIndex < planEndIndex) {
        // Extract the plan content between the delimiters
        const completePlan = finalMessageContent.substring(planStartIndex + '$$Plan$$'.length, planEndIndex).trim();
        
        if (completePlan) {
          setPlan(completePlan);
          
          // Extract objective from the complete plan
          const extractedObjective = extractObjectiveFromPlan(completePlan);
          setObjective(extractedObjective);
          
          // Extract title from the complete plan
          const extractedTitle = extractTitleFromPlan(completePlan);
          if (extractedTitle) {
            setTaskTitle(extractedTitle);
          }
          
          // Extract steps from the plan
          const steps = extractStepsFromPlan(completePlan);
          if (steps.length > 0) {
            setPlanSteps(steps);
          }
        }
      } else if (!plan || plan.trim() === '') {
        // Only use fallback if no plan has been extracted during streaming
        const planContent = extractPlanFromMessages([
          ...requestBody.messages.map(msg => ({
            role: msg.role,
            content: msg.content
          })),
          { role: 'assistant', content: finalMessageContent }
        ]);
        
        if (planContent) {
          // Set the plan
          setPlan(planContent);
          
          // Extract objective from the plan
          const extractedObjective = extractObjectiveFromPlan(planContent);
          setObjective(extractedObjective);
          
          // Extract title
          const extractedTitle = extractTitleFromPlan(planContent);
          if (extractedTitle) {
            setTaskTitle(extractedTitle);
          }
          
          // Extract steps
          const steps = extractStepsFromPlan(planContent);
          if (steps.length > 0) {
            setPlanSteps(steps);
          }
        }
      }

      // Reset states
      setIsLoadingTask(false);
      setIsStreaming(false);
      
      // Scroll to the bottom of the chat
      setTimeout(() => {
        chatEndRef.current?.scrollIntoView({ behavior: 'smooth' });
      }, 100);

    } catch (error) {
      console.error('Error sending message to task chat:', error);
      
      // Update the thinking message to show the error
      setChatHistory(prev => 
        prev.map(msg => 
          msg.id === thinkingMessageId 
            ? { ...msg, content: `Error: ${error instanceof Error ? error.message : 'Unknown error occurred'}`, isThinking: false } 
            : msg
        )
      );
      
      // Reset states
      setIsLoadingTask(false);
      setIsStreaming(false);
    }
  };
  
  const handleFileInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files) {
      const newFiles = Array.from(e.target.files);
      setFileAttachments(prevFiles => [...prevFiles, ...newFiles]);
    }
  };
  
  const handleRemoveFile = (index: number) => {
    setFileAttachments(prevFiles => prevFiles.filter((_, i) => i !== index));
  };
  
  const triggerFileInput = () => {
    fileInputRef.current?.click();
  };
  
  const toggleSidebar = () => {
    setSidebarCollapsed(prev => !prev);
    // Remove focus from the button to eliminate the blue outline
    if (document.activeElement instanceof HTMLElement) {
      document.activeElement.blur();
    }
  };
  
  // Updated to close screenshot panel when plan panel is opened
  const togglePlanView = () => {
    if (!isPlanVisible) {
      // Opening plan view, close screenshot view if open
      setIsPlanVisible(true);
      setIsScreenshotVisible(false);
    } else {
      // Just toggle off if already visible
      setIsPlanVisible(false);
    }
    // Remove focus from the button to eliminate the blue outline
    if (document.activeElement instanceof HTMLElement) {
      document.activeElement.blur();
    }
  };
  
  // New handler for screenshot/timeline panel
  const toggleScreenshotView = () => {
    if (!isScreenshotVisible) {
      // Opening screenshot view, close plan view if open
      setIsScreenshotVisible(true);
      setIsPlanVisible(false);
    } else {
      // Just toggle off if already visible
      setIsScreenshotVisible(false);
    }
    // Remove focus from the button to eliminate the blue outline
    if (document.activeElement instanceof HTMLElement) {
      document.activeElement.blur();
    }
  };
  
  // Format chat messages with step indicators and thinking state
  const formatChatMessage = (message: ChatMessage) => {
    let relatedStep = null;
    if (message.relatedStepId) {
      relatedStep = planSteps.find(step => step.id === message.relatedStepId);
    }
    
    return (
      <div key={message.id} className={`chat-message ${message.sender === 'user' ? 'chat-message-user' : 'chat-message-ai'} ${message.isThinking ? 'thinking-message' : ''}`}>
        {message.sender === 'agent' && (
          <div className="chat-avatar">
            <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <rect x="3" y="11" width="18" height="11" rx="2" ry="2"></rect>
              <path d="M7 11V7a5 5 0 0 1 10 0v4"></path>
            </svg>
          </div>
        )}
        
        <div className="chat-message-content">
          {relatedStep && (
            <div className={`chat-step-indicator ${relatedStep.status}`}>
              {relatedStep.title}
            </div>
          )}
          
          <div className="chat-message-text">
            {message.isThinking ? (
              <div className="typing-indicator">
                <span></span><span></span><span></span>
              </div>
            ) : (
              // Use pre-wrap to preserve whitespace and newlines in the content
              <div style={{ whiteSpace: 'pre-wrap' }}>
                {message.content}
              </div>
            )}
          </div>
          
          <div className="chat-message-timestamp">
            {message.timestamp.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
          </div>
        </div>
      </div>
    );
  };
  
  // Calculate progress percentage
  const calculateProgress = () => {
    if (!planSteps || planSteps.length === 0) return 0;
    
    const completedSteps = planSteps.filter(step => step.status === 'completed').length;
    return Math.round((completedSteps / planSteps.length) * 100);
  };
  
  // Calculate the journey progress for the gradient
  const journeyProgress = `${(currentStepIndex / (planSteps.length - 1)) * 100}%`;
  
  // Find the renderMessages function that uses formatChatMessage and update it
  const renderMessages = () => {
    if (chatHistory.length === 0) {
      return (
        <div className="empty-chat-message">
          <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"></path>
          </svg>
          <h3>Start a new task</h3>
          <p>Enter a task description in the input box below to begin.</p>
        </div>
      );
    }
    
    return (
      <>
        {chatHistory.map(message => formatChatMessage(message))}
        <div ref={chatEndRef} />
      </>
    );
  };
  
  if (!isOpen) return null;
  
  return (
    <div className={`task-system-container ${isExpanded ? 'expanded' : ''}`}>
      <div className="task-overlay" onClick={() => !isExpanded && onClose()}></div>
      
      {!isExpanded ? (
        <div className="task-input-panel">
          <h3 className="task-input-title">New Task</h3>
          <p className="task-input-help">
            Describe what you'd like me to do. Tasks can involve web browsing, code execution, 
            GUI automation, data processing, file management, research, or content creation.
          </p>
          <form className="chat-input-container" onSubmit={handleSubmit}>
            <div className="task-input-container">
              <input
                type="text"
                value={inputValue}
                onChange={(e) => setInputValue(e.target.value)}
                placeholder={isStreaming ? "AI is responding..." : "Message the agent..."}
                className={`task-input ${isStreaming ? 'streaming' : ''}`}
                disabled={isStreaming}
              />
              <div className="task-input-actions">
                <button 
                  type="button" 
                  className="attach-button"
                  onClick={triggerFileInput}
                  title="Attach files"
                  disabled={isStreaming}
                >
                  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
                    <path d="M21.44 11.05L12.25 20.24C11.1242 21.3658 9.58718 21.9983 8.00505 21.9983C6.42291 21.9983 4.88589 21.3658 3.76005 20.24C2.63421 19.1141 2.00171 17.5771 2.00171 15.995C2.00171 14.4128 2.63421 12.8758 3.76005 11.75L12.33 3.18C13.0806 2.42949 14.0998 2.00098 15.165 2.00098C16.2302 2.00098 17.2494 2.42949 18 3.18C18.7505 3.93051 19.179 4.94975 19.179 6.015C19.179 7.08025 18.7505 8.09949 18 8.85L9.41 17.44C9.03472 17.8153 8.52644 18.0246 7.9975 18.0246C7.46855 18.0246 6.96028 17.8153 6.585 17.44C6.20972 17.0647 6.00038 16.5564 6.00038 16.0275C6.00038 15.4985 6.20972 14.9903 6.585 14.615L14.5 6.7" 
                    stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
                  </svg>
                </button>
                <input
                  type="file"
                  multiple
                  ref={fileInputRef}
                  onChange={handleFileInputChange}
                  style={{ display: 'none' }}
                  disabled={isStreaming}
                />
                <button 
                  type="submit" 
                  className={`send-button ${isStreaming ? 'streaming' : ''}`} 
                  title={isStreaming ? "AI is responding..." : "Send message"}
                  disabled={isStreaming}
                >
                  {isStreaming ? (
                    <div className="streaming-dots">
                      <span></span><span></span><span></span>
                    </div>
                  ) : (
                  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
                    <path d="M22 2L11 13" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
                    <path d="M22 2L15 22L11 13L2 9L22 2Z" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
                  </svg>
                  )}
                </button>
              </div>
            </div>
            
            {fileAttachments.length > 0 && (
              <div className="file-attachments">
                {fileAttachments.map((file, index) => (
                  <div key={index} className="file-attachment">
                    <span className="file-name">{file.name}</span>
                    <button
                      type="button"
                      onClick={() => handleRemoveFile(index)}
                      className="remove-file"
                    >
                      ×
                    </button>
                  </div>
                ))}
              </div>
            )}
          </form>
        </div>
      ) : (
        <div className="task-expanded-view">
          {/* Header with task title and controls */}
          <div className="task-header">
            <h2>
              {isLoadingTask ? (
                <span className="loading-indicator">Loading task...</span>
              ) : (
                <>{taskTitle || taskData?.title || (chatHistory.length === 0 ? "New Task" : inputValue || "Task")}</>
              )}
              {taskData && (
                <span className="task-metadata">
                  {new Date(taskData.created_at).toLocaleDateString()} • {taskData.model}
                </span>
              )}
            </h2>
            <div className="task-header-actions">
              <button className="close-button" onClick={onClose}>
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
                  <path d="M18 6L6 18" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
                  <path d="M6 6L18 18" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
                </svg>
              </button>
            </div>
          </div>
          
          <div className="task-integrated-content">
            {/* Collapsible sidebar for plan */}
            <div className={`task-plan-sidebar ${sidebarCollapsed ? 'collapsed' : ''}`}>
              <div className="task-plan-header">
                <h3>
                  <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path>
                    <polyline points="14 2 14 8 20 8"></polyline>
                    <line x1="16" y1="13" x2="8" y2="13"></line>
                    <line x1="16" y1="17" x2="8" y2="17"></line>
                    <polyline points="10 9 9 9 8 9"></polyline>
                  </svg>
                  Task Info
                </h3>
                <button className="collapse-button" onClick={toggleSidebar}>
                  {sidebarCollapsed ? (
                    <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <polyline points="13 17 18 12 13 7"></polyline>
                      <polyline points="6 17 11 12 6 7"></polyline>
                    </svg>
                  ) : (
                    <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <polyline points="11 17 6 12 11 7"></polyline>
                      <polyline points="18 17 13 12 18 7"></polyline>
                    </svg>
                  )}
                </button>
              </div>
              
              <div className="plan-content">
                {sidebarCollapsed ? (
                  <div className="step-indicators">
                    {planSteps.map((step, index) => (
                      <div 
                        key={step.id}
                        className={`step-indicator ${step.status}`}
                        onClick={() => setCurrentStepIndex(index)}
                        title={step.title}
                      >
                        {index + 1}
                      </div>
                    ))}
                  </div>
                ) : (
                  <div className="task-info-container">
                    {objective && (
                      <div className="objective-section">
                        <h4 className="info-section-title">
                          <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                            <circle cx="12" cy="12" r="10"></circle>
                            <line x1="12" y1="8" x2="12" y2="16"></line>
                            <line x1="8" y1="12" x2="16" y2="12"></line>
                          </svg>
                          Objective
                        </h4>
                        <div className="objective-content">
                          <p>{objective}</p>
                        </div>
                      </div>
                    )}
                    
                    {/* We could add additional sections here like attached files, URLs, etc. */}
                  </div>
                )}
              </div>
            </div>
            
            {/* Main content area */}
            <div className="task-main-area">
              <div className="task-chat-container">
                {/* New control icons for panels */}
                <div className="panel-controls">
                  <button 
                    className={`panel-toggle ${isPlanVisible ? 'active' : ''}`}
                    onClick={togglePlanView}
                    title="Task Steps"
                  >
                    <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <rect x="3" y="3" width="18" height="18" rx="2" />
                      <path d="M9 3v18" />
                      <path d="M14 8h.01" />
                      <path d="M14 12h.01" />
                      <path d="M14 16h.01" />
                    </svg>
                    Steps
                  </button>
                  <button 
                    className={`panel-toggle ${isScreenshotVisible ? 'active' : ''}`}
                    onClick={toggleScreenshotView}
                    title="Timeline"
                  >
                    <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <rect x="3" y="3" width="18" height="18" rx="2" />
                      <circle cx="8.5" cy="8.5" r="1.5"/>
                      <polyline points="21 15 16 10 5 21"/>
                    </svg>
                    Timeline
                  </button>
                </div>
                
                {/* Task Journey Panel - Shown when toggled */}
                {isPlanVisible && (
                  <div className="dropdown-panel journey-panel" style={{ userSelect: 'none' }}>
                    <div className="panel-header">
                      <h3>
                        <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                          <path d="M4 15s1-1 4-1 5 2 8 2 4-1 4-1V3s-1 1-4 1-5-2-8-2-4 1-4 1z"></path>
                          <line x1="4" y1="22" x2="4" y2="15"></line>
                        </svg>
                        Task Steps
                      </h3>
                      <button className="panel-close" onClick={togglePlanView} title="Close panel">
                        X
                      </button>
                    </div>
                    
                    <div className="journey-path">
                      <div 
                        className="journey-path-line" 
                        style={{ '--journey-progress': journeyProgress } as React.CSSProperties}
                      ></div>
                      <div className="journey-nodes">
                        {planSteps.map((step, index) => (
                          <div 
                            key={step.id}
                            className="journey-node"
                          >
                            <div className={`node-indicator ${step.status}`}>
                              {index + 1}
                              <div className={`node-status ${step.status}`}>
                                {step.status === 'completed' && '✓ Completed'}
                                {step.status === 'in-progress' && '► In Progress'}
                                {step.status === 'error' && '✗ Error'}
                                {step.status === 'planned' && '○ Planned'}
                              </div>
                            </div>
                            <div className="node-label">{step.title}</div>
                            <div className="node-details">
                              <p>{step.description}</p>
                            </div>
                          </div>
                        ))}
                      </div>
                    </div>
                    
                    <div className="plan-summary">
                      <h4>Task Plan Progress</h4>
                      <div className="plan-progress">
                        <div className="progress-bar-container">
                          <div 
                            className="progress-bar" 
                            style={{ width: `${calculateProgress()}%` }}
                          ></div>
                        </div>
                        <div className="progress-text">
                          {calculateProgress()}% Complete
                        </div>
                      </div>
                    </div>
                  </div>
                )}
                
                {/* Timeline Panel with Screenshots - Shown when toggled */}
                {isScreenshotVisible && (
                  <div className="dropdown-panel screenshot-panel">
                    <div className="panel-header">
                      <h3>
                        <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                          <rect x="3" y="3" width="18" height="18" rx="2" ry="2"/>
                          <circle cx="8.5" cy="8.5" r="1.5"/>
                          <polyline points="21 15 16 10 5 21"/>
                        </svg>
                        Timeline
                        <div className="tv-screen-status-badge">
                          {planSteps[currentStepIndex]?.status === 'completed' && 'Completed'}
                          {planSteps[currentStepIndex]?.status === 'in-progress' && 'In Progress'}
                          {planSteps[currentStepIndex]?.status === 'planned' && 'Planned'}
                          {planSteps[currentStepIndex]?.status === 'error' && 'Error'}
                        </div>
                      </h3>
                      <button className="panel-close" onClick={toggleScreenshotView} title="Close panel">
                        X
                      </button>
                    </div>
                    
                    <div className="tv-screen-container">
                      <div className="tv-screen-content">
                        {planSteps[currentStepIndex]?.screenshot ? (
                          <img 
                            src={planSteps[currentStepIndex].screenshot} 
                            alt={planSteps[currentStepIndex].title} 
                            className="tv-screen-image"
                          />
                        ) : (
                          <div className="tv-content-placeholder">
                            <svg xmlns="http://www.w3.org/2000/svg" width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1" strokeLinecap="round" strokeLinejoin="round">
                              <rect x="3" y="3" width="18" height="18" rx="2" ry="2"/>
                              <circle cx="8.5" cy="8.5" r="1.5"/>
                              <polyline points="21 15 16 10 5 21"/>
                            </svg>
                            <p>No screenshot available for this step</p>
                          </div>
                        )}
                      </div>
                    </div>
                    
                    {/* Add the timeline component directly below the screenshot */}
                    <div className="timeline-container">
                      <div className="task-timeline-slider-container">
                        <input 
                          type="range" 
                          min="0" 
                          max={planSteps.length - 1} 
                          value={currentStepIndex} 
                          onChange={(e) => setCurrentStepIndex(parseInt(e.target.value))}
                          className="task-timeline-slider"
                          aria-label="Timeline Progress"
                        />
                        
                        {/* Hide the markers by setting display: none */}
                        <div className="task-timeline-markers" style={{ display: 'none' }}>
                          {planSteps.map((step, index) => (
                            <div 
                              key={`marker-${step.id}`} 
                              className={`task-timeline-marker ${step.status}`}
                              style={{ left: `${(index / (planSteps.length - 1)) * 100}%` }}
                              onClick={() => setCurrentStepIndex(index)}
                              title={step.title}
                            >
                              <div className="marker-tooltip">{step.title}</div>
                            </div>
                          ))}
                        </div>
                      </div>
                      
                      <div className="timeline-controls">
                        <button 
                          className="timeline-nav-button"
                          onClick={() => {
                            setCurrentStepIndex(Math.max(0, currentStepIndex - 1));
                            // Remove focus from the button after clicking
                            if (document.activeElement instanceof HTMLElement) {
                              document.activeElement.blur();
                            }
                          }}
                          disabled={currentStepIndex === 0}
                        >
                          Previous
                        </button>
                        <span style={{ 
                          display: 'inline-block', 
                          textAlign: 'center',
                          fontSize: '14px',
                          color: '#666',
                          margin: '0 10px'
                        }}>
                          Step {currentStepIndex + 1}/{planSteps.length}
                        </span>
                        <button 
                          className="timeline-nav-button"
                          onClick={() => {
                            setCurrentStepIndex(Math.min(planSteps.length - 1, currentStepIndex + 1));
                            // Remove focus from the button after clicking
                            if (document.activeElement instanceof HTMLElement) {
                              document.activeElement.blur();
                            }
                          }}
                          disabled={currentStepIndex === planSteps.length - 1}
                        >
                          Next
                        </button>
                      </div>
                    </div>
                  </div>
                )}
                
                {/* Chat Messages Container */}
                <div className="chat-messages-container">
                  <div className="chat-messages">
                    {renderMessages()}
                  </div>
                </div>
                
                {/* Chat input component at the bottom */}
                <form className="chat-input-container" onSubmit={handleSubmit}>
                  <div className="task-input-container">
                    <input
                      type="text"
                      value={inputValue}
                      onChange={(e) => setInputValue(e.target.value)}
                      placeholder={isStreaming ? "AI is responding..." : "Message the agent..."}
                      className={`task-input ${isStreaming ? 'streaming' : ''}`}
                      disabled={isStreaming}
                    />
                    <div className="task-input-actions">
                      <button 
                        type="button" 
                        className="attach-button"
                        onClick={triggerFileInput}
                        title="Attach files"
                        disabled={isStreaming}
                      >
                        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
                          <path d="M21.44 11.05L12.25 20.24C11.1242 21.3658 9.58718 21.9983 8.00505 21.9983C6.42291 21.9983 4.88589 21.3658 3.76005 20.24C2.63421 19.1141 2.00171 17.5771 2.00171 15.995C2.00171 14.4128 2.63421 12.8758 3.76005 11.75L12.33 3.18C13.0806 2.42949 14.0998 2.00098 15.165 2.00098C16.2302 2.00098 17.2494 2.42949 18 3.18C18.7505 3.93051 19.179 4.94975 19.179 6.015C19.179 7.08025 18.7505 8.09949 18 8.85L9.41 17.44C9.03472 17.8153 8.52644 18.0246 7.9975 18.0246C7.46855 18.0246 6.96028 17.8153 6.585 17.44C6.20972 17.0647 6.00038 16.5564 6.00038 16.0275C6.00038 15.4985 6.20972 14.9903 6.585 14.615L14.5 6.7" 
                        stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
                        </svg>
                      </button>
                      <input
                        type="file"
                        multiple
                        ref={fileInputRef}
                        onChange={handleFileInputChange}
                        style={{ display: 'none' }}
                        disabled={isStreaming}
                      />
                      <button 
                        type="submit" 
                        className={`send-button ${isStreaming ? 'streaming' : ''}`} 
                        title={isStreaming ? "AI is responding..." : "Send message"}
                        disabled={isStreaming}
                      >
                        {isStreaming ? (
                          <div className="streaming-dots">
                            <span></span><span></span><span></span>
                          </div>
                        ) : (
                        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
                          <path d="M22 2L11 13" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
                          <path d="M22 2L15 22L11 13L2 9L22 2Z" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
                        </svg>
                        )}
                      </button>
                    </div>
                  </div>
                </form>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

export default TaskSystem; 