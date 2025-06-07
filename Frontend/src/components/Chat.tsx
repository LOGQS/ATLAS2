import React, { useState, useRef, useEffect, ChangeEvent, useCallback } from 'react';
import Message from './Message';
import SummaryModal from './SummaryModal';
import chatManager, { generateChatId } from '../utils/chatManager';
import ImageAnnotationModal from './ImageAnnotationModal';

interface FileAttachment {
  file_id: string;
  file_type: 'image' | 'video' | 'audio' | 'document';
  mime_type: string;
  filename: string;
  original_name: string;
  // For local UI state
  uploading?: boolean;
  upload_progress?: number;
  local_url?: string;
  upload_error?: string;
  processing?: boolean;
  needs_processing?: boolean;
  size?: number;
  is_large_file?: boolean;
  state?: string;
}

interface ChatMessage {
  role: 'user' | 'assistant' | 'system';
  content: string;
  attachments?: FileAttachment[];
  isHistory?: boolean; // Add this flag to identify messages from history
  reasoning?: string; // For reasoning tokens from OpenRouter models
  timestamp?: string;
  tags?: string[];
}

interface Model {
  id: string;
  name: string;
  description: string;
}

// File type validation constants
const SUPPORTED_FILE_TYPES = {
  image: ['.jpg', '.jpeg', '.png', '.gif', '.webp', '.heic', '.heif'],
  video: ['.mp4', '.webm', '.mov', '.mpeg', '.mpg', '.avi', '.flv', '.wmv', '.3gpp'],
  audio: ['.mp3', '.wav', '.ogg', '.webm', '.aiff', '.aac', '.flac'],
  document: [
    '.pdf', '.js', '.py', '.txt', '.html', '.css', '.md', 
    '.csv', '.xml', '.rtf', '.pyw', '.pyc', '.pyo', '.pyi'
  ]
};

// Define an interface for the chat debug info
interface ChatDebugInfo {
  chat_id: string;
  history_length: number;
  error?: string;
}

interface ChatProps {
  initialChatId: string | null;
  isActive: boolean;
}

const Chat: React.FC<ChatProps> = ({ initialChatId, isActive }) => {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState('');
  const [loading, setLoading] = useState(false);
  const [model, setModel] = useState(() => {
    return localStorage.getItem('defaultModel') || 'gemini-2.5-flash-preview-05-20';
  });
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const messagesContainerRef = useRef<HTMLDivElement>(null);
  const [shouldAutoScroll, setShouldAutoScroll] = useState(true);
  const userInteractedWithScrollRef = useRef(false); // To track if the user initiated a scroll
  const [isStreaming, setIsStreaming] = useState(false);
  const [modelDropdownOpen, setModelDropdownOpen] = useState(false);
  const [reasoningBuffer, setReasoningBuffer] = useState('');
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  // Add a ref to track accumulated message content
  const accumulatedContentRef = useRef<string>('');
  // Add a ref to track the abort controller
  const abortControllerRef = useRef<AbortController | null>(null);
  // Add state for cancellation in progress
  const [isCanceling, setIsCanceling] = useState(false);
  // Add state for tracking thinking mode (specific to Gemini 2.5 Pro)
  const [isThinking, setIsThinking] = useState(false);
  // Add ref to track thinking timeout
  const thinkingTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Add state for current attachments
  const [attachments, setAttachments] = useState<FileAttachment[]>([]);
  // Add state for tracking if file is uploading
  const [isUploading, setIsUploading] = useState(false);
  // Add ref for file input
  const fileInputRef = useRef<HTMLInputElement>(null);
  // Add a map to track upload abort controllers for each attachment
  const uploadControllersRef = useRef<Map<string, AbortController>>(new Map());
  // Track drag and drop state
  const [isDragActive, setIsDragActive] = useState(false);
  // Add state for caching
  const [documentCache, setDocumentCache] = useState<string | null>(null);
  const [isCachingDocuments, setIsCachingDocuments] = useState(false);
  // Initialize with a pre-generated ID to avoid null->ID transitions that break streaming
  const [chatId, setChatId] = useState<string>(initialChatId || generateChatId());
  // Track whether this chat actually exists in the backend
  const [chatExistsInBackend, setChatExistsInBackend] = useState<boolean>(!!initialChatId);

  // Use a ref to track previous initialChatId to prevent infinite loops
  const prevInitialChatIdRef = useRef<string | null>(initialChatId);
  
  // Add a ref to prevent setChatId calls during initialization
  const isInitializedRef = useRef(false);
  
  // Track which chats have been loaded to prevent re-loading
  const loadedChatsRef = useRef<Set<string>>(new Set());
  
  // Track previous isActive state to detect transitions
  const prevIsActiveRef = useRef<boolean>(isActive);
  
  // Log isActive changes for debugging
  useEffect(() => {
    console.log('🔄 [IS-ACTIVE] isActive changed:', {
      chatId: chatId.slice(-8),
      isActive: isActive,
      prevIsActive: prevIsActiveRef.current,
      isStreaming: isStreaming
    });
  }, [isActive, chatId, isStreaming]);

  useEffect(() => {
    // Only update chatId if initialChatId actually changed and is not null
    if (prevInitialChatIdRef.current !== initialChatId && initialChatId) {
      prevInitialChatIdRef.current = initialChatId;
      setChatId(initialChatId);
      setChatExistsInBackend(true); // If we got an initialChatId, the chat exists
    }
    isInitializedRef.current = true;
  }, [initialChatId]);
  
  // Background processing state
  const [backgroundProcessingEnabled, ] = useState(true);
  const [showBackgroundPreview, setShowBackgroundPreview] = useState(false);
  // Add state for recording audio
  const [isRecording, setIsRecording] = useState(false);
  // Add state for processing speech to text
  const [isProcessingSpeech, setIsProcessingSpeech] = useState(false);
  // Add state for showing settings
  const [showSettings, setShowSettings] = useState(false);
  // Add state for chat summarization
  const [isSummarizing, setIsSummarizing] = useState(false);
  const [summaryModalOpen, setSummaryModalOpen] = useState(false);
  const [summaryContent, setSummaryContent] = useState('');
  // Queue for image annotation before upload
  const [annotationQueue, setAnnotationQueue] = useState<{ file: File; index: number; total: number; }[]>([]);
  const [annotationFile, setAnnotationFile] = useState<File | null>(null);
  const [annotationInfo, setAnnotationInfo] = useState<{ index: number; total: number } | null>(null);
  // Add state for microphone settings
  const [micSettings, setMicSettings] = useState({
    silenceThreshold: 10, // Default threshold value (0-255)
    silenceDuration: 1.5, // Seconds of silence before processing
  });
  const [generationSettings, setGenerationSettings] = useState<{
    temperature?: number;
    maxTokens?: number;
  }>(() => {
    const saved = localStorage.getItem('generationSettings');
    return saved ? JSON.parse(saved) : {
      temperature: undefined,
      maxTokens: undefined,
    };
  });
  // Add ref for the audio analyser
  const analyserRef = useRef<AnalyserNode | null>(null);
  // Add ref for audio data visualization
  const audioDataRef = useRef<Uint8Array | null>(null);
  // Add ref for visualization canvas
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  // Add ref for animation frame
  const animationFrameRef = useRef<number | null>(null);
  // Add ref for silence detection interval
  const silenceDetectionIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  // Add ref for media recorder
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  // Add ref for audio chunks
  const audioChunksRef = useRef<BlobPart[]>([]);
  // Add ref for monitoring speech detection
  const isSpeechDetectedRef = useRef<boolean>(false);
  // Add ref for silence start time
  const silenceStartRef = useRef<number | null>(null);
  // Add a ref to track if a scroll is programmatic
  const isProgrammaticScrollRef = useRef(false);
  // Track browser support for the SpeechSynthesis API
  const ttsSupported = typeof window !== 'undefined' && 'speechSynthesis' in window;
  
  // Button visibility settings from localStorage
  const [showTtsButton, setShowTtsButton] = useState(() => {
    const saved = localStorage.getItem('ttsButtonEnabled');
    return saved ? JSON.parse(saved) : true;
  });
  const [showSttButton, setShowSttButton] = useState(() => {
    const saved = localStorage.getItem('sttButtonEnabled');
    return saved ? JSON.parse(saved) : true;
  });
  const [imageAnnotationEnabled, setImageAnnotationEnabled] = useState(() => {
    const saved = localStorage.getItem('imageAnnotationEnabled');
    return saved ? JSON.parse(saved) : true;
  });
  const [showSummarizeButton, setShowSummarizeButton] = useState(() => {
    const saved = localStorage.getItem('summarizeButtonEnabled');
    return saved ? JSON.parse(saved) : true;
  });
  
  // Listen for changes to button visibility settings
  useEffect(() => {
    // Handle storage events from other windows
    const handleStorageChange = (e: StorageEvent) => {
      if (e.key === 'ttsButtonEnabled' && e.newValue !== null) {
        setShowTtsButton(JSON.parse(e.newValue));
      } else if (e.key === 'sttButtonEnabled' && e.newValue !== null) {
        setShowSttButton(JSON.parse(e.newValue));
      } else if (e.key === 'imageAnnotationEnabled' && e.newValue !== null) {
        setImageAnnotationEnabled(JSON.parse(e.newValue));
      } else if (e.key === 'summarizeButtonEnabled' && e.newValue !== null) {
        setShowSummarizeButton(JSON.parse(e.newValue));
      } else if (e.key === 'defaultModel' && e.newValue !== null) {
        setModel(e.newValue);
      }
    };
    
    // Handle custom events from same window
    const handleSettingsChange = (e: CustomEvent) => {
      const { key, value } = e.detail;
      if (key === 'ttsButtonEnabled') {
        setShowTtsButton(value);
      } else if (key === 'sttButtonEnabled') {
        setShowSttButton(value);
      } else if (key === 'imageAnnotationEnabled') {
        setImageAnnotationEnabled(value);
      } else if (key === 'summarizeButtonEnabled') {
        setShowSummarizeButton(value);
      } else if (key === 'defaultModel') {
        setModel(value);
      }
    };
    
    window.addEventListener('storage', handleStorageChange);
    window.addEventListener('settingsChanged', handleSettingsChange as EventListener);
    
    return () => {
      window.removeEventListener('storage', handleStorageChange);
      window.removeEventListener('settingsChanged', handleSettingsChange as EventListener);
    };
  }, []);

  // State for enabling or disabling text-to-speech output
  const [ttsEnabled, setTtsEnabled] = useState(() => {
    const saved = localStorage.getItem('ttsEnabled');
    return saved ? JSON.parse(saved) : false;
  });

  // Persist TTS setting
  useEffect(() => {
    localStorage.setItem('ttsEnabled', JSON.stringify(ttsEnabled));
  }, [ttsEnabled]);
  
  // Force reload settings when window gains focus (settings might have changed)
  useEffect(() => {
    const handleFocus = () => {
      // Check for button visibility changes
      const newTtsButtonEnabled = JSON.parse(localStorage.getItem('ttsButtonEnabled') || 'true');
      const newSttButtonEnabled = JSON.parse(localStorage.getItem('sttButtonEnabled') || 'true');
      const newImageAnnotationEnabled = JSON.parse(localStorage.getItem('imageAnnotationEnabled') || 'true');
      const newSummarizeButtonEnabled = JSON.parse(localStorage.getItem('summarizeButtonEnabled') || 'true');
      const newDefaultModel = localStorage.getItem('defaultModel') || 'gemini-2.5-flash-preview-05-20';
      
      // Use functional updates to avoid stale closure issues
      setShowTtsButton((prev: boolean) => prev !== newTtsButtonEnabled ? newTtsButtonEnabled : prev);
      setShowSttButton((prev: boolean) => prev !== newSttButtonEnabled ? newSttButtonEnabled : prev);
      setImageAnnotationEnabled((prev: boolean) => prev !== newImageAnnotationEnabled ? newImageAnnotationEnabled : prev);
      setShowSummarizeButton((prev: boolean) => prev !== newSummarizeButtonEnabled ? newSummarizeButtonEnabled : prev);
      setModel((prev: string) => prev !== newDefaultModel ? newDefaultModel : prev);
    };
    
    window.addEventListener('focus', handleFocus);
    return () => window.removeEventListener('focus', handleFocus);
  }, []); // Empty dependency array to avoid infinite loop

  // Helper to speak assistant messages
  const speak = useCallback((text: string) => {
    if (!ttsSupported) return;
    const utter = new SpeechSynthesisUtterance(text);
    utter.lang = 'en-US';
    
    // Apply TTS settings from localStorage
    const savedVoice = localStorage.getItem('ttsVoice');
    const savedSpeed = localStorage.getItem('ttsSpeed');
    
    if (savedVoice && savedVoice !== 'default') {
      const voices = window.speechSynthesis.getVoices();
      const selectedVoice = voices.find(voice => voice.name === savedVoice);
      if (selectedVoice) {
        utter.voice = selectedVoice;
      }
    }
    
    if (savedSpeed) {
      utter.rate = parseFloat(savedSpeed);
    }
    
    window.speechSynthesis.cancel();
    window.speechSynthesis.speak(utter);
  }, [ttsSupported]);

  // Only speak when TTS is initially enabled
  useEffect(() => {
    if (!ttsSupported || !ttsEnabled) {
      window.speechSynthesis.cancel();
      return;
    }

    // Only speak the last message when TTS is first enabled, not on every message change
    if (!isStreaming && messages.length > 0) {
      const last = messages[messages.length - 1];
      if (last.role === 'assistant' && last.content && !last.isHistory) {
        speak(last.content);
      }
    }
  }, [isStreaming, messages, speak, ttsEnabled, ttsSupported]); 

  // Available models with descriptions
  const models: Model[] = [
    { 
      id: 'gemini-2.5-flash-preview-05-20', 
      name: 'Gemini 2.5 Flash',
      description: 'Fast responses, ideal for simple queries'
    },
    { 
      id: 'gemini-2.5-pro-exp-03-25', 
      name: 'Gemini 2.5 Pro',
      description: 'Advanced model with superior reasoning capabilities'
    },
    { 
      id: 'deepseek/deepseek-r1-0528:free', 
      name: 'DeepSeek R1',
      description: 'Advanced reasoning model via OpenRouter'
    },
    { 
      id: 'tngtech/deepseek-r1t-chimera:free', 
      name: 'DeepSeek R1T',
      description: 'Merged version of DeepSeek-R1 and DeepSeek-V3 (0324)'
    },
    { 
      id: 'llama-3.3-70b-versatile', 
      name: 'Llama 3.3 70B',
      description: 'Really fast model via Groq'
    }
  ];

  // Helper function to check if file type is supported
  const isFileTypeSupported = (file: File): { supported: boolean, type?: string } => {
    const extension = '.' + file.name.split('.').pop()?.toLowerCase();
    
    for (const [type, extensions] of Object.entries(SUPPORTED_FILE_TYPES)) {
      if (extensions.includes(extension)) {
        return { supported: true, type };
      }
    }
    
    return { supported: false };
  }; 
  // Refs to store current values without causing re-renders
  const currentMessagesRef = useRef<ChatMessage[]>([]);
  const currentModelRef = useRef<string>(model);
  const currentIsStreamingRef = useRef<boolean>(false);

  // Update refs when values change
  useEffect(() => {
    currentMessagesRef.current = messages;
  }, [messages]);

  useEffect(() => {
    currentModelRef.current = model;
  }, [model]);

  useEffect(() => {
    currentIsStreamingRef.current = isStreaming;
  }, [isStreaming]);

  // Store previous chat ID to handle background processing on switch
  const prevChatIdRef = useRef<string | null>(null);
  const isInitialStreamRef = useRef(false); // Track if we're in the initial stream for a new chat
  const hasActiveStreamRef = useRef(false); // Track if we have an active stream reader
  // No longer need pendingChatIdRef since we pre-generate chat IDs
  
  // Get background state for this chat
  const backgroundState = chatManager.getBackgroundStatus(chatId);
  
  // Remove all temporary placeholder logic - backend now provides immediate chat metadata

  // Load chat history when chatId changes
  useEffect(() => {
    if (!chatId) {
      console.log('🔄 [CHAT-LOAD] No chat ID provided - skipping load');
      return;
    }

    // Skip if already loaded AND not a forced reload
    if (loadedChatsRef.current.has(chatId)) {
      console.log(`🔄 [CHAT-LOAD] Chat ${chatId.slice(-8)} already loaded - skipping`);
      prevChatIdRef.current = chatId;
      return;
    }

    // Prevent rapid successive loads of the same chat
    const loadKey = `load-${chatId}`;
    if (loadedChatsRef.current.has(loadKey)) {
      console.log(`🔄 [CHAT-LOAD] Chat ${chatId.slice(-8)} load already in progress - skipping`);
      return;
    }

    console.log(`🔄 [CHAT-LOAD] Loading chat: ${prevChatIdRef.current?.slice(-8) || 'null'} → ${chatId.slice(-8)}`);

    // Mark load as in progress
    loadedChatsRef.current.add(loadKey);

    // When switching chats, register the previous chat as background streaming
    if (prevChatIdRef.current && prevChatIdRef.current !== chatId) {
      console.log(`🔄 [CHAT-SWITCH] Switching from ${prevChatIdRef.current.slice(-8)} to ${chatId.slice(-8)}`);
      
      // If the previous chat was streaming, mark it as background streaming
      if (currentIsStreamingRef.current) {
        console.log(`📡 [BACKGROUND] Previous chat ${prevChatIdRef.current.slice(-8)} was streaming, marking as background`);
        chatManager.markAsBackgroundStreaming(prevChatIdRef.current);
      }
    }
    
    // Store current chat ID as previous for next switch
    prevChatIdRef.current = chatId;

    setLoading(true);
    // Reset streaming state for new chat (since chat IDs are now consistent, no need to preserve)
    setIsStreaming(false);
    setIsThinking(false);
    // Don't clear accumulated content here - wait until after checking for continuation
    userInteractedWithScrollRef.current = false;

    fetch(`/api/chat/${chatId}`, {
      method: 'GET',
      headers: { 'Content-Type': 'application/json' }
    })
      .then(r => {
        if (!r.ok) {
          if (r.status === 404) {
            // 404 means this is a new chat that doesn't exist yet - just start with empty messages
            console.log(`📝 [CHAT-LOAD] New chat detected (404): ${chatId.slice(-8)} - starting fresh`);
            return { messages: [] };
          }
          throw new Error(`Failed to load chat history: ${r.status} ${r.statusText}`);
        }
        return r.json();
      })
      .then(data => {
        if (data && data.messages) {
          const historyMessages = data.messages.map((m: ChatMessage) => ({ ...m, isHistory: true }));
          
          // Check for streaming continuation
          const continuation = chatManager.getStreamingContinuation(chatId);
          console.log(`📡 [CONTINUATION] Checking streaming continuation for ${chatId}:`, {
            hasPartialResponse: continuation.hasPartialResponse,
            isStreaming: continuation.isStreaming,
            isPending: continuation.isPending,
            partialResponseLength: continuation.partialResponse.length,
            currentlyStreaming: currentIsStreamingRef.current
          });
          
          // Handle both streaming continuation and pending state
          if (continuation.hasPartialResponse && (continuation.isStreaming || continuation.isPending)) {
            // Check if the last message in history is incomplete (streaming)
            const lastMessage = historyMessages[historyMessages.length - 1];
            console.log(`📡 [CONTINUATION] Found streaming continuation, last message:`, {
              lastMessageRole: lastMessage?.role,
              lastMessageLength: lastMessage?.content?.length || 0,
              willUpdateExisting: !!(lastMessage && lastMessage.role === 'assistant')
            });
            
            if (lastMessage && lastMessage.role === 'assistant') {
              // Update the last assistant message with the current streaming content
              lastMessage.content = continuation.partialResponse;
              lastMessage.isHistory = false; // Mark as actively streaming
              if (!currentIsStreamingRef.current) {
                console.log(`📡 [CONTINUATION] Setting messages with updated streaming content`);
                setMessages(historyMessages);
              } else {
                console.log(`📡 [CONTINUATION] Skipping message update - already streaming`);
              }
            } else {
              // Add new streaming message if no assistant message exists
              const partialMessage: ChatMessage = {
                role: 'assistant',
                content: continuation.partialResponse,
                isHistory: false
              };
              if (!currentIsStreamingRef.current) {
                console.log(`📡 [CONTINUATION] Adding new streaming message`);
                setMessages([...historyMessages, partialMessage]);
              } else {
                console.log(`📡 [CONTINUATION] Skipping new message - already streaming`);
              }
            }
            
            setIsStreaming(true);
            accumulatedContentRef.current = continuation.partialResponse;
            console.log(`📡 [CONTINUATION] Resumed streaming for chat ${chatId} with ${continuation.partialResponse.length} characters`);
          } else {
            // Set messages from history (streaming conflicts are now resolved)
            console.log('📥 [HISTORY] Setting messages from history:', {
              messageCount: historyMessages.length,
              lastMessageRole: historyMessages[historyMessages.length - 1]?.role,
              chatId: chatId.slice(-8)
            });
            setMessages(historyMessages);
            // Clear accumulated content only after we've handled continuation
            accumulatedContentRef.current = '';
            
            // Check if the last message is a user message without response
            // BUT only start background processing if we're not currently streaming AND chat isn't already processing
            // ALSO avoid starting for very recent chats to prevent race conditions with initial streaming
            if (historyMessages.length > 0 && !isStreaming && !loading) {
              const lastMessage = historyMessages[historyMessages.length - 1];
              const isAlreadyProcessing = chatManager.isProcessingInBackground(chatId);
              
              console.log('📡 [BACKGROUND-CHECK] Checking if background processing needed:', {
                chatId: chatId,
                messageCount: historyMessages.length,
                lastMessageRole: lastMessage?.role,
                isStreaming: isStreaming,
                loading: loading,
                isAlreadyProcessing: isAlreadyProcessing
              });
              
              if (lastMessage.role === 'user' && !isAlreadyProcessing) {
                // Check if this is a very recent user message (likely still being processed by the initial call)
                const messageAge = Date.now() - new Date(lastMessage.timestamp || 0).getTime();
                const isRecentMessage = messageAge < 10000; // Less than 10 seconds old
                
                console.log('📡 [BACKGROUND-CHECK] User message analysis:', {
                  messageAge: Math.round(messageAge/1000),
                  isRecentMessage: isRecentMessage,
                  messageTimestamp: lastMessage.timestamp,
                  willStartBackground: !isRecentMessage
                });
                
                if (!isRecentMessage) {
                  console.log(`📡 [BACKGROUND-START] Found unprocessed user message in chat ${chatId}, starting background processing`);
                  // Start background processing for this unprocessed message
                  setTimeout(() => {
                    chatManager.startBackgroundChat(chatId, historyMessages, model).catch(error => 
                      console.warn('❌ [BACKGROUND-START] Failed to start background processing for loaded chat:', error)
                    );
                  }, 100);
                } else {
                  console.log(`📡 [BACKGROUND-SKIP] User message is recent (${Math.round(messageAge/1000)}s old), skipping background processing to avoid race condition`);
                }
              } else {
                console.log('📡 [BACKGROUND-SKIP] No background processing needed:', {
                  reason: lastMessage.role !== 'user' ? 'last message not from user' : 'already processing'
                });
              }
            } else {
              console.log('📡 [BACKGROUND-SKIP] Background processing check skipped:', {
                messageCount: historyMessages.length,
                isStreaming: isStreaming,
                loading: loading
              });
            }
          }
        } else {
          // For new chats, start with empty messages (no placeholder message)
          console.log(`📝 [CHAT-LOAD] No messages found for ${chatId.slice(-8)} - starting fresh`);
          setMessages([]);
        }
        setTimeout(() => {
          messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
        }, 100);
      })
      .catch(e => {
        console.warn('Failed to load chat history (non-blocking):', e);
        // Don't show error messages - just start with empty chat
        // This ensures the app works even if backend has issues
        console.log(`📝 [CHAT-LOAD] Starting fresh due to load error: ${chatId.slice(-8)}`);
        setMessages([]);
      })
      .finally(() => {
        setLoading(false);
        // Mark this chat as loaded
        loadedChatsRef.current.add(chatId);
        // Remove load progress marker
        loadedChatsRef.current.delete(`load-${chatId}`);
        window.dispatchEvent(new CustomEvent('chat-load-complete'));
      });
  }, [chatId]); // Removed chatExistsInBackend dependency to prevent cascading re-renders
  


  // Function to check file processing state
  const checkFileState = async (fileId: string): Promise<{state: string, ready: boolean}> => {
    try {
      const response = await fetch(`/api/files/${fileId}/state`);
      if (!response.ok) {
        throw new Error(`Error checking file state: ${response.status}`);
      }
      const data = await response.json();
      return {
        state: data.state,
        ready: data.ready
      };
    } catch (error) {
      console.error('Failed to check file state:', error);
      return {
        state: 'UNKNOWN',
        ready: false
      };
    }
  };
  
  // Function to handle individual file upload
  const addAttachmentAndUpload = async (file: File, fileType: string, index: number, total: number) => {
    console.log(`Processing file ${index + 1}/${total}: ${file.name}, type: ${file.type}, size: ${file.size} bytes`);
    
    // Create unique ID for this attachment
    const attachmentId = `${Date.now()}-${index}`;
    
    // Create a temporary local attachment with uploading status
    const localAttachment: FileAttachment = {
        file_id: attachmentId,
        file_type: fileType as 'image' | 'video' | 'audio' | 'document',
        mime_type: file.type,
        filename: file.name,
        original_name: file.name,
        uploading: true,
        upload_progress: 0,
        local_url: URL.createObjectURL(file),
        size: file.size
    };
    
    // Add to attachments
    setAttachments(prev => [...prev, localAttachment]);
    setIsUploading(true);
    
    // Upload the file
    try {
        // Create FormData for upload
        const formData = new FormData();
        formData.append('file', file);
        
        // Create abort controller
        const controller = new AbortController();
        uploadControllersRef.current.set(attachmentId, controller);
        
        console.log(`Starting file upload for ${file.name}...`);
        
        const response = await fetch('/api/upload', {
            method: 'POST',
            body: formData,
            signal: controller.signal
        });
        
        console.log(`Upload response status for ${file.name}: ${response.status}`);
        
        // Get response as text first to debug any issues
        const responseText = await response.text();
        console.log(`Raw response for ${file.name}: ${responseText.substring(0, 200)}${responseText.length > 200 ? '...' : ''}`);
        
        // Parse the text to JSON
        let data;
        try {
            data = JSON.parse(responseText);
        } catch (parseError) {
            console.error(`Failed to parse response as JSON for ${file.name}:`, parseError);
            throw new Error(`Invalid server response: ${responseText.substring(0, 100)}...`);
        }
        
        if (!response.ok) {
            // Handle error response
            const errorMessage = data?.error || data?.message || 'Unknown upload error';
            if (data?.details) {
                console.error(`Upload error details for ${file.name}:`, data.details);
            }
            throw new Error(errorMessage);
        }
        
        console.log(`Upload successful for ${file.name}:`, data);
        
        // Make sure we have a valid file_id
        if (!data.file_id && !data.name) {
            throw new Error('Server response missing file_id');
        }
        
        // Determine file processing status
        const isStillProcessing = data.needs_processing === true && data.processing_complete === false;
        
        // Handle the response - make sure we have a file_id
        const responseWithFileId = {
            ...data,
            file_id: data.file_id || data.name
        };
        
        // Update attachments
        setAttachments(prev => 
            prev.map(attachment => 
                attachment.file_id === attachmentId
                    ? { 
                        ...responseWithFileId, 
                        uploading: false, 
                        upload_progress: 100,
                        local_url: attachment.local_url,
                        processing: isStillProcessing,
                        needs_processing: data.needs_processing
                      }
                    : attachment
            )
        );
        
        // If file needs processing, check its state periodically
        if (isStillProcessing) {
            const fileId = responseWithFileId.file_id;
            console.log(`File ${fileId} (${file.name}) is still processing. Will check status periodically.`);
            
            // Function to poll file state
            const pollFileState = async () => {
                const maxAttempts = 10;
                let attempts = 0;
                let processingComplete = false;
                
                // Set up polling interval
                const pollInterval = setInterval(async () => {
                    if (attempts >= maxAttempts || processingComplete) {
                        clearInterval(pollInterval);
                        return;
                    }
                    
                    attempts++;
                    try {
                        const stateResult = await checkFileState(fileId);
                        console.log(`File ${fileId} (${file.name}) state check (${attempts}/${maxAttempts}): ${stateResult.state}`);
                        
                        if (stateResult.ready) {
                            console.log(`File ${fileId} (${file.name}) is now ready for use`);
                            processingComplete = true;
                            
                            // Update attachment state to indicate processing is complete
                            setAttachments(prev => 
                                prev.map(attachment => 
                                    attachment.file_id === fileId
                                        ? { ...attachment, processing: false, state: stateResult.state }
                                        : attachment
                                )
                            );
                            
                            clearInterval(pollInterval);
                        }
                    } catch (error) {
                        console.error(`Error checking file state for ${file.name}:`, error);
                    }
                }, 5000);
            };
            
            // Start polling the file state
            pollFileState();
            
            // For the first file that needs processing, show a notification
            if (index === 0) {
                const processingMessage = total > 1 
                    ? "Some files are still being processed after upload. They may take a moment before they can be used in the chat."
                    : "File uploaded successfully but is still being processed. It may take a moment before it can be used in the chat.";
                alert(processingMessage);
            }
        }
    } catch (error) {
        console.error(`File upload error for ${file.name}:`, error);
        
        // Check if this was an abort error (user cancelled)
        if (error instanceof DOMException && error.name === 'AbortError') {
            console.log(`Upload cancelled by user for ${file.name}`);
            // Remove the attachment completely
            setAttachments(prev => prev.filter(a => a.file_id !== attachmentId));
            return;
        }
        
        // Handle specific error types
        let errorMessage = error instanceof Error ? error.message : 'Unknown error';
        
        // Special handling for timeout errors
        if (errorMessage.includes('timeout') || errorMessage.includes('timed out')) {
            errorMessage = 'The upload timed out. This file may be too large or your network connection may be slow. Try a smaller file or check your connection.';
        }
        
        // Update the attachment with the error
        setAttachments(prev =>
          prev.map(a =>
            a.file_id === attachmentId ? { ...a, uploading: false, upload_error: errorMessage } : a
          )
        );
        
        // Show error to user (only for the first error to avoid multiple alerts)
        if (index === 0) {
            alert(`File upload failed for ${file.name}: ${errorMessage}`);
        }
    } finally {
        // Clean up controller
        uploadControllersRef.current.delete(attachmentId);
        
        // Only update isUploading if no more uploads are in progress
        if (uploadControllersRef.current.size === 0) {
            setIsUploading(false);
        }
    }
  };

  // Function to process files from drag/drop or file input
  const processFiles = (fileList: FileList) => {
    const fileArray = Array.from(fileList);
    
    fileArray.forEach((file, index) => {
      const { supported, type } = isFileTypeSupported(file);
      if (!supported || !type) {
        alert(`Unsupported file type: ${file.name}. Please upload an image, video, audio file, or document (PDF, text, etc.)`);
        return;
      }

      if (file.size > 300 * 1024 * 1024) {
        const confirmLargeUpload = window.confirm(
          `The file ${file.name} is very large (${Math.round(file.size / (1024 * 1024))}MB) and may take a long time to upload. ` +
            `Files larger than 20MB use the Gemini File API and can be up to 2GB, but may take longer to process. ` +
            `Continue with upload?`
        );
        if (!confirmLargeUpload) {
          return;
        }
      }

      if (type === 'image' && imageAnnotationEnabled) {
        setAnnotationQueue(q => [...q, { file, index, total: fileArray.length }]);
      } else {
        addAttachmentAndUpload(file, type, index, fileArray.length);
      }
    });
  };
  
  // Enhanced file selection handler
  const handleFileSelect = async (e: ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (!files || files.length === 0) return;

    processFiles(files);

    // Reset the file input to allow selecting the same files again
    if (fileInputRef.current) {
      fileInputRef.current.value = '';
    }
  };
  
  // Drag-and-drop handlers
  const handleDragOver = (e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    if (e.dataTransfer.types.includes('Files')) {
      setIsDragActive(true);
    }
  };

  const handleDragLeave = (e: React.DragEvent<HTMLDivElement>) => {
    if (!e.currentTarget.contains(e.relatedTarget as Node)) {
      setIsDragActive(false);
    }
  };

  const handleDrop = (e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    setIsDragActive(false);
    if (e.dataTransfer.files && e.dataTransfer.files.length > 0) {
      processFiles(e.dataTransfer.files);
      e.dataTransfer.clearData();
    }
  };
  
  // Function to remove an attachment
  const removeAttachment = (attachment: FileAttachment) => {
    console.log(`Removing attachment: ${attachment.file_id}, uploading: ${attachment.uploading}`);
    
    // If attachment is uploading, abort the request
    if (attachment.uploading && uploadControllersRef.current.has(attachment.file_id)) {
      const controller = uploadControllersRef.current.get(attachment.file_id);
      if (controller) {
        console.log(`Aborting in-progress upload for ${attachment.file_id}`);
        controller.abort();
        uploadControllersRef.current.delete(attachment.file_id);
      }
    }
    
    // Revoke object URL to prevent memory leaks
    if (attachment.local_url) {
      URL.revokeObjectURL(attachment.local_url);
    }
    
    // Remove from attachments list
    setAttachments(prev => prev.filter(a => a !== attachment));
    
    // Check if we need to update the global uploading state
    setTimeout(() => {
      // Use a short timeout to ensure state is updated
      const anyUploading = attachments.some(a => a !== attachment && a.uploading);
      console.log(`Any attachments still uploading? ${anyUploading}`);
      if (!anyUploading) {
        console.log('No more uploads in progress, setting isUploading to false');
        setIsUploading(false);
      }
    }, 0);
  };

  const handleAnnotationSave = (edited: File) => {
    if (annotationInfo) {
      addAttachmentAndUpload(edited, 'image', annotationInfo.index, annotationInfo.total);
    }
    setAnnotationFile(null);
    setAnnotationInfo(null);
  };

  const handleAnnotationCancel = () => {
    if (annotationFile && annotationInfo) {
      addAttachmentAndUpload(annotationFile, 'image', annotationInfo.index, annotationInfo.total);
    }
    setAnnotationFile(null);
    setAnnotationInfo(null);
  };

  // Memoised scroll handler – NOT recreated on every render
  const handleScroll = useCallback(() => {
    if (isProgrammaticScrollRef.current) {
      isProgrammaticScrollRef.current = false;
      return;
    }

    const container = messagesContainerRef.current;
    if (!container) return;

    const { scrollTop, scrollHeight, clientHeight } = container;
    const isAtBottom = scrollHeight - scrollTop - clientHeight <= 1;

    // Safe – doesn't depend on shouldAutoScroll, just sets it based on scroll position
    setShouldAutoScroll(isAtBottom);
    userInteractedWithScrollRef.current = !isAtBottom;
  }, []);

  // Attach scroll listener only when the chat tab is active
  useEffect(() => {
    if (!isActive) return;
    const container = messagesContainerRef.current;
    if (!container) return;

    container.addEventListener('scroll', handleScroll);
    return () => container.removeEventListener('scroll', handleScroll);
  }, [isActive, handleScroll]); // shouldAutoScroll is GONE here

  useEffect(() => {
    if (!isActive) return;
    if (shouldAutoScroll && messages.length > 0) {
      if (!userInteractedWithScrollRef.current) {
        console.log('Auto-scrolling to bottom due to new message and shouldAutoScroll=true');
        // Use immediate scroll during streaming to prevent jumping
        // Only use smooth scroll when not actively streaming (for better UX when user returns to bottom)
        scrollToBottom(!isStreaming);
      }
    }
  }, [messages, shouldAutoScroll, isStreaming, isActive]);

  // Speak assistant messages when streaming finishes
  useEffect(() => {
    if (!ttsEnabled || isStreaming || messages.length === 0) return;
    const last = messages[messages.length - 1];
    if (last.role === 'assistant' && last.content) {
      speak(last.content);
    }
  }, [messages, isStreaming, ttsEnabled, speak]);

  // Close model dropdown when clicking outside
  useEffect(() => {
    if (!isActive) return;
    const handleClickOutside = (event: MouseEvent) => {
      const target = event.target as HTMLElement;
      if (!target.closest('.model-selector')) {
        setModelDropdownOpen(false);
      }
    };

    document.addEventListener('mousedown', handleClickOutside);
    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
    };
  }, [isActive]);

  // Process queued images for annotation one at a time
  useEffect(() => {
    if (!annotationFile && annotationQueue.length > 0) {
      const next = annotationQueue[0];
      setAnnotationFile(next.file);
      setAnnotationInfo({ index: next.index, total: next.total });
      setAnnotationQueue(q => q.slice(1));
    }
  }, [annotationQueue, annotationFile]);

  // Auto-grow textarea based on content
  useEffect(() => {
    if (!isActive) return;
    const textarea = textareaRef.current;
    if (!textarea) return;

    const adjustHeight = () => {
      textarea.style.height = 'auto';
      const newHeight = Math.min(textarea.scrollHeight, 150); // Max height of 150px
      textarea.style.height = `${newHeight}px`;
    };

    textarea.addEventListener('input', adjustHeight);
    adjustHeight(); // Initial adjustment

    return () => textarea.removeEventListener('input', adjustHeight);
  }, [input, isActive]);

  // Clean up thinking timeout on component unmount
  useEffect(() => {
    return () => {
      if (thinkingTimeoutRef.current !== null) {
        clearTimeout(thinkingTimeoutRef.current);
      }
    };
  }, []);

  // Cleanup object URLs when component unmounts
  useEffect(() => {
    return () => {
      attachments.forEach(attachment => {
        if (attachment.local_url) {
          URL.revokeObjectURL(attachment.local_url);
        }
      });
    };
  }, [attachments]);

  // WebSocket setup and background processing integration
  useEffect(() => {
    // Early return if chat doesn't exist or background processing is disabled
    if (!chatId || !backgroundProcessingEnabled) {
      console.log('🌐 [WS-SETUP] Skipping WebSocket setup:', {
        chatId: chatId ? chatId.slice(-8) : 'null',
        backgroundProcessingEnabled
      });
      return;
    }

    // Prevent excessive WebSocket setup for the same chat
    const wsSetupKey = `ws-${chatId}`;
    if (loadedChatsRef.current.has(wsSetupKey)) {
      console.log('🌐 [WS-SETUP] WebSocket already configured for chat:', chatId.slice(-8));
      return;
    }

    console.log('🌐 [WS-SETUP] Setting up WebSocket connection for chat:', {
      chatId: chatId.slice(-8),
      isActive: isActive,
      backgroundProcessingEnabled: backgroundProcessingEnabled
    });

    // Join the chat room for background updates
    try {
      chatManager.joinChatRoom(chatId);
      console.log('🌐 [WS-JOIN] Successfully joined WebSocket room for chat:', chatId.slice(-8));
      // Mark as configured to prevent duplicate setups
      loadedChatsRef.current.add(wsSetupKey);
    } catch (error: unknown) {
      console.warn('🌐 [WS-JOIN] Failed to join chat room:', error);
      // Don't mark as configured if join failed - allow retry
    }

    // ISSUE 5 FIX: Cleanup function to prevent connection leaks
    return () => {
      // Only cleanup if chat is being unmounted/changed, not just inactive
      console.log('🌐 [WS-CLEANUP] Cleaning up WebSocket for chat:', chatId.slice(-8));
      // Remove the setup marker to allow re-setup if needed
      loadedChatsRef.current.delete(wsSetupKey);
    };
  }, [chatId, backgroundProcessingEnabled]); // Removed isActive from dependencies to prevent recreation loops

  // ISSUE 1 & 3 FIX: Enhanced thinking state preservation and restoration
  useEffect(() => {
    const hasAbortController = !!abortControllerRef.current;
    const hasPendingState = chatManager.isProcessingInBackground(chatId);
    const wasStreamingOrLoading = isStreaming || loading;
    
    console.log('🔄 [TRANSITION-CHECK] Checking transition state:', {
      prevActive: prevIsActiveRef.current,
      currentActive: isActive,
      isStreaming: isStreaming,
      loading: loading,
      hasAbortController: hasAbortController,
      hasPendingState: hasPendingState,
      backgroundProcessingEnabled: backgroundProcessingEnabled,
      isThinking: isThinking
    });
    
    // ISSUE 1 FIX: When chat becomes inactive, preserve ALL states to background
    if (prevIsActiveRef.current === true && isActive === false && (wasStreamingOrLoading || hasPendingState)) {
      console.log('🔄 [CHAT-TRANSITION] Chat became inactive while processing, marking as background:', {
        chatId: chatId.slice(-8),
        wasActive: prevIsActiveRef.current,
        nowActive: isActive,
        isStreaming: isStreaming,
        loading: loading,
        hasAbortController: !!abortControllerRef.current,
        hasPendingState: hasPendingState,
        backgroundProcessingEnabled: backgroundProcessingEnabled,
        isThinking: isThinking
      });
      
      if (backgroundProcessingEnabled) {
        // ISSUE 1 FIX: Save thinking state to background before marking as background streaming
        if (isThinking) {
          console.log('💭 [THINKING-PRESERVE] Preserving thinking state to background:', chatId.slice(-8));
          chatManager.markChatAsThinking(chatId);
        }
        
        // STREAMING FIX: Preserve current streaming content to background before clearing frontend state
        if (isStreaming && accumulatedContentRef.current) {
          console.log('📡 [FRONTEND-CLEANUP] Preserving accumulated content to background before frontend cleanup:', {
            chatId: chatId.slice(-8),
            contentLength: accumulatedContentRef.current.length,
            contentPreview: accumulatedContentRef.current.substring(0, 50) + '...'
          });
        }
        
        chatManager.markAsBackgroundStreaming(chatId);
        
        // STREAMING FIX: Clean up frontend streaming state when going to background
        // This prevents interference with the next active chat's streaming
        if (isStreaming || isThinking) {
          console.log('🧹 [FRONTEND-CLEANUP] Cleaning up frontend streaming state for inactive chat:', chatId.slice(-8));
          setIsStreaming(false);
          setIsThinking(false);
          setLoading(false);
          // Keep accumulated content in ref so it can be restored when chat becomes active again
          // Don't clear accumulatedContentRef.current here - it will be restored from background state
        }
        
        // Ensure this chat won't trigger auto-switching by marking it as background-only
        console.log('🔒 [BACKGROUND-LOCK] Chat locked to background processing, no auto-switching allowed:', chatId.slice(-8));
      }
    }
    
    // ISSUE 3 FIX: When chat becomes active, restore ALL states from background
    if (prevIsActiveRef.current === false && isActive === true) {
      const backgroundState = chatManager.getBackgroundStatus(chatId);
      console.log('💭 [ACTIVATION-CHECK] Chat activated, checking background state:', {
        chatId: chatId.slice(-8),
        hasBackgroundState: !!backgroundState,
        backgroundIsThinking: backgroundState?.isThinking,
        backgroundStatus: backgroundState?.status,
        currentIsThinking: isThinking
      });
      
      if (backgroundState?.isThinking && !isThinking) {
        console.log('💭 [THINKING-RESTORE] Restoring thinking state from background:', chatId.slice(-8));
        setIsThinking(true);
        
        // Add placeholder message for thinking animation if no assistant message exists
        setMessages(prevMessages => {
          const lastMessage = prevMessages[prevMessages.length - 1];
          if (lastMessage?.role !== 'assistant' || lastMessage.content.trim()) {
            return [...prevMessages, { 
              role: 'assistant', 
              content: '', 
              isHistory: false, 
              timestamp: new Date().toISOString(), 
              tags: [] 
            }];
          }
          return prevMessages;
        });
        
        // Don't clear the background thinking state yet - let it be cleared when stream actually starts
      }
      
      // ISSUE 3 FIX: If background is streaming, restore streaming state
      if (backgroundState?.status === 'streaming' && !isStreaming) {
        console.log('🚀 [STREAMING-RESTORE] Restoring streaming state from background:', chatId.slice(-8), {
          hasCurrentResponse: !!backgroundState.currentResponse,
          responseLength: backgroundState.currentResponse?.length || 0,
          responsePreview: backgroundState.currentResponse?.substring(0, 50) || 'EMPTY'
        });
        setIsStreaming(true);
        
        // Restore accumulated content if any
        if (backgroundState.currentResponse) {
          setMessages(prevMessages => {
            const updatedMessages = [...prevMessages];
            const lastIndex = updatedMessages.length - 1;
            const lastMessage = lastIndex >= 0 ? updatedMessages[lastIndex] : null;
            
            if (lastIndex >= 0 && lastMessage?.role === 'assistant') {
              // Only update content if background has actual content
              // This prevents overwriting existing content with empty string
              const newContent = backgroundState.currentResponse || lastMessage.content;
              console.log('🔄 [CONTENT-RESTORE] Updating assistant message content:', {
                chatId: chatId.slice(-8),
                existingContentLength: lastMessage.content?.length || 0,
                backgroundContentLength: backgroundState.currentResponse?.length || 0,
                newContentLength: newContent?.length || 0,
                willUpdate: backgroundState.currentResponse !== lastMessage.content
              });
              updatedMessages[lastIndex] = {
                ...lastMessage,
                content: newContent
              };
            } else {
              updatedMessages.push({
                role: 'assistant',
                content: backgroundState.currentResponse,
                timestamp: new Date().toISOString(),
                tags: []
              });
            }
            
            return updatedMessages;
          });
        }
      }
    }
    
    // Update the ref for next render
    prevIsActiveRef.current = isActive;
  }, [isActive, isStreaming, loading, chatId, backgroundProcessingEnabled, isThinking]);

  const scrollToBottom = (smooth = false) => {
    if (messagesContainerRef.current) {
      isProgrammaticScrollRef.current = true;
      // During streaming, maintain position immediately to prevent jumping
      // Only use smooth scrolling when user manually returns to bottom
      const behavior = smooth ? 'smooth' : 'auto';
      messagesEndRef.current?.scrollIntoView({ behavior, block: 'end' });
    }
  };

  // More stable approach to handling SSE data from the server
  const processStreamChunk = (chunk: string) => {
    // STREAMING FIX: Only process chunks if this chat has an active stream request
    // Check if we have an active abort controller (meaning this chat initiated the current stream)
    if (!abortControllerRef.current) {
      console.log('🚫 [STREAMING-GUARD] Ignoring stream chunk for chat without active request:', chatId.slice(-8));
      return;
    }
    
    // Process each message from the server
    try {
      if (chunk.trim() === '[DONE]') {
        finalizeStream();
        return;
      }

      // Parse the chunk if it's JSON
      try {
        const data = JSON.parse(chunk);
        
        // Chat ID is now handled in the main SSE parsing loop above
        // This prevents duplicate setChatId calls that could disrupt streaming
        
        if (data.reasoning) {
          
          // Update reasoning buffer and messages together to ensure consistency
          setReasoningBuffer(prev => {
            const newBuffer = prev + data.reasoning;
            
            // Update messages with the new reasoning buffer
            setMessages(prevMessages => {
              const updatedMessages = [...prevMessages];
              const lastIndex = updatedMessages.length - 1;
              const lastMessage = lastIndex >= 0 ? updatedMessages[lastIndex] : null;
              
              if (lastIndex >= 0 && lastMessage?.role === 'assistant') {
                // Update existing assistant message with accumulated reasoning
                updatedMessages[lastIndex] = {
                  ...lastMessage,
                  reasoning: newBuffer
                };
              } else {
                // Create new assistant message with reasoning
                updatedMessages.push({
                  role: 'assistant',
                  content: '',
                  reasoning: newBuffer,
                  timestamp: new Date().toISOString(),
                  tags: []
                });
              }
              
              return updatedMessages;
            });
            
            return newBuffer;
          });
        }
        
        if (data.chunk) {
          // Accumulate content in the ref
          accumulatedContentRef.current += data.chunk;
          
          // Use requestAnimationFrame to optimize UI updates for streaming Markdown
          requestAnimationFrame(() => {
            setMessages(prevMessages => {
              const updatedMessages = [...prevMessages];
              const lastIndex = updatedMessages.length - 1;
              const lastMessage = lastIndex >= 0 ? updatedMessages[lastIndex] : null;
              
              if (lastIndex >= 0 && lastMessage?.role === 'assistant') {
                // Update existing message with new content and reasoning
                const finalReasoning = reasoningBuffer || lastMessage.reasoning;
                updatedMessages[lastIndex] = {
                  ...lastMessage,
                  content: accumulatedContentRef.current,
                  reasoning: finalReasoning
                };
              } else {
                // Create new assistant message if needed
                updatedMessages.push({
                  role: 'assistant',
                  content: accumulatedContentRef.current,
                  reasoning: reasoningBuffer || undefined,
                  timestamp: new Date().toISOString(),
                  tags: []
                });
              }
              
              return updatedMessages;
            });
          });
          
          // Make sure streaming flag is set
          if (!isStreaming) {
            console.log('🚀 [SSE] Setting streaming flag to true');
            setIsStreaming(true);
            
            // ISSUE 1 FIX: Clear thinking state from background when any stream starts (not just Gemini 2.5 Pro)
            if (chatId) {
              chatManager.clearThinkingState(chatId);
            }
          }
        }
        
        if (data.done) {
          finalizeStream();
        }
      } catch {
        // Handle non-JSON chunks
        if (chunk.trim()) {
          accumulatedContentRef.current += chunk;
          
          requestAnimationFrame(() => {
            setMessages(prevMessages => {
              const updatedMessages = [...prevMessages];
              const lastIndex = updatedMessages.length - 1;
              const lastMessage = lastIndex >= 0 ? updatedMessages[lastIndex] : null;
              
              if (lastIndex >= 0 && lastMessage?.role === 'assistant') {
                updatedMessages[lastIndex] = {
                  ...lastMessage,
                  content: accumulatedContentRef.current
                };
              } else {
                updatedMessages.push({
                  role: 'assistant',
                  content: accumulatedContentRef.current,
                  timestamp: new Date().toISOString(),
                  tags: []
                });
              }
              
              return updatedMessages;
            });
          });
          
          if (!isStreaming) {
            setIsStreaming(true);
            
            // ISSUE 1 FIX: Clear thinking state from background when any stream starts
            if (chatId) {
              chatManager.clearThinkingState(chatId);
            }
          }
        }
      }
    } catch (error) {
      console.error('Error processing chunk:', error);
    }
  };

  // Enhanced finalize function to handle proper completion detection
  const finalizeStream = (isAborted = false) => {
    console.log('🏁 [FINALIZE] Starting stream finalization:', {
      chatId: chatId?.slice(-8) || 'null',
      isAborted: isAborted,
      isActive: isActive,
      isStreaming: isStreaming,
      isThinking: isThinking,
      messageCount: currentMessagesRef.current.length,
      accumulatedContentLength: accumulatedContentRef.current.length
    });
    
    setIsStreaming(false);
    setIsThinking(false);
    setLoading(false);
    
    // Finalize any accumulated content
    if (accumulatedContentRef.current) {
      setMessages(prevMessages => {
        const updatedMessages = [...prevMessages];
        const lastIndex = updatedMessages.length - 1;
        
        if (lastIndex >= 0 && updatedMessages[lastIndex]?.role === 'assistant') {
          // Update the existing assistant message with final content
          updatedMessages[lastIndex] = {
            ...updatedMessages[lastIndex],
            content: accumulatedContentRef.current,
            reasoning: reasoningBuffer || updatedMessages[lastIndex].reasoning
          };
        } else {
          // Add new assistant message if none exists
          updatedMessages.push({
            role: 'assistant',
            content: accumulatedContentRef.current,
            reasoning: reasoningBuffer || undefined,
            timestamp: new Date().toISOString(),
            tags: []
          });
        }
        
        // Update current messages ref for logging
        currentMessagesRef.current = updatedMessages;
        return updatedMessages;
      });
    }
    
    // Save final state
    accumulatedContentRef.current = '';
    setReasoningBuffer('');
    
    // ISSUE 4 FIX: Improved completion handling based on active status
    if (chatId) {
      const backgroundState = chatManager.getBackgroundStatus(chatId);
      console.log('🏁 [FINALIZE] Finalizing stream completion:', {
        chatId: chatId.slice(-8),
        hadBackgroundState: !!backgroundState,
        backgroundStatus: backgroundState?.status,
        isAborted: isAborted,
        isActive: isActive,
        messageCount: currentMessagesRef.current.length,
        wasStreaming: isStreaming
      });
      
      if (backgroundState && !isAborted) {
        if (isActive) {
          // ISSUE 4 FIX: For active chats, immediately clear background state since user can see completion
          console.log(`🏁 [FINALIZE] Active chat ${chatId.slice(-8)} completed streaming, clearing background state immediately`);
          chatManager.clearBackgroundStateForChat(chatId);
          chatManager.clearThinkingState(chatId);
        } else {
          // ISSUE 4 FIX: For inactive chats, mark as completed but don't clear immediately
          // This allows the UI to show completion status in sidebar
          console.log(`🏁 [FINALIZE] Background chat ${chatId.slice(-8)} completed streaming, marking as completed`);
          // The background state will be cleared by the WebSocket handler after a delay
        }
      } else if (isAborted && backgroundState) {
        console.log(`🏁 [FINALIZE] Stream aborted for chat ${chatId.slice(-8)}, keeping background state for potential continuation`);
      }
    }
    
    // Clear thinking timeout if exists
    if (thinkingTimeoutRef.current !== null) {
      clearTimeout(thinkingTimeoutRef.current);
      thinkingTimeoutRef.current = null;
    }
    
    // Emit completion event for other components
    if (chatId && !isAborted) {
      if (isActive) {
        // For active chats, use chat-updated event
        window.dispatchEvent(new CustomEvent('chat-updated', { 
          detail: { chatId } 
        }));
      } else {
        // For background chats, use chat-background-updated to prevent auto-switching
        window.dispatchEvent(new CustomEvent('chat-background-updated', { 
          detail: { chatId } 
        }));
      }
    }
    
    // Only scroll to bottom for non-aborted messages
    if (!isAborted && shouldAutoScroll) {
      setTimeout(() => {
        if (shouldAutoScroll && !userInteractedWithScrollRef.current) {
          console.log('🏁 [FINALIZE] Auto-scrolling to bottom after completion');
          scrollToBottom();
        }
      }, 50); // Small delay for rendering
    }

    // Refocus the textarea after response is complete
    setTimeout(() => {
      if (textareaRef.current && isActive) {
        textareaRef.current.focus();
      }
    }, 100);
  };

  /**
   * Creates a document cache for optimizing processing of document attachments
   * @param fileIds Array of file IDs to include in the cache
   * @returns The cache ID if successful, null otherwise
   */
  const createDocumentCache = async (fileIds: string[]): Promise<string | null> => {
    if (!fileIds.length) return null;
    
    try {
      setIsCachingDocuments(true);
      console.log(`Creating document cache for ${fileIds.length} files:`, fileIds);
      
      const response = await fetch('/api/cache', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ file_ids: fileIds }),
      });
      
      if (!response.ok) {
        const errorText = await response.text();
        console.error(`Error creating document cache: ${response.status} - ${errorText}`);
        return null;
      }
      
      const data = await response.json();
      console.log('Document cache created successfully:', data.cache_id);
      setDocumentCache(data.cache_id);
      return data.cache_id;
    } catch (error) {
      console.error('Error creating document cache:', error);
      return null;
    } finally {
      setIsCachingDocuments(false);
    }
  };

  // Modify the resetChat function to clear chat session on the server
  const resetChat = useCallback(() => {
    // Check if this chat has any background processing state (including pending)
    const hasBackgroundState = chatManager.isProcessingInBackground(chatId);
    
    // If there's an active request, check if we should transition to background instead of aborting
    if (abortControllerRef.current) {
      // If background processing is enabled and the chat is streaming OR has background state, transition to background
      if (backgroundProcessingEnabled && (isStreaming || hasBackgroundState) && chatId && isActive) {
        console.log(`🔄 [RESET-CHAT] Transitioning chat ${chatId.slice(-8)} to background processing (isStreaming: ${isStreaming}, hasBackgroundState: ${hasBackgroundState})`);
        
        // Mark this chat as background streaming to preserve the request
        chatManager.markAsBackgroundStreaming(chatId);
        
        // Don't abort the request - let it continue in background
        setIsCanceling(false);
        
        console.log(`🔄 [RESET-CHAT] Chat ${chatId.slice(-8)} moved to background, request continues`);
      } else {
        // No background processing available or not streaming - abort as before
        console.log(`🔄 [RESET-CHAT] Aborting request (background disabled: ${!backgroundProcessingEnabled}, not streaming: ${!isStreaming}, no background state: ${!hasBackgroundState})`);
        setIsCanceling(true);
        abortControllerRef.current.abort();
        abortControllerRef.current = null;
        
        // Reset canceling state after a short delay to show feedback
        setTimeout(() => {
          setIsCanceling(false);
        }, 800);
      }
    } else if (hasBackgroundState && backgroundProcessingEnabled && chatId && isActive) {
      // Even if no active request, ensure background state is preserved when transitioning
      console.log(`🔄 [RESET-CHAT] No active request but has background state, ensuring background processing continues for ${chatId.slice(-8)}`);
      chatManager.markAsBackgroundStreaming(chatId);
    }
    
    // Clean up any object URLs
    attachments.forEach(attachment => {
      if (attachment.local_url) {
        URL.revokeObjectURL(attachment.local_url);
      }
    });
    
    // Reset document cache
    setDocumentCache(null);
    
    // Clear chat messages on the server if we have a chat ID (without deleting the chat)
    if (chatId) {
      console.log(`Resetting chat messages on server: ${chatId}`);
      fetch(`/api/chat/${chatId}/reset`, { 
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        }
      })
        .then(response => {
          if (response.ok) {
            console.log('Chat messages cleared successfully');
            // Notify chat manager to update the list, but keep the chat ID
            window.dispatchEvent(new CustomEvent('chat-reset', { 
              detail: { chatId } 
            }));
          } else {
            console.error('Failed to clear chat messages:', response.statusText);
          }
        })
        .catch(error => {
          console.error('Error clearing chat messages:', error);
        });
    }
    
    // Reset all UI states (but keep the chat ID)
    setMessages([]);
    setLoading(false);
    setIsStreaming(false);
    setIsThinking(false); // Reset thinking state
    // setShouldAutoScroll(true); // Respect user's scroll choice
    userInteractedWithScrollRef.current = false; // On reset, assume fresh state for scrolling
    accumulatedContentRef.current = '';
    setAttachments([]);
    setReasoningBuffer('');
    
    // Clear thinking timeout if exists
    if (thinkingTimeoutRef.current !== null) {
      clearTimeout(thinkingTimeoutRef.current);
      thinkingTimeoutRef.current = null;
    }
    
    // Focus on textarea after reset
    setTimeout(() => {
      if (textareaRef.current) {
        textareaRef.current.focus();
      }
    }, 0);
  }, [attachments, chatId]); // Added dependencies

  // Fetch and display a summary of the current chat
  const summarizeChat = async () => {
    if (!chatExistsInBackend) return;
    setIsSummarizing(true);
    try {
      const summary = await chatManager.getChatSummary(chatId, model);
      setSummaryContent(summary || 'No summary available.');
    } catch (error) {
      console.error('Failed to summarize chat:', error);
      setSummaryContent('Failed to generate summary.');
    } finally {
      setIsSummarizing(false);
      setSummaryModalOpen(true);
    }
  };

  // Replace current chat history with the generated summary
  const useSummaryAsHistory = async () => {
    if (!chatExistsInBackend || !summaryContent) return;
    const success = await chatManager.condenseChat(chatId, summaryContent, model);
    if (success) {
      setMessages([{ role: 'system', content: summaryContent, isHistory: true }]);
      setSummaryModalOpen(false);
      window.dispatchEvent(new CustomEvent('chat-updated', { detail: { chatId } }));
    } else {
      alert('Failed to replace chat history with summary.');
    }
  };

  // Enhanced send function to handle document caching, chat history, and background processing
  const handleSend = async () => {
    // Prevent sending if uploads are in progress
    if (isUploading) {
      alert('Please wait for file uploads to complete before sending your message.');
      return;
    }
    
    // Require either text or at least one attachment to send a message
    if ((!input.trim() && attachments.length === 0) || loading) return;
    
    // Mark chat as pending immediately when user commits to sending
    // This ensures background streaming indicator appears instantly
    if (chatId) {
      chatManager.markChatAsPending(chatId);
      console.log(`📤 [SEND] Marked chat ${chatId.slice(-8)} as pending for immediate UI feedback`, {
        isActive: isActive,
        chatId: chatId.slice(-8),
        currentBackgroundState: chatManager.getBackgroundStatus(chatId)?.status || 'none'
      });
      
      // For very quick transitions, also ensure this state is immediately marked as background streaming
      // if the chat is not active (edge case where user switches before this point)
      if (!isActive && backgroundProcessingEnabled) {
        console.log(`📤 [SEND] Chat ${chatId.slice(-8)} is not active, immediately marking as background streaming`);
        chatManager.markAsBackgroundStreaming(chatId);
      }
    }
    
    // No more temporary placeholders - backend will provide immediate chat metadata
    
    // Check if we should process in background (if chat is not visible)
    const shouldProcessInBackground = backgroundProcessingEnabled && !isActive && chatId;
    
    console.log('🎯 [SEND] Processing mode check:', { 
      backgroundProcessingEnabled, 
      isActive, 
      chatId: chatId?.slice(-8) || 'null', 
      shouldProcessInBackground,
      inputLength: input.trim().length,
      attachmentCount: attachments.length,
      currentMessageCount: messages.length
    });
    
    if (shouldProcessInBackground) {
      console.log(`🚀 [BACKGROUND-SEND] Starting background processing for chat ${chatId}`);
      
      // Clear input but don't show loading state
      const inputToSend = input.trim();
      const attachmentsToSend = [...attachments];
      setInput('');
      setAttachments([]);
      
      // Build messages array for background processing
      const messagesToSend = [
        ...messages.filter(m => !m.isHistory).map(m => ({
          role: m.role,
          content: m.content,
          attachments: m.attachments || []
        })),
        {
          role: 'user' as const,
          content: inputToSend,
          attachments: attachmentsToSend
        }
      ];
      
      console.log(`🚀 [BACKGROUND-SEND] Message payload:`, {
        chatId: chatId.slice(-8),
        messageCount: messagesToSend.length,
        lastUserMessage: inputToSend.substring(0, 50) + (inputToSend.length > 50 ? '...' : ''),
        attachmentCount: attachmentsToSend.length,
        model: model,
        generationSettings: generationSettings
      });
      
      // Start background processing
      const success = await chatManager.startBackgroundChat(
        chatId,
        messagesToSend,
        model,
        {
          temperature: generationSettings.temperature,
          max_tokens: generationSettings.maxTokens
        }
      );
      
      if (success) {
        console.log('✅ [BACKGROUND-SEND] Background processing started successfully');
        // Optionally show a subtle notification that processing started
      } else {
        console.error('❌ [BACKGROUND-SEND] Failed to start background processing, falling back to foreground');
        // Fall back to normal processing by continuing to regular flow
      }
      
      if (success) {
        console.log('🚀 [BACKGROUND-SEND] Background processing started successfully, exiting early');
        return; // Exit early if background processing started successfully
      }
    }

    // Check if we have document attachments that could benefit from caching
    const documentAttachments = attachments.filter(
      attachment => attachment.file_type === 'document' && attachment.file_id
    );
    
    // Create a cache if we have documents
    let cacheId = documentCache; // Use existing global documentCache
    if (documentAttachments.length > 0 && !documentCache) { 
      // If there are document attachments and no current global cache, create one
      const fileIds = documentAttachments
        .map(attachment => attachment.file_id)
        .filter(Boolean) as string[]; // Make sure to filter out any null/undefined ids
        
      if (fileIds.length > 0) {
        console.log('Calling createDocumentCache for file IDs:', fileIds);
        cacheId = await createDocumentCache(fileIds); // This will also set global documentCache
      }
    }
    
    const userMessage: ChatMessage = {
      role: 'user',
      content: input.trim(),
      attachments: attachments.length > 0 ? attachments.map(a => ({
        // Map only necessary fields for the message
        file_id: a.file_id,
        file_type: a.file_type,
        mime_type: a.mime_type,
        filename: a.filename,
        original_name: a.original_name,
        // Do not include local_url, uploading, upload_progress etc.
      })) : undefined,
      isHistory: false,
      timestamp: new Date().toISOString(),
      tags: []
    };
    
    // Auto-scroll logic BEFORE adding the message to the state
    // This ensures that if we decide to scroll, it happens with the new message already in view.
    if (messagesContainerRef.current) {
      const { scrollTop, scrollHeight, clientHeight } = messagesContainerRef.current;
      const isAtBottom = scrollHeight - scrollTop - clientHeight <= 1;
      if (isAtBottom) {
          if(!shouldAutoScroll) {
              console.log('handleSend: User at bottom, enabling auto-scroll');
              setShouldAutoScroll(true);
          }
          // If at bottom, user interaction is reset, allowing auto-scroll for this new message
          userInteractedWithScrollRef.current = false; 
      } else if (!userInteractedWithScrollRef.current) {
          // If user hasn't scrolled up, and we are not at the bottom,
          // we should still enable auto-scroll for this new message.
          if(!shouldAutoScroll) {
              console.log('handleSend: User not at bottom, no prior scroll up, ensuring auto-scroll for new message');
              setShouldAutoScroll(true);
          }
          // Since auto-scroll is being (re-)enabled and user hasn't interacted, reset this ref
          userInteractedWithScrollRef.current = false;
      }
      // If userInteractedWithScrollRef.current is true (user scrolled up and is not at bottom),
      // shouldAutoScroll remains false, and we don't scroll.
    }

    setMessages(prev => [...prev, userMessage]);
    
    setInput('');
    setAttachments([]); // Clear attachments from input area AFTER they are included in userMessage
    accumulatedContentRef.current = ''; // Clear any accumulated assistant message content
    setLoading(true);
    
    // Immediately create chat in sidebar for new chats (optimistic UI)
    // This ensures the sidebar updates instantly, before backend confirmation
    if (chatId && !chatExistsInBackend) {
      console.log(`🎉 [SEND-OPTIMISTIC] Creating chat in sidebar immediately: ${chatId.slice(-8)}`);
      
      // Create the chat entry immediately for instant UI feedback
      window.dispatchEvent(new CustomEvent('chat-created', {
        detail: { 
          chatId: chatId,
          title: userMessage.content.length > 50 ? userMessage.content.substring(0, 50) + '...' : userMessage.content,
          model: model,
          created_at: new Date().toISOString()
        }
      }));
      
      // Force chatManager to refresh and pick up the new chat
      chatManager.refreshChats();
      
      // Also trigger refresh for existing chats
      setTimeout(() => {
        if (isActive) {
          window.dispatchEvent(new CustomEvent('chat-updated', {
            detail: { chatId }
          }));
        } else {
          window.dispatchEvent(new CustomEvent('chat-background-updated', {
            detail: { chatId }
          }));
        }
      }, 100);
    } else if (chatId) {
      // For existing chats, just update
      setTimeout(() => {
        if (isActive) {
          window.dispatchEvent(new CustomEvent('chat-updated', {
            detail: { chatId }
          }));
        } else {
          window.dispatchEvent(new CustomEvent('chat-background-updated', {
            detail: { chatId }
          }));
        }
      }, 100);
    }
    
    // Maintain focus on the textarea after sending
    setTimeout(() => {
      if (textareaRef.current) {
        textareaRef.current.focus();
      }
    }, 0);
    
    // For Gemini 2.5 Pro, show thinking state before streaming
    const isGemini25Pro = model === 'gemini-2.5-pro-exp-03-25' || model === 'gemini-2.5-flash-preview-05-20';
    if (isGemini25Pro) {
      // First set the thinking state
      setIsThinking(true);
      // Add a placeholder message for the thinking state
      setMessages(prev => [...prev, { role: 'assistant', content: '', isHistory: false, timestamp: new Date().toISOString(), tags: [] }]);
      // Add a minimum thinking time to ensure animation shows (at least 1 second)
      thinkingTimeoutRef.current = setTimeout(() => {
        thinkingTimeoutRef.current = null;
      }, 1000);
    } else {
      // For other models, start streaming immediately
      setIsStreaming(true);
    }

    try {
      // Prepare chat history - send only up to the user message
      const historyForAPI = [...messages, userMessage];
      
      // Create a new controller for this request and store it in the ref
      const controller = new AbortController();
      abortControllerRef.current = controller;
      const { signal } = controller;
      
      // Prepare request data with cache and chatId if available
      const requestData: {
        messages: ChatMessage[],
        model: string,
        cache_id?: string, // cache_id is optional
        chat_id?: string,
        temperature?: number,
        max_tokens?: number
      } = {
        messages: historyForAPI,
        model
      };

      if (generationSettings.temperature !== undefined) {
        requestData.temperature = generationSettings.temperature;
      }
      if (generationSettings.maxTokens !== undefined) {
        requestData.max_tokens = generationSettings.maxTokens;
      }
      
      // Add cache_id if we have one (either pre-existing or newly created)
      // and this message includes at least one document.
      if (cacheId && documentAttachments.length > 0) {
        requestData.cache_id = cacheId;
      }
      
      // Always add chat_id, but determine if it's a new chat based on backend existence
      requestData.chat_id = chatId;
      
      if (!chatExistsInBackend) {
        console.log('Starting a new conversation');
        isInitialStreamRef.current = true; // Mark this as an initial stream
      }

      const activeProfile = localStorage.getItem('atlas_active_profile');
      if (activeProfile) {
        (requestData as { profile?: string } & typeof requestData).profile = activeProfile;
      }
      
      // Make the POST request
      console.log('📡 [SEND-STREAM] Starting regular streaming mode with request data:', { 
        chatId: requestData.chat_id?.slice(-8) || 'new',
        messageCount: requestData.messages.length,
        model: requestData.model,
        hasCache: !!requestData.cache_id,
        hasGenerationSettings: !!(requestData.temperature || requestData.max_tokens)
      });
      const response = await fetch('/api/chat', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Accept': 'text/event-stream',
        },
        body: JSON.stringify(requestData),
        signal
      });
      
      if (!response.ok) {
        // Handle HTTP errors
        const errorData = await response.json();
        throw new Error(errorData.error || `HTTP error! Status: ${response.status}`);
      }
      
      // Get the reader from the response body
      const reader = response.body?.getReader();
      if (!reader) {
        throw new Error('Failed to get reader from response');
      }
      
      // Mark that we have an active stream
      hasActiveStreamRef.current = true;
      
      // Set streaming flag immediately when we start reading
      if (!chatId) {
        console.log('🚀 [SSE] Setting streaming flag to true for new chat');
        setIsStreaming(true);
        currentIsStreamingRef.current = true;
        // Also ensure the initial stream flag is set
        isInitialStreamRef.current = true;
      }
      
      // When we get the first chunk for Gemini 2.5 Pro, switch from thinking to streaming
      let firstChunkReceived = false;
      
      // Read the stream
      const decoder = new TextDecoder();
      let responseBuffer = '';
      
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        
        const chunk = decoder.decode(value, { stream: true });
        responseBuffer += chunk;
        
        // Process complete SSE messages
        const messages = responseBuffer.split('\n\n');
        // Keep the last part if it's incomplete
        responseBuffer = messages.pop() || '';
        
        for (const message of messages) {
          if (message.startsWith('data:')) {
            try {
              const data = message.substring(5).trim();
              
              // Handle chat metadata events from backend
              let isMetadataEvent = false;
              try {
                const parsedData = JSON.parse(data);
                
                if (parsedData.type === 'chat_created') {
                  console.log(`🎉 [SSE-METADATA] Chat created metadata received: ${parsedData.chat_id.slice(-8)} - updating with backend data`);
                  
                  // Mark that the chat now exists in backend
                  setChatExistsInBackend(true);
                  
                  // Update sidebar with authoritative backend data (this will replace optimistic UI)
                  if (isActive) {
                    window.dispatchEvent(new CustomEvent('chat-updated', {
                      detail: { 
                        chatId: parsedData.chat_id,
                        title: parsedData.title,
                        model: parsedData.model,
                        created_at: parsedData.created_at
                      }
                    }));
                  } else {
                    window.dispatchEvent(new CustomEvent('chat-background-updated', {
                      detail: { 
                        chatId: parsedData.chat_id,
                        title: parsedData.title,
                        model: parsedData.model,
                        created_at: parsedData.created_at
                      }
                    }));
                  }
                  
                  isMetadataEvent = true;
                } else if (parsedData.type === 'chat_resumed') {
                  console.log(`🔄 [SSE-CHAT-RESUMED] Chat resumed: ${parsedData.chat_id.slice(-8)}`);
                  isMetadataEvent = true;
                }
              } catch (e) {
                // Ignore parse errors for non-JSON chunks
                console.debug('Non-critical JSON parsing error in SSE stream:', e);
              }
              
              // Only process as content chunk if it's not a metadata event
              if (!isMetadataEvent) {
                // When receiving the first chunk, transition from thinking to streaming for Gemini 2.5 Pro
                if (isGemini25Pro && !firstChunkReceived) {
                  setIsThinking(false);
                  setIsStreaming(true);
                  firstChunkReceived = true;
                  
                  // ISSUE 1 FIX: Clear thinking state from background when stream actually starts
                  if (chatId) {
                    chatManager.clearThinkingState(chatId);
                  }
                  
                  // If thinking timeout is still active, clear it
                  if (thinkingTimeoutRef.current !== null) {
                    clearTimeout(thinkingTimeoutRef.current);
                    thinkingTimeoutRef.current = null;
                  }
                }
                
                // Process the chunk as normal
                processStreamChunk(data);
              } else {
                // Metadata events are processed separately, no content to stream
              }
            } catch (e) {
              console.error('Error parsing SSE data:', e);
            }
          }
        }
      }
      
      // If we exit the loop and haven't finalized yet, do it now
      if (isStreaming || isThinking) {
        finalizeStream(false); // Not aborted, just completed
      }
      
      // After sending a message, refresh chat history
      if (chatId) {
        if (isActive) {
          // For active chats, use the normal chat-updated event
          window.dispatchEvent(new CustomEvent('chat-updated', {
            detail: { chatId }
          }));
        } else {
          // For background chats, use a different event that only refreshes sidebar without auto-switching
          window.dispatchEvent(new CustomEvent('chat-background-updated', {
            detail: { chatId }
          }));
        }
      }
      
    } catch (error) {
      // Check if this was an intentional abort
      const wasAborted = error instanceof DOMException && error.name === 'AbortError';
      
      if (wasAborted) {
        console.log(`❌ [ABORT] Request aborted for chat ${chatId?.slice(-8)}:`, {
          isActive: isActive,
          shouldTransitionToBackground: backgroundProcessingEnabled && !isActive
        });
        
        // If this was an inactive chat that should have background processing, preserve the state
        if (backgroundProcessingEnabled && !isActive && chatId) {
          console.log(`🔄 [ABORT-RECOVER] Preserving background state for aborted inactive chat ${chatId.slice(-8)}`);
          // Don't finalize the stream - let the background state remain
          setLoading(false);
          setIsThinking(false);
        } else {
          console.log(`🔄 [ABORT-FINALIZE] Finalizing aborted stream for chat ${chatId?.slice(-8)}`);
          // For aborted requests that can't be background processed, remove the partial message
          finalizeStream(true);
        }
      } else {
        console.error('Error sending message:', error);
        // For other errors, show an error message
        setLoading(false);
        setIsThinking(false); // Reset thinking state on error too
        
        // No more temporary placeholder cleanup needed - backend handles chat creation properly
        
        // Add error message as assistant message
        setMessages(prev => {
          // If there's already a blank assistant message (from thinking state), 
          // replace it with the error message
          if (prev.length > 0 && prev[prev.length - 1].role === 'assistant' && 
              prev[prev.length - 1].content === '') {
            const newMessages = [...prev];
            newMessages[prev.length - 1] = {
              role: 'assistant',
              content: `Sorry, there was an error processing your request: ${error instanceof Error ? error.message : 'Unknown error'}`
            };
            return newMessages;
          }
          
          // If the last message is from the user (no assistant message created yet),
          // add a new assistant message with the error
          if (prev.length > 0 && prev[prev.length - 1].role === 'user') {
            return [
              ...prev,
              { 
                role: 'assistant', 
                content: `Sorry, there was an error processing your request: ${error instanceof Error ? error.message : 'Unknown error'}`
              }
            ];
          } 
          
          // Otherwise, just return the current messages unchanged
          return prev;
        });
      }
    } finally {
      if (abortControllerRef.current === null) {
        // Only reset loading if we weren't aborted (reset handles this already)
        setLoading(false);
        setIsThinking(false); // Make sure thinking state is reset
      }
    }
  };

  const handleModelChange = (modelId: string) => {
    setModel(modelId);
    setModelDropdownOpen(false);
  };

  const toggleModelDropdown = () => {
    setModelDropdownOpen(!modelDropdownOpen);
  };

  const selectedModel = models.find(m => m.id === model);

  // Enhanced attachment preview renderer
  const renderAttachmentPreview = (attachment: FileAttachment) => {
    if (attachment.uploading) {
        return (
            <div className="attachment-uploading">
                <div className="upload-spinner"></div>
                <span>Uploading{attachment.is_large_file ? ' large file' : ''}...</span>
            </div>
        );
    }
    
    if (attachment.upload_error) {
        return (
            <div className="attachment-error">
                <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" className="error-icon">
                    <path fillRule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zM8.28 7.22a.75.75 0 00-1.06 1.06L8.94 10l-1.72 1.72a.75.75 0 101.414 1.414L10 11.06l1.72 1.72a.75.75 0 101.414-1.414L11.06 10l1.72-1.72a.75.75 0 00-1.414-1.414L10 8.94 8.28 7.22z" clipRule="evenodd" />
                </svg>
                <span>Upload Failed</span>
            </div>
        );
    }
    
    // Show processing state for files that need processing
    if (attachment.processing) {
        const processLabel = attachment.file_type === 'video' ? 'Processing video...' : 'Processing file...';
        return (
            <div className="attachment-processing">
                <div className="processing-spinner"></div>
                <span>{processLabel}</span>
            </div>
        );
    }
    
    // Extract document details outside the switch to avoid lexical declaration errors
    const isPdf = attachment.mime_type === 'application/pdf';
    const fileExtension = attachment.original_name.split('.').pop()?.toLowerCase() || '';
    
    // Add file type specific rendering
    switch (attachment.file_type) {
        case 'image':
            return (
                <div className="image-preview">
                    <img src={attachment.local_url} alt={attachment.original_name} />
                </div>
            );
        case 'video':
            return (
                <div className="video-preview">
                    <video controls>
                        <source src={attachment.local_url} type={attachment.mime_type} />
                        Your browser does not support the video tag.
                    </video>
                </div>
            );
        case 'audio':
            return (
                <div className="audio-preview">
                    <audio controls>
                        <source src={attachment.local_url} type={attachment.mime_type} />
                        Your browser does not support the audio tag.
                    </audio>
                </div>
            );
        case 'document':
            // Enhanced document preview
            return (
                <div className="document-preview">
                    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" className="document-icon">
                        <path fillRule="evenodd" d="M4 4a2 2 0 012-2h4.586A2 2 0 0112 2.586L15.414 6A2 2 0 0116 7.414V16a2 2 0 01-2 2H6a2 2 0 01-2-2V4zm2 6a1 1 0 011-1h6a1 1 0 110 2H7a1 1 0 01-1-1zm1 3a1 1 0 100 2h6a1 1 0 100-2H7z" clipRule="evenodd" />
                    </svg>
                    <span className="document-name">{attachment.original_name}</span>
                    {isPdf && (
                        <span className="document-type">PDF Document</span>
                    )}
                    {!isPdf && (
                        <span className="document-type">{fileExtension.toUpperCase()} File</span>
                    )}
                </div>
            );
        default:
            return (
                <div className="generic-preview">
                    <span>{attachment.original_name}</span>
                </div>
            );
    }
  };

  // Update the checkDebugInfo function with useCallback
  const checkDebugInfo = useCallback(async () => {
    if (!chatExistsInBackend) {
      console.log('No active chat session to debug');
      return;
    }
    
    try {
      console.log('Fetching debug info for active chats...');
      const response = await fetch('/api/debug/chats');
      if (!response.ok) {
        console.error('Failed to fetch debug info:', response.statusText);
        return;
      }
      
      const data: { active_chats: ChatDebugInfo[], count: number } = await response.json();
      console.log('Debug info for active chats:', data);
      
      // Highlight the current chat
      const currentChat = data.active_chats.find((chat: ChatDebugInfo) => chat.chat_id === chatId);
      if (currentChat) {
        console.log('Current chat session:', currentChat);
      } else {
        console.warn('Current chat ID not found in active sessions!');
      }
    } catch (error) {
      console.error('Error fetching debug info:', error);
    }
  }, [chatId, chatExistsInBackend]);

  // Add key event listener for debug information
  useEffect(() => {
    if (!isActive) return;
    // Add a hidden keypress handler for debugging
    const handleKeyPress = (e: KeyboardEvent) => {
      // Ctrl+Alt+D to show debug info
      if (e.ctrlKey && e.altKey && e.key === 'd') {
        e.preventDefault();
        checkDebugInfo();
      }
    };
    
    // Handle the reset-chat event - resets the current chat UI
    const handleResetChat = () => {
      if (!isActive) return;
      console.log('Received reset-chat event, resetting current chat');
      resetChat();
    };
    
    // Handle the new-chat event - creates a new chat without erasing history
    const handleNewChat = () => {
      if (!isActive) return;
      console.log('Received new-chat event, creating a new chat');
      
      // Check if this chat has any background processing state (including pending)
      const hasBackgroundState = chatManager.isProcessingInBackground(chatId);
      
      // If there's an active request, check if we should transition to background instead of aborting
      if (abortControllerRef.current) {
        // If background processing is enabled and the chat is streaming OR has background state, transition to background
        if (backgroundProcessingEnabled && (isStreaming || hasBackgroundState) && chatId) {
          console.log(`🔄 [NEW-CHAT] Transitioning chat ${chatId.slice(-8)} to background processing (isStreaming: ${isStreaming}, hasBackgroundState: ${hasBackgroundState})`);
          
          // Mark this chat as background streaming to preserve the request
          chatManager.markAsBackgroundStreaming(chatId);
          
          // Don't abort the request - let it continue in background
          // Just clean up the UI state
          setIsCanceling(false);
          
          console.log(`🔄 [NEW-CHAT] Chat ${chatId.slice(-8)} moved to background, request continues`);
        } else {
          // No background processing available or not streaming - abort as before
          console.log(`🔄 [NEW-CHAT] Aborting request (background disabled: ${!backgroundProcessingEnabled}, not streaming: ${!isStreaming}, no background state: ${!hasBackgroundState})`);
          setIsCanceling(true);
          abortControllerRef.current.abort();
          abortControllerRef.current = null;
          
          // Reset canceling state after a short delay to show feedback
          setTimeout(() => {
            setIsCanceling(false);
          }, 300);
        }
      } else if (hasBackgroundState && backgroundProcessingEnabled && chatId) {
        // Even if no active request, ensure background state is preserved
        console.log(`🔄 [NEW-CHAT] No active request but has background state, ensuring background processing continues for ${chatId.slice(-8)}`);
        chatManager.markAsBackgroundStreaming(chatId);
      }
      
      // Clean up any object URLs
      attachments.forEach(attachment => {
        if (attachment.local_url) {
          URL.revokeObjectURL(attachment.local_url);
        }
      });
      
      // Reset document cache
      setDocumentCache(null);
      
      // Reset all UI states
      setMessages([]);
      setLoading(false);
      setIsStreaming(false);
      setIsThinking(false);
      // setShouldAutoScroll(true); // Respect user's scroll choice
      userInteractedWithScrollRef.current = false; // On new chat, assume fresh state
      accumulatedContentRef.current = '';
      setAttachments([]);
      
      // Clear thinking timeout if exists
      if (thinkingTimeoutRef.current !== null) {
        clearTimeout(thinkingTimeoutRef.current);
        thinkingTimeoutRef.current = null;
      }
    };
    
    window.addEventListener('keydown', handleKeyPress);
    window.addEventListener('reset-chat', handleResetChat);
    window.addEventListener('new-chat', handleNewChat);
    
    return () => {
      window.removeEventListener('keydown', handleKeyPress);
      window.removeEventListener('reset-chat', handleResetChat);
      window.removeEventListener('new-chat', handleNewChat);
    };
  }, [checkDebugInfo, resetChat, attachments, setChatId, setDocumentCache, setMessages, setLoading, setIsStreaming, setIsThinking, setShouldAutoScroll, setIsCanceling, isActive, chatId]);

  // Load microphone settings from localStorage on component mount
  useEffect(() => {
    const savedSettings = localStorage.getItem('micSettings');
    if (savedSettings) {
      try {
        setMicSettings(JSON.parse(savedSettings));
      } catch (e) {
        console.error('Error parsing saved microphone settings:', e);
      }
    }
  }, []);

  // Function to save microphone settings to localStorage
  const saveMicSettings = (settings: typeof micSettings) => {
    localStorage.setItem('micSettings', JSON.stringify(settings));
    setMicSettings(settings);
  };

  // Load generation settings from localStorage on component mount
  useEffect(() => {
    const saved = localStorage.getItem('generationSettings');
    if (saved) {
      try {
        const parsed = JSON.parse(saved);
        setGenerationSettings(parsed);
      } catch (e) {
        console.error('Error parsing saved generation settings:', e);
      }
    }
  }, []);

  // Function to handle threshold change
  const handleThresholdChange = (event: React.ChangeEvent<HTMLInputElement>) => {
    const newValue = parseInt(event.target.value, 10);
    const newSettings = { ...micSettings, silenceThreshold: newValue };
    saveMicSettings(newSettings);
  };

  // Function to handle silence duration change
  const handleSilenceDurationChange = (event: React.ChangeEvent<HTMLInputElement>) => {
    const newValue = parseFloat(event.target.value);
    const newSettings = { ...micSettings, silenceDuration: newValue };
    saveMicSettings(newSettings);
  };

  // Function to visualize audio levels
  const visualizeAudio = () => {
    if (!analyserRef.current || !canvasRef.current || !audioDataRef.current) {
      return;
    }

    const canvas = canvasRef.current;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    // Clear the canvas
    ctx.clearRect(0, 0, canvas.width, canvas.height);

    // Get audio levels
    analyserRef.current.getByteFrequencyData(audioDataRef.current);

    // Calculate average
    let sum = 0;
    for (let i = 0; i < audioDataRef.current.length; i++) {
      sum += audioDataRef.current[i];
    }
    const average = sum / audioDataRef.current.length;

    // Draw background
    ctx.fillStyle = '#f0f0f0';
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    // Draw audio levels
    ctx.fillStyle = average > micSettings.silenceThreshold ? '#4CAF50' : '#9E9E9E';
    const barHeight = (average / 255) * canvas.height;
    ctx.fillRect(0, canvas.height - barHeight, canvas.width, barHeight);

    // Draw threshold line
    ctx.strokeStyle = '#FF5722';
    ctx.lineWidth = 2;
    
    // Map the threshold value from slider range (5-50) to a visible portion of the canvas (20%-80%)
    // This ensures the red line moves more noticeably when adjusting the slider
    const minVisible = canvas.height * 0.2; // 20% from the top
    const maxVisible = canvas.height * 0.8; // 80% from the top
    const visibleRange = maxVisible - minVisible;
    
    // Normalize the threshold value to 0-1 range based on slider min-max
    const normalizedThreshold = (micSettings.silenceThreshold - 5) / (50 - 5);
    
    // Calculate the position in the visible canvas area
    const thresholdY = maxVisible - (normalizedThreshold * visibleRange);
    
    ctx.beginPath();
    ctx.moveTo(0, thresholdY);
    ctx.lineTo(canvas.width, thresholdY);
    ctx.stroke();

    // Continue animation
    animationFrameRef.current = requestAnimationFrame(visualizeAudio);
  };

  // Function to process audio when silence is detected
  const processAudioChunk = async () => {
    if (audioChunksRef.current.length === 0 || !isSpeechDetectedRef.current) {
      return;
    }

    // Skip transcription if we're in test mode
    if (showSettings) {
      // Just reset audio chunks and flags in test mode
      audioChunksRef.current = [];
      isSpeechDetectedRef.current = false;
      silenceStartRef.current = null;
      return;
    }

    // Save the current audio chunks for processing
    const chunksToProcess = [...audioChunksRef.current];
    const currentMimeType = mediaRecorderRef.current?.mimeType || 'audio/webm';
    
    // Reset audio chunks for next recording segment
    audioChunksRef.current = [];
    isSpeechDetectedRef.current = false;
    silenceStartRef.current = null;

    setIsProcessingSpeech(true);
    
    try {
      // Get the MIME type without any parameters (strip any content after semicolon)
      const mimeType = currentMimeType.split(';')[0]; // Strip any parameters like codecs
      
      // Create blob from the saved chunks
      const audioBlob = new Blob(chunksToProcess, { type: mimeType });
      
      console.log(`Processing audio chunk: ${chunksToProcess.length} chunks, size: ${audioBlob.size} bytes, type: ${mimeType}`);
      
      // Only process if we have meaningful audio data
      if (audioBlob.size < 1000) {
        console.warn('Audio data too small, skipping transcription');
        setIsProcessingSpeech(false);
        return;
      }
      
      // Create FormData for submission
      const formData = new FormData();
      
      // Get extension from MIME type (e.g., 'audio/webm' -> 'webm')
      const fileExt = mimeType.split('/')[1] || 'webm';
      
      // Add audio file with clean filename
      formData.append('audio', audioBlob, `recording${Date.now()}.${fileExt}`);
      
      // Send to backend for processing
      const response = await fetch('/api/transcribe', {
        method: 'POST',
        body: formData,
      });
      
      const data = await response.json();
      
      if (!response.ok) {
        throw new Error(data.details || `Error: ${response.status}`);
      }
      
      // Set the transcribed text to the input
      if (data.text) {
        setInput(prev => prev + (prev ? ' ' : '') + data.text);
        
        // Focus on textarea
        if (textareaRef.current) {
          textareaRef.current.focus();
        }
      } else {
        console.warn('No transcription received');
      }
    } catch (error) {
      console.error('Error transcribing speech:', error);
      alert(`Failed to transcribe speech: ${error instanceof Error ? error.message : 'Unknown error'}`);
    } finally {
      setIsProcessingSpeech(false);
    }
  };

  // Function to stop recording
  const stopRecording = () => {
    // Clear intervals and animation
    if (silenceDetectionIntervalRef.current) {
      clearInterval(silenceDetectionIntervalRef.current);
      silenceDetectionIntervalRef.current = null;
    }
    
    if (animationFrameRef.current) {
      cancelAnimationFrame(animationFrameRef.current);
      animationFrameRef.current = null;
    }
    
    // Save current audio state before stopping
    const hasAudioToProcess = audioChunksRef.current.length > 0 && isSpeechDetectedRef.current && !showSettings;
    
    // Stop media recorder if it's active
    if (mediaRecorderRef.current && mediaRecorderRef.current.state === 'recording') {
      mediaRecorderRef.current.stop();
      mediaRecorderRef.current = null;
    }
    
    // Process any remaining audio, but only if not in settings/test mode
    if (hasAudioToProcess) {
      processAudioChunk();
    }
    
    setIsRecording(false);
  };

  // Function to handle microphone button click
  const handleMicrophoneClick = async () => {
    // If already recording, stop recording
    if (isRecording) {
      stopRecording();
      return;
    }

    // Start recording with optional test mode
    await startRecording(false);
  };

  // Function to start recording with optional test mode
  const startRecording = async (testMode = false) => {
    try {
      // Reset audio processing state
      setIsProcessingSpeech(false);
      
      // Request microphone permissions
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      
      // Create audio context for analyzing audio levels
      const audioContext = new AudioContext();
      const audioSource = audioContext.createMediaStreamSource(stream);
      const analyser = audioContext.createAnalyser();
      analyser.fftSize = 256;
      audioSource.connect(analyser);
      analyserRef.current = analyser;
      
      // Create a buffer for analyzing audio data
      const bufferLength = analyser.frequencyBinCount;
      const dataArray = new Uint8Array(bufferLength);
      audioDataRef.current = dataArray;
      
      // Clear any previous audio chunks
      audioChunksRef.current = [];
      
      // Use a clean MIME type without codec parameters
      // Try different formats in order of preference, without codec parameters
      let mimeType = 'audio/webm';
      
      if (MediaRecorder.isTypeSupported('audio/wav')) {
        mimeType = 'audio/wav';
      } else if (MediaRecorder.isTypeSupported('audio/mp3')) {
        mimeType = 'audio/mp3'; 
      } else if (MediaRecorder.isTypeSupported('audio/webm')) {
        mimeType = 'audio/webm';
      }
          
      console.log(`Using audio format: ${mimeType}`);
      
      const mediaRecorder = new MediaRecorder(stream, {
        mimeType: mimeType
      });
      mediaRecorderRef.current = mediaRecorder;
      
      // Reset state flags
      isSpeechDetectedRef.current = false;
      silenceStartRef.current = null;
      
      // Start recording
      setIsRecording(true);
      
      // Collect data frequently to avoid large chunks
      mediaRecorder.start(500);

      // Start visualizing audio if we're in settings mode
      if (showSettings && canvasRef.current) {
        animationFrameRef.current = requestAnimationFrame(visualizeAudio);
      }
      
      mediaRecorder.addEventListener("dataavailable", (event) => {
        if (event.data.size > 0) {
          audioChunksRef.current.push(event.data);
        }
      });
      
      mediaRecorder.addEventListener("stop", () => {
        // Stop all tracks to release microphone
        stream.getTracks().forEach(track => track.stop());
        
        // Close audio context
        audioContext.close();
        
        // Process any final audio if needed
        if (audioChunksRef.current.length > 0 && isSpeechDetectedRef.current && !testMode) {
          processAudioChunk();
        }
        
        setIsRecording(false);
      });
      
      // Setup silence detection interval
      silenceDetectionIntervalRef.current = setInterval(() => {
        // Get current audio levels
        analyser.getByteFrequencyData(dataArray);
        
        // Calculate average audio level
        let sum = 0;
        for (let i = 0; i < bufferLength; i++) {
          sum += dataArray[i];
        }
        const average = sum / bufferLength;
        
        // Check if speech is detected
        const isSpeech = average > micSettings.silenceThreshold;
        
        // If we detect speech for the first time
        if (isSpeech && !isSpeechDetectedRef.current) {
          console.log("Speech detected, recording...");
          isSpeechDetectedRef.current = true;
          silenceStartRef.current = null;
        }
        
        // If we're recording speech and detect silence
        if (!isSpeech && isSpeechDetectedRef.current) {
          // Start counting silence duration if not already started
          if (silenceStartRef.current === null) {
            console.log("Potential silence detected, starting timer...");
            silenceStartRef.current = Date.now();
          } else {
            // Check if silence duration exceeds threshold
            const currentSilence = (Date.now() - silenceStartRef.current) / 1000;
            
            if (currentSilence > micSettings.silenceDuration) {
              console.log(`Silence detected for ${currentSilence.toFixed(1)}s, processing chunk`);
              
              // Process the current audio chunk if not in test mode
              if (!testMode) {
                // For auto-transcription, first stop the recorder
                if (mediaRecorderRef.current && mediaRecorderRef.current.state === 'recording') {
                  // Save audio state before stopping
                  const hasAudioToProcess = audioChunksRef.current.length > 0 && isSpeechDetectedRef.current;
                  
                  // Stop the recorder to properly release resources
                  mediaRecorderRef.current.stop();
                  
                  // Start a new recorder after processing
                  if (hasAudioToProcess) {
                    // Use setTimeout to ensure proper sequence of operations
                    setTimeout(() => {
                      // Only restart if we're still supposed to be recording
                      if (isRecording) {
                        startRecording(testMode);
                      }
                    }, 500);
                  }
                  
                  // Clear this interval as we're restarting the recording
                  if (silenceDetectionIntervalRef.current) {
                    clearInterval(silenceDetectionIntervalRef.current);
                    silenceDetectionIntervalRef.current = null;
                  }
                  
                  return; // Exit the interval callback as we're resetting everything
                } else {
                  processAudioChunk();
                }
              }
              
              // Reset silence start time for next speech segment
              silenceStartRef.current = null;
            }
          }
        } else if (isSpeech) {
          // Reset silence timer if we hear speech again
          silenceStartRef.current = null;
        }
      }, 100); // Check every 100ms
      
      // Maximum recording time as a fallback (2 minutes)
      setTimeout(() => {
        if (isRecording) {
          console.log("Maximum recording time reached, stopping");
          stopRecording();
        }
      }, 120000);
      
    } catch (error) {
      console.error('Error accessing microphone:', error);
      alert('Could not access microphone. Please check permissions and try again.');
      setIsRecording(false);
      setIsProcessingSpeech(false);
    }
  };

  // Function to toggle settings panel
  const toggleSettings = () => {
    const wasShowingSettings = showSettings;
    setShowSettings(!showSettings);
    
    // If we're showing settings and we're recording, start visualization
    if (!wasShowingSettings && isRecording && analyserRef.current && audioDataRef.current) {
      animationFrameRef.current = requestAnimationFrame(visualizeAudio);
    }
    
    // If we're hiding settings, stop visualization
    if (wasShowingSettings && animationFrameRef.current) {
      cancelAnimationFrame(animationFrameRef.current);
      animationFrameRef.current = null;
    }
    
    // If we're hiding settings and recording is active, stop the recording
    if (wasShowingSettings && isRecording) {
      console.log("Settings closed while recording, stopping audio test");
      stopRecording();
    }
  };


  // Add handler for active chat deletion
  useEffect(() => {
    if (!isActive) return;
    const handleDeleteActiveChat = () => {
      console.log(`🗑️ [DELETE-CHAT] Active chat ${chatId?.slice(-8)} has been deleted, clearing chat view`);
      
      // If there's an active request, cancel it (chat is being deleted so no background processing)
      if (abortControllerRef.current) {
        console.log(`🗑️ [DELETE-CHAT] Aborting streaming request for deleted chat ${chatId?.slice(-8)}`);
        abortControllerRef.current.abort();
        abortControllerRef.current = null;
      }
      
      // Clean up any background state for this chat since it's being deleted
      if (chatId) {
        console.log(`🗑️ [DELETE-CHAT] Cleaning up background state for deleted chat ${chatId.slice(-8)}`);
        chatManager.clearBackgroundStateForChat(chatId);
      }
      
      // Reset all states
      setMessages([]);
      setLoading(false);
      setIsStreaming(false);
      setIsThinking(false);
      // setShouldAutoScroll(true); // Respect user's scroll choice
      userInteractedWithScrollRef.current = false; // On delete, assume fresh state
      accumulatedContentRef.current = '';

      // Show a message to the user
      setMessages([{
        role: 'assistant',
        content: 'This chat has been deleted. A new chat will be created.'
      }]);
    };
    
    window.addEventListener('delete-active-chat', handleDeleteActiveChat);

    return () => {
      window.removeEventListener('delete-active-chat', handleDeleteActiveChat);
    };
  }, [setMessages, setLoading, setIsStreaming, setIsThinking, setShouldAutoScroll, setChatId, isActive, chatId]);

  // Listen for generation settings changes from Settings Window
  useEffect(() => {
    const handleSettingsChange = (event: CustomEvent) => {
      if (event.detail.key === 'generationSettings') {
        setGenerationSettings(event.detail.value);
      }
    };

    window.addEventListener('settingsChanged', handleSettingsChange as EventListener);
    return () => {
      window.removeEventListener('settingsChanged', handleSettingsChange as EventListener);
    };
  }, []);

  return (
    <div className="chat-container">
      <div className="header">
        <div className="logo-container">
          <h1 className="app-title">ATLAS</h1>
          <span className="app-subtitle">Advanced AI System</span>
        </div>
        <div className="controls-container">
          <div className="model-selector" onClick={toggleModelDropdown}>
            <div className="selected-model">
              <div className="model-indicator"></div>
              <span>{selectedModel?.name}</span>
              <svg className={`dropdown-arrow ${modelDropdownOpen ? 'open' : ''}`} xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor">
                <path fillRule="evenodd" d="M5.293 7.293a1 1 0 011.414 0L10 10.586l3.293-3.293a1 1 0 111.414 1.414l-4 4a1 1 0 01-1.414 0l-4-4a1 1 0 010-1.414z" clipRule="evenodd" />
              </svg>
            </div>
            {modelDropdownOpen && (
              <div className="model-dropdown">
                {models.map(m => (
                  <div 
                    key={m.id} 
                    className={`model-option ${m.id === model ? 'active' : ''}`}
                    onClick={() => handleModelChange(m.id)}
                  >
                    <div className="model-option-content">
                      <div className="model-name">{m.name}</div>
                      <div className="model-description">{m.description}</div>
                    </div>
                    {m.id === model && (
                      <svg className="check-icon" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor">
                        <path fillRule="evenodd" d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z" clipRule="evenodd" />
                      </svg>
                    )}
                  </div>
                ))}
              </div>
            )}
          </div>
          <button
            onClick={toggleSettings}
            className="settings-button"
            title="Microphone Settings"
          >
            <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="settings-icon">
              <circle cx="12" cy="12" r="3"></circle>
              <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z"></path>
            </svg>
          </button>
          {showSummarizeButton && (
            <button
              onClick={summarizeChat}
              className="summary-button"
              title="Summarize chat"
              disabled={isSummarizing}
            >
              {isSummarizing ? 'Summarizing...' : 'Summarize'}
            </button>
          )}
          <button
            onClick={resetChat}
            className={`reset-button ${isCanceling ? 'canceling' : ''}`}
            title="Clear all messages"
            disabled={isCanceling}
          >
            Reset Chat
          </button>
        </div>
      </div>

      {/* Settings modal */}
      {showSettings && (
        <div className="settings-overlay">
          <div className="settings-panel">
            <div className="settings-header">
              <h2>Microphone Settings</h2>
              <button className="close-button" onClick={toggleSettings}>
                <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <line x1="18" y1="6" x2="6" y2="18"></line>
                  <line x1="6" y1="6" x2="18" y2="18"></line>
                </svg>
              </button>
            </div>
            <div className="settings-content">
              <div className="audio-visualization">
                <h3>Audio Level</h3>
                <canvas 
                  ref={canvasRef} 
                  width="280" 
                  height="100" 
                  className="audio-canvas"
                ></canvas>
                {isRecording && (
                  <div className="speech-status">
                    {isSpeechDetectedRef.current ? (
                      <span className="speech-detected">Speech Detected</span>
                    ) : (
                      <span className="no-speech">No Speech Detected</span>
                    )}
                  </div>
                )}
                <div className="audio-controls">
                  <div className="control-group">
                    <label htmlFor="threshold">Silence Threshold: {micSettings.silenceThreshold}</label>
                    <input 
                      type="range" 
                      id="threshold" 
                      min="1" 
                      max="50" 
                      step="1" 
                      value={micSettings.silenceThreshold}
                      onChange={handleThresholdChange}
                    />
                    <div className="range-labels">
                      <span>Low</span>
                      <span>High</span>
                    </div>
                  </div>
                  <div className="control-group">
                    <label htmlFor="silenceDuration">Silence Duration: {micSettings.silenceDuration}s</label>
                    <input 
                      type="range" 
                      id="silenceDuration" 
                      min="0.1" 
                      max="5" 
                      step="0.1" 
                      value={micSettings.silenceDuration}
                      onChange={handleSilenceDurationChange}
                    />
                    <div className="range-labels">
                      <span>Short</span>
                      <span>Long</span>
                    </div>
                  </div>
                </div>
              </div>
              <div className="settings-info">
                <p><strong>Silence Threshold:</strong> Adjust how loud your voice needs to be to be detected as speech.</p>
                <p><strong>Silence Duration:</strong> How long to wait after speech stops before processing.</p>
                <p><strong>Testing:</strong> Click the microphone button to start recording, and you'll see the audio levels displayed in real-time.</p>
              </div>
              <div className="test-buttons">
                <button 
                  className={`test-mic-button ${isRecording ? 'recording' : ''}`}
                  onClick={() => {
                    if (isRecording) {
                      stopRecording();
                    } else {
                      startRecording(true); // Start in test mode
                    }
                  }}
                >
                  {isRecording ? 'Stop Test Recording' : 'Test Microphone (No Transcription)'}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}


      {annotationFile && (
        <ImageAnnotationModal
          isOpen={true}
          file={annotationFile}
          onSave={handleAnnotationSave}
          onCancel={handleAnnotationCancel}
        />
      )}

      <div className="messages-container" ref={messagesContainerRef}>
        {messages.length === 0 && !loading && (
          <div className="welcome-message">
            <div className="welcome-icon">
              <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor">
                <path d="M4.5 6.375a4.125 4.125 0 118.25 0 4.125 4.125 0 01-8.25 0zM14.25 8.625a3.375 3.375 0 116.75 0 3.375 3.375 0 01-6.75 0zM1.5 19.125a7.125 7.125 0 0114.25 0v.003l-.001.119a.75.75 0 01-.363.63 13.067 13.067 0 01-6.761 1.873c-2.472 0-4.786-.684-6.76-1.873a.75.75 0 01-.364-.63l-.001-.122zM17.25 19.128l-.001.144a2.25 2.25 0 01-.233.96 10.088 10.088 0 005.06-1.01.75.75 0 00.42-.643 4.875 4.875 0 00-6.957-4.611 8.586 8.586 0 011.71 5.157v.003z" />
              </svg>  
            </div>
            <h2>Welcome to ATLAS</h2>
            <p>Your personal general use AI assistant.</p>
          </div>
        )}
        
        {/* Caching indicator */}
        {isCachingDocuments && (
          <div className="caching-indicator">
            <div className="processing-spinner"></div>
            <span>Optimizing document processing...</span>
          </div>
        )}
        
        {messages.map((message, index) => {
          // Determine if this is the currently streaming message
          const isCurrentlyStreaming = isStreaming && 
              message.role === 'assistant' && 
              index === messages.length - 1 &&
              messages[index - 1]?.role === 'user'; // Make sure it's paired with the previous user message
          
          // Determine if this is the currently thinking message (Gemini 2.5 Pro)
          const isCurrentlyThinking = isThinking && 
              message.role === 'assistant' && 
              index === messages.length - 1 &&
              messages[index - 1]?.role === 'user'; // Make sure it's paired with the previous user message
          
          return (
            <Message 
              key={`message-${index}`} 
              content={message.content} 
              isUser={message.role === 'user'}
              isStreaming={isCurrentlyStreaming}
              isThinking={isCurrentlyThinking}
              attachments={message.attachments}
              isHistoryMessage={message.isHistory} // Add this flag to indicate this is from chat history
              reasoning={message.reasoning} // Pass reasoning tokens to Message component
            />
          );
        })}
        
        <div ref={messagesEndRef} />
      </div>

      <div
        className={`input-container ${isDragActive ? 'drag-active' : ''}`}
        onDragOver={handleDragOver}
        onDragEnter={handleDragOver}
        onDragLeave={handleDragLeave}
        onDrop={handleDrop}
      >
        {isDragActive && (
          <div className="drop-overlay">Drop files here</div>
        )}
        {/* Attachments preview zone - rendered conditionally but positioned absolutely above input */}
        {attachments.length > 0 && (
          <div className="attachments-preview">
            <div className="attachments-count">
              {attachments.length > 1 ? `${attachments.length} files attached` : '1 file attached'}
            </div>
            <div className="attachments-grid">
              {attachments.map((attachment, index) => (
                <div key={index} className="attachment-item">
                  {renderAttachmentPreview(attachment)}
                  <button 
                    className="remove-attachment-btn" 
                    onClick={() => removeAttachment(attachment)}
                    aria-label="Remove attachment"
                  >
                    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor">
                      <path fillRule="evenodd" d="M4.293 4.293a1 1 0 011.414 0L10 8.586l4.293-4.293a1 1 0 111.414 1.414L11.414 10l4.293 4.293a1 1 0 01-1.414 1.414L10 11.414l-4.293 4.293a1 1 0 01-1.414-1.414L8.586 10 4.293 5.707a1 1 0 010-1.414z" clipRule="evenodd" />
                    </svg>
                  </button>
                </div>
              ))}
            </div>
          </div>
        )}
        
        <textarea
          ref={textareaRef}
          className="message-input"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            // Still prevent sending while loading but allow typing
            if (e.key === 'Enter' && !e.shiftKey && !loading && !isUploading) {
              e.preventDefault();
              handleSend();
            } else if (e.key === 'Enter' && !e.shiftKey && (loading || isUploading)) {
              // Prevent new line creation when Enter is pressed but we're loading/uploading
              e.preventDefault();
              // Optionally provide feedback that sending isn't allowed while AI is responding
              if (loading) {
                // Could show a tooltip or other visual feedback here
              }
            }
          }}
          placeholder={loading ? "Waiting for response..." : isUploading ? "Uploading file..." : "Ask ATLAS something..."}
          rows={1}
          // Allow typing even while loading
        />
        
        {/* File upload button */}
        <input 
          type="file" 
          id="file-upload" 
          ref={fileInputRef}
          style={{ display: 'none' }} 
          onChange={handleFileSelect}
          disabled={loading || isUploading}
          multiple
        />
        <button 
          className="attach-button"
          onClick={() => fileInputRef.current?.click()}
          disabled={loading || isUploading}
          aria-label="Attach files"
          title="Attach multiple images, videos, audio files, or documents"
        >
          <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="attach-icon">
            <path d="M21.44 11.05l-9.19 9.19a6 6 0 01-8.49-8.49l9.19-9.19a4 4 0 015.66 5.66l-9.2 9.19a2 2 0 01-2.83-2.83l8.49-8.48" />
          </svg>
        </button>
        
        {/* Microphone button */}
        {showSttButton && (
          <button 
          className={`microphone-button ${isRecording ? 'recording' : ''} ${isProcessingSpeech ? 'processing' : ''}`}
          onClick={handleMicrophoneClick}
          disabled={loading || isUploading}
          aria-label={isRecording ? "Stop recording" : "Start voice input"}
          title={isRecording ? "Stop recording" : "Use voice to input text"}
        >
          {isProcessingSpeech ? (
            <div className="loading-spinner"></div>
          ) : (
            <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="microphone-icon">
              <path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z"></path>
              <path d="M19 10v2a7 7 0 0 1-14 0v-2"></path>
              <line x1="12" y1="19" x2="12" y2="23"></line>
              <line x1="8" y1="23" x2="16" y2="23"></line>
            </svg>
          )}
        </button>
        )}

        {/* Text-to-Speech toggle */}
        {showTtsButton && (
          <button
          className={`tts-button ${ttsEnabled ? 'enabled' : ''}`}
          onClick={() => setTtsEnabled((prev: boolean) => !prev)}
          disabled={!ttsSupported || loading}
          aria-label={ttsEnabled ? 'Disable speech output' : 'Enable speech output'}
          title={
            !ttsSupported
              ? 'Speech output not supported'
              : ttsEnabled
                ? 'Disable speech output'
                : 'Read responses aloud'
          }
        >
          <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="tts-icon">
            <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"></polygon>
            <path d="M15.54 8.46a5 5 0 010 7.07"></path>
            <path d="M19.07 4.93a9 9 0 010 12.73"></path>
          </svg>
        </button>
        )}

        <button
          className="send-button"
          onClick={handleSend}
          disabled={loading || isUploading || (!input.trim() && attachments.length === 0)}
          aria-label={loading ? "Please wait" : isUploading ? "Uploading file..." : "Send message"}
          title={
            loading ? "Please wait for the current response to complete" : 
            isUploading ? "Please wait for file uploads to complete" : 
            "Send message"
          }
        >
          {loading || isUploading ? (
            <div className="loading-spinner"></div>
          ) : (
            <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="send-icon">
              <line x1="22" y1="2" x2="11" y2="13"></line>
              <polygon points="22 2 15 22 11 13 2 9 22 2"></polygon>
            </svg>
          )}
        </button>
      </div>
      
      {/* Background Processing Status Indicator */}
      {backgroundState && backgroundState.status !== 'idle' && !isActive && (
        <div className="background-status-indicator">
          <div className={`status-dot ${backgroundState.status}`}></div>
          <span>Processing in background...</span>
        </div>
      )}

      {/* Background Response Preview */}
      {showBackgroundPreview && backgroundState && backgroundState.currentResponse && (
        <div className="background-response-preview">
          <div className="preview-header">
            <span>Background Response Complete</span>
            <button onClick={() => setShowBackgroundPreview(false)}>✕</button>
          </div>
          <div className="preview-content">
            {backgroundState.currentResponse.slice(0, 200)}
            {backgroundState.currentResponse.length > 200 && '...'}
          </div>
        </div>
      )}
      
      <SummaryModal
        isOpen={summaryModalOpen}
        onClose={() => setSummaryModalOpen(false)}
        summary={summaryContent}
        onUseSummary={useSummaryAsHistory}
      />
    </div>
  );
};

export default Chat;
