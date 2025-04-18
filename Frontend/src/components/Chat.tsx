import { useState, useRef, useEffect, ChangeEvent, useCallback } from 'react';
import Message from './Message';

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
  role: 'user' | 'assistant';
  content: string;
  attachments?: FileAttachment[];
  isHistory?: boolean; // Add this flag to identify messages from history
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

const Chat = () => {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState('');
  const [loading, setLoading] = useState(false);
  const [model, setModel] = useState('gemini-2.5-flash-preview');
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const messagesContainerRef = useRef<HTMLDivElement>(null);
  const [shouldAutoScroll, setShouldAutoScroll] = useState(true);
  const [isStreaming, setIsStreaming] = useState(false);
  const [modelDropdownOpen, setModelDropdownOpen] = useState(false);
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
  const thinkingTimeoutRef = useRef<number | null>(null);
  // Add state for current attachments
  const [attachments, setAttachments] = useState<FileAttachment[]>([]);
  // Add state for tracking if file is uploading
  const [isUploading, setIsUploading] = useState(false);
  // Add ref for file input
  const fileInputRef = useRef<HTMLInputElement>(null);
  // Add a map to track upload abort controllers for each attachment
  const uploadControllersRef = useRef<Map<string, AbortController>>(new Map());
  // Add state for caching
  const [documentCache, setDocumentCache] = useState<string | null>(null);
  const [isCachingDocuments, setIsCachingDocuments] = useState(false);
  const [chatId, setChatId] = useState<string | null>(null);
  // Add state for recording audio
  const [isRecording, setIsRecording] = useState(false);
  // Add state for processing speech to text
  const [isProcessingSpeech, setIsProcessingSpeech] = useState(false);
  // Add state for showing settings
  const [showSettings, setShowSettings] = useState(false);
  // Add state for microphone settings
  const [micSettings, setMicSettings] = useState({
    silenceThreshold: 10, // Default threshold value (0-255)
    silenceDuration: 1.5, // Seconds of silence before processing
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
  const silenceDetectionIntervalRef = useRef<number | null>(null);
  // Add ref for media recorder
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  // Add ref for audio chunks
  const audioChunksRef = useRef<BlobPart[]>([]);
  // Add ref for monitoring speech detection
  const isSpeechDetectedRef = useRef<boolean>(false);
  // Add ref for silence start time
  const silenceStartRef = useRef<number | null>(null);

  // Available models with descriptions
  const models: Model[] = [
    { 
      id: 'gemini-2.5-flash-preview-04-17', 
      name: 'Gemini 2.5 Flash',
      description: 'Fast responses, ideal for simple queries'
    },
    { 
      id: 'gemini-2.5-pro-exp-03-25', 
      name: 'Gemini 2.5 Pro',
      description: 'Advanced model with superior reasoning capabilities'
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
  
  // Enhanced file selection handler
  const handleFileSelect = async (e: ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (!files || files.length === 0) return;
    
    // Process all selected files
    for (let i = 0; i < files.length; i++) {
      const file = files[i];
      console.log(`Selected file ${i+1}/${files.length}: ${file.name}, type: ${file.type}, size: ${file.size} bytes`);
      
      // Check if file type is supported
      const { supported, type } = isFileTypeSupported(file);
      if (!supported) {
          alert(`Unsupported file type: ${file.name}. Please upload an image, video, audio file, or document (PDF, text, etc.)`);
          continue; // Skip this file and process the next one
      }
      
      // Enhanced size warning for large files
      if (file.size > 300 * 1024 * 1024) { // 300MB
          const confirmLargeUpload = window.confirm(
              `The file ${file.name} is very large (${Math.round(file.size / (1024 * 1024))}MB) and may take a long time to upload. ` +
              `Files larger than 20MB use the Gemini File API and can be up to 2GB, but may take longer to process. ` +
              `Continue with upload?`
          );
          if (!confirmLargeUpload) {
              continue; // Skip this file
          }
      }
      
      // Create unique ID for this attachment
      const attachmentId = `${Date.now()}-${i}`;
      
      // Create a temporary local attachment with uploading status
      const localAttachment: FileAttachment = {
          file_id: attachmentId, // Use temp ID until we get real one from server
          file_type: type as 'image' | 'video' | 'audio' | 'document',
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
      
      // Use IIFE (Immediately Invoked Function Expression) to process uploads in parallel
      (async (currentFile, currentAttachmentId) => {
        // Create FormData for upload
        const formData = new FormData();
        formData.append('file', currentFile);
        
        // Create abort controller
        const controller = new AbortController();
        uploadControllersRef.current.set(currentAttachmentId, controller);
        
        try {
            console.log(`Starting file upload for ${currentFile.name}...`);
            
            const response = await fetch('/api/upload', {
                method: 'POST',
                body: formData,
                signal: controller.signal
            });
            
            console.log(`Upload response status for ${currentFile.name}: ${response.status}`);
            
            // Get response as text first to debug any issues
            const responseText = await response.text();
            console.log(`Raw response for ${currentFile.name}: ${responseText.substring(0, 200)}${responseText.length > 200 ? '...' : ''}`);
            
            // Parse the text to JSON
            let data;
            try {
                data = JSON.parse(responseText);
            } catch (parseError) {
                console.error(`Failed to parse response as JSON for ${currentFile.name}:`, parseError);
                throw new Error(`Invalid server response: ${responseText.substring(0, 100)}...`);
            }
            
            if (!response.ok) {
                // Handle error response
                const errorMessage = data?.error || data?.message || 'Unknown upload error';
                if (data?.details) {
                    console.error(`Upload error details for ${currentFile.name}:`, data.details);
                }
                throw new Error(errorMessage);
            }
            
            console.log(`Upload successful for ${currentFile.name}:`, data);
            
            // Make sure we have a valid file_id
            if (!data.file_id && !data.name) {
                throw new Error('Server response missing file_id');
            }
            
            // Determine file processing status - applies to all file types now
            const isStillProcessing = data.needs_processing === true && data.processing_complete === false;
            
            // Handle the response - make sure we have a file_id
            const responseWithFileId = {
                ...data,
                file_id: data.file_id || data.name
            };
            
            // Update attachments
            setAttachments(prev => 
                prev.map(attachment => 
                    attachment.file_id === currentAttachmentId
                        ? { 
                            ...responseWithFileId, 
                            uploading: false, 
                            upload_progress: 100,
                            local_url: attachment.local_url, // Keep the local URL for display
                            processing: isStillProcessing,
                            needs_processing: data.needs_processing
                          }
                        : attachment
                )
            );
            
            // If file needs processing, check its state periodically
            if (isStillProcessing) {
                const fileId = responseWithFileId.file_id;
                console.log(`File ${fileId} (${currentFile.name}) is still processing. Will check status periodically.`);
                
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
                            console.log(`File ${fileId} (${currentFile.name}) state check (${attempts}/${maxAttempts}): ${stateResult.state}`);
                            
                            if (stateResult.ready) {
                                console.log(`File ${fileId} (${currentFile.name}) is now ready for use`);
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
                            console.error(`Error checking file state for ${currentFile.name}:`, error);
                        }
                    }, 5000); // Check every 5 seconds
                };
                
                // Start polling the file state
                pollFileState();
                
                // For the first file that needs processing, show a notification
                if (i === 0) {
                    const processingMessage = files.length > 1 
                        ? "Some files are still being processed after upload. They may take a moment before they can be used in the chat."
                        : "File uploaded successfully but is still being processed. It may take a moment before it can be used in the chat.";
                    alert(processingMessage);
                }
            }
        } catch (error) {
            console.error(`File upload error for ${currentFile.name}:`, error);
            
            // Check if this was an abort error (user cancelled)
            if (error instanceof DOMException && error.name === 'AbortError') {
                console.log(`Upload cancelled by user for ${currentFile.name}`);
                // Remove the attachment completely
                setAttachments(prev => prev.filter(a => a.file_id !== currentAttachmentId));
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
                prev.map(attachment => 
                    attachment.file_id === currentAttachmentId
                        ? { 
                            ...attachment, 
                            uploading: false, 
                            upload_error: errorMessage
                          }
                        : attachment
                )
            );
            
            // Show error to user (only for the first error to avoid multiple alerts)
            if (i === 0) {
                alert(`File upload failed for ${currentFile.name}: ${errorMessage}`);
            }
        } finally {
            // Clean up controller
            uploadControllersRef.current.delete(currentAttachmentId);
            
            // Only update isUploading if no more uploads are in progress
            if (uploadControllersRef.current.size === 0) {
                setIsUploading(false);
            }
        }
      })(file, attachmentId);
    }
    
    // Reset the file input to allow selecting the same files again
    if (fileInputRef.current) {
        fileInputRef.current.value = '';
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

  // Detect scroll events
  useEffect(() => {
    const container = messagesContainerRef.current;
    if (!container) return;

    const handleScroll = () => {
      // Only disable auto-scroll if we're currently streaming a message
      if (!isStreaming) return;

      const { scrollTop, scrollHeight, clientHeight } = container;
      const isScrolledUp = scrollHeight - scrollTop - clientHeight > 100; // 100px threshold
      
      if (isScrolledUp) {
        setShouldAutoScroll(false);
      }
    };

    container.addEventListener('scroll', handleScroll);
    return () => container.removeEventListener('scroll', handleScroll);
  }, [isStreaming]);

  useEffect(() => {
    if (shouldAutoScroll) {
      scrollToBottom();
    }
  }, [messages, shouldAutoScroll]);

  // Close model dropdown when clicking outside
  useEffect(() => {
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
  }, []);

  // Auto-grow textarea based on content
  useEffect(() => {
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
  }, [input]);

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

  const scrollToBottom = () => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  };

  // More stable approach to handling SSE data from the server
  const processStreamChunk = (chunk: string) => {
    // Process each message from the server
    try {
      if (chunk.trim() === '[DONE]') {
        finalizeStream();
        return;
      }

      // Parse the chunk if it's JSON
      try {
        const data = JSON.parse(chunk);
        
        // Store chat ID if received from server
        if (data.chat_id && !chatId) {
          console.log(`Setting chat ID from response: ${data.chat_id}`);
          setChatId(data.chat_id);
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
                // Update existing message with new content
                updatedMessages[lastIndex] = {
                  ...lastMessage,
                  content: accumulatedContentRef.current
                };
              } else {
                // Create new assistant message if needed
                updatedMessages.push({ 
                  role: 'assistant', 
                  content: accumulatedContentRef.current
                });
              }
              
              return updatedMessages;
            });
          });
          
          // Make sure streaming flag is set
          if (!isStreaming) {
            setIsStreaming(true);
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
                  content: accumulatedContentRef.current 
                });
              }
              
              return updatedMessages;
            });
          });
          
          if (!isStreaming) {
            setIsStreaming(true);
          }
        }
      }
    } catch (error) {
      console.error('Error processing chunk:', error);
    }
  };

  // Function to finalize the stream and add to message history
  const finalizeStream = (isAborted = false) => {
    // If aborted, remove the partial assistant message
    if (isAborted) {
      setMessages(prev => {
        // If the last message is an assistant message (streaming), remove it
        if (prev.length > 0 && prev[prev.length - 1].role === 'assistant') {
          return prev.slice(0, -1);
        }
        return prev;
      });
    }
    
    // Reset streaming and loading states
    setIsStreaming(false);
    setLoading(false);
    setIsThinking(false); // Also reset thinking state
    
    // Clear thinking timeout if exists
    if (thinkingTimeoutRef.current !== null) {
      clearTimeout(thinkingTimeoutRef.current);
      thinkingTimeoutRef.current = null;
    }
    
    // Only scroll to bottom for non-aborted messages
    if (!isAborted && shouldAutoScroll) {
      setTimeout(() => { 
        scrollToBottom();
      }, 50); // Small delay for rendering
    }

    // Refocus the textarea after response is complete
    setTimeout(() => {
      if (textareaRef.current) {
        textareaRef.current.focus();
      }
    }, 100); // Small delay to ensure UI updates are complete
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
    // If there's an active request, show canceling state and abort it
    if (abortControllerRef.current) {
      setIsCanceling(true);
      abortControllerRef.current.abort();
      abortControllerRef.current = null;
      
      // Reset canceling state after a short delay to show feedback
      setTimeout(() => {
        setIsCanceling(false);
      }, 800);
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
    setShouldAutoScroll(true);
    accumulatedContentRef.current = '';
    setAttachments([]);
    
    // Clear thinking timeout if exists
    if (thinkingTimeoutRef.current !== null) {
      clearTimeout(thinkingTimeoutRef.current);
      thinkingTimeoutRef.current = null;
    }
  }, [attachments, chatId, setDocumentCache, setMessages, setLoading, setIsStreaming, setIsThinking, setShouldAutoScroll, setIsCanceling]);

  // Enhanced send function to handle document caching and chat history
  const handleSend = async () => {
    // Prevent sending if uploads are in progress
    if (isUploading) {
      alert('Please wait for file uploads to complete before sending your message.');
      return;
    }
    
    // Require either text or at least one attachment to send a message
    if ((!input.trim() && attachments.length === 0) || loading) return;

    // Reset auto-scroll for new message
    setShouldAutoScroll(true);
    
    // Check if we have document attachments that could benefit from caching
    const documentAttachments = attachments.filter(
      attachment => attachment.file_type === 'document' && attachment.file_id
    );
    
    // Create a cache if we have documents
    let cacheId = documentCache;
    if (documentAttachments.length > 0 && !documentCache) {
      // Extract file IDs from document attachments
      const fileIds = documentAttachments
        .map(attachment => attachment.file_id)
        .filter(Boolean) as string[];
        
      if (fileIds.length > 0) {
        // Create a cache for these documents
        cacheId = await createDocumentCache(fileIds);
      }
    }
    
    // Create user message with content and any attachments
    const userMessage: ChatMessage = { 
      role: 'user', 
      content: input,
      attachments: attachments.length > 0 ? attachments.map(a => ({
        file_id: a.file_id,
        file_type: a.file_type,
        mime_type: a.mime_type,
        filename: a.filename,
        original_name: a.original_name
      })) : undefined,
      isHistory: false // Explicitly mark this message as NOT from history
    };
    
    setMessages(prev => [...prev, userMessage]);
    
    // Reset states after adding the message
    setInput('');
    setAttachments([]);
    accumulatedContentRef.current = '';
    setLoading(true);
    
    // Maintain focus on the textarea after sending
    setTimeout(() => {
      if (textareaRef.current) {
        textareaRef.current.focus();
      }
    }, 0);
    
    // For Gemini 2.5 Pro, show thinking state before streaming
    const isGemini25Pro = model === 'gemini-2.5-pro-exp-03-25';
    if (isGemini25Pro) {
      // First set the thinking state
      setIsThinking(true);
      // Add a placeholder message for the thinking state
      setMessages(prev => [...prev, { role: 'assistant', content: '', isHistory: false }]);
      // Add a minimum thinking time to ensure animation shows (at least 1 second)
      thinkingTimeoutRef.current = window.setTimeout(() => {
        thinkingTimeoutRef.current = null;
      }, 1000) as unknown as number; // TypeScript casting for setTimeout
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
        cache_id?: string,
        chat_id?: string
      } = { 
        messages: historyForAPI,
        model
      };
      
      // Add cache_id if we have one and this message includes at least one document
      if (cacheId && documentAttachments.length > 0) {
        requestData.cache_id = cacheId;
      }
      
      // Add chat_id if we have one (to continue the conversation)
      if (chatId) {
        console.log(`Continuing conversation with chat ID: ${chatId}`);
        requestData.chat_id = chatId;
      } else {
        console.log('Starting a new conversation');
      }
      
      // Make the POST request
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
              
              // Check if this message contains a chat ID and update it if needed
              try {
                const parsedData = JSON.parse(data);
                if (parsedData.chat_id && !chatId) {
                  console.log(`Setting chat ID from response: ${parsedData.chat_id}`);
                  setChatId(parsedData.chat_id);
                  
                  // Trigger chat history refresh after getting a new chat ID
                  setTimeout(() => {
                    window.dispatchEvent(new CustomEvent('chat-created', {
                      detail: { chatId: parsedData.chat_id }
                    }));
                  }, 500);
                }
              } catch (e) {
                // Ignore parse errors for non-JSON chunks
                console.debug('Non-critical JSON parsing error in SSE stream:', e);
              }
              
              // When receiving the first chunk, transition from thinking to streaming for Gemini 2.5 Pro
              if (isGemini25Pro && !firstChunkReceived) {
                setIsThinking(false);
                setIsStreaming(true);
                firstChunkReceived = true;
                
                // If thinking timeout is still active, clear it
                if (thinkingTimeoutRef.current !== null) {
                  clearTimeout(thinkingTimeoutRef.current);
                  thinkingTimeoutRef.current = null;
                }
              }
              
              // Process the chunk as normal
              processStreamChunk(data);
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
        setTimeout(() => {
          window.dispatchEvent(new CustomEvent('chat-updated', {
            detail: { chatId }
          }));
        }, 500);
      }
      
    } catch (error) {
      console.error('Error sending message:', error);
      // Check if this was an intentional abort
      const wasAborted = error instanceof DOMException && error.name === 'AbortError';
      
      if (wasAborted) {
        // For aborted requests, remove the partial message
        finalizeStream(true);
      } else {
        // For other errors, show an error message
        setLoading(false);
        setIsThinking(false); // Reset thinking state on error too
        
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
    if (!chatId) {
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
  }, [chatId]);

  // Add key event listener for debug information
  useEffect(() => {
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
      console.log('Received reset-chat event, resetting current chat');
      resetChat();
    };
    
    // Handle the new-chat event - creates a new chat without erasing history
    const handleNewChat = () => {
      console.log('Received new-chat event, creating a new chat');
      
      // If there's an active request, show canceling state and abort it
      if (abortControllerRef.current) {
        setIsCanceling(true);
        abortControllerRef.current.abort();
        abortControllerRef.current = null;
        
        // Reset canceling state after a short delay to show feedback
        setTimeout(() => {
          setIsCanceling(false);
        }, 300);
      }
      
      // Clean up any object URLs
      attachments.forEach(attachment => {
        if (attachment.local_url) {
          URL.revokeObjectURL(attachment.local_url);
        }
      });
      
      // Reset document cache
      setDocumentCache(null);
      
      // Reset chat ID to start a new conversation (without deleting the old one)
      setChatId(null);
      
      // Reset all UI states
      setMessages([]);
      setLoading(false);
      setIsStreaming(false);
      setIsThinking(false);
      setShouldAutoScroll(true);
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
  }, [checkDebugInfo, resetChat, attachments, setChatId, setDocumentCache, setMessages, setLoading, setIsStreaming, setIsThinking, setShouldAutoScroll, setIsCanceling]);

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
      silenceDetectionIntervalRef.current = window.setInterval(() => {
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

  // Add load-chat event handler
  useEffect(() => {
    const handleLoadChat = (event: Event) => {
      const customEvent = event as CustomEvent<{ chatId: string }>;
      if (customEvent.detail && customEvent.detail.chatId) {
        const selectedChatId = customEvent.detail.chatId;
        console.log(`Loading chat with ID: ${selectedChatId}`);
        
        // If there's an active request, cancel it first
        if (abortControllerRef.current) {
          abortControllerRef.current.abort();
          abortControllerRef.current = null;
        }
        
        // Set loading state while we fetch the chat
        setLoading(true);
        
        // Reset some states
        setIsStreaming(false);
        setIsThinking(false);
        setShouldAutoScroll(true);
        accumulatedContentRef.current = '';
        
        // Set the chat ID to the one from the event
        setChatId(selectedChatId);
        
        // Since the backend maintains the chat session state, we need to make a GET request 
        // to retrieve the chat messages for this chat ID
        fetch(`/api/chat/${selectedChatId}`, {
          method: 'GET',
          headers: {
            'Content-Type': 'application/json'
          }
        })
        .then(response => {
          if (!response.ok) {
            throw new Error(`Failed to load chat history: ${response.status} ${response.statusText}`);
          }
          return response.json();
        })
        .then(data => {
          // Set the messages from the loaded chat
          if (data && data.messages) {
            console.log(`Loaded ${data.messages.length} messages for chat ${selectedChatId}`);
            // Mark each message as a history message by adding an isHistory flag
            const historyMessages = data.messages.map((msg: ChatMessage) => ({
              ...msg,
              isHistory: true // Add flag to identify messages from history
            }));
            setMessages(historyMessages);
          } else {
            // If no messages were found, display a helpful message
            setMessages([{
              role: 'assistant',
              content: 'This chat history has been loaded. You can continue your conversation.',
              isHistory: true
            }]);
          }
          // Scroll to bottom after loading chat
          setTimeout(() => {
            messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
          }, 100);
          
          // Emit the load-complete event
          window.dispatchEvent(new CustomEvent('chat-load-complete'));
        })
        .catch(error => {
          console.error('Error loading chat history:', error);
          // Display error message
          setMessages([{
            role: 'assistant',
            content: `Sorry, I couldn't load this chat. ${error.message}`,
            isHistory: true
          }]);
          
          // Still emit the load-complete event
          window.dispatchEvent(new CustomEvent('chat-load-complete'));
        })
        .finally(() => {
          setLoading(false);
        });
      }
    };
    
    window.addEventListener('load-chat', handleLoadChat);
    
    return () => {
      window.removeEventListener('load-chat', handleLoadChat);
    };
  }, [
    setChatId, 
    setMessages, 
    setLoading, 
    setIsStreaming, 
    setIsThinking, 
    setShouldAutoScroll
  ]);

  // Add handler for active chat deletion
  useEffect(() => {
    const handleDeleteActiveChat = () => {
      console.log('Active chat has been deleted, clearing chat view');
      
      // If there's an active request, cancel it
      if (abortControllerRef.current) {
        abortControllerRef.current.abort();
        abortControllerRef.current = null;
      }
      
      // Reset all states
      setMessages([]);
      setLoading(false);
      setIsStreaming(false);
      setIsThinking(false);
      setShouldAutoScroll(true);
      accumulatedContentRef.current = '';
      setChatId(null);
      
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
  }, [setMessages, setLoading, setIsStreaming, setIsThinking, setShouldAutoScroll, setChatId]);

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
            />
          );
        })}
        
        <div ref={messagesEndRef} />
      </div>

      <div className="input-container">
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
    </div>
  );
};

export default Chat; 