import { FC, useState, useRef, useEffect, useMemo, useCallback } from 'react';
import ReactMarkdown from 'react-markdown';
import { Prism as SyntaxHighlighter } from 'react-syntax-highlighter';
import { vscDarkPlus } from 'react-syntax-highlighter/dist/esm/styles/prism';
import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';
import rehypeKatex from 'rehype-katex';
import { showHtmlPreview } from '../utils/htmlPreview';
import { detectCreations, showCreation, removeCreationDirectives, CreationType, switchCreation } from '../utils/creationsHelper';
import creationManager from '../utils/creationManager';
import CreationIndicators from './CreationIndicators';
import { getCreationIcon } from '../utils/creationIcons';

// Add new imports for streaming creation detection
import { Creation } from '../utils/creationsHelper';

// Regex patterns to clean up triple backticks around creation blocks during streaming
const backticksBeforeCreationPattern = /```(\w*)\s*\n?\$\$creation:(\w+)(?:\s+([^\n]+))?\$\$/;
const backticksAfterEndPattern = /\$\$end\$\$\s*\n?```/;
const jsxBackticksPattern = /```jsx\s*\n?\$\$creation:react\s+([^:\n]+)\$\$/;
const pythonBackticksPattern = /```python\s*\n?\$\$creation:code\s+([^:\n]+)\$\$/;

// Helper function to clean backticks during streaming (simplified version of the utility function)
const cleanBackticksForStreaming = (content: string): string => {
  // Clean backticks before creation directive
  let cleaned = content.replace(backticksBeforeCreationPattern, (_match, language, type, title) => {
    // If there's a language specified in the backticks and not in the title, add it to the title
    if (language && title && !title.includes(':')) {
      return `$$creation:${type} ${language}:${title}$$`;
    }
    // Otherwise just keep the title as is
    return `$$creation:${type} ${title || ''}$$`;
  });
  
  // Clean backticks after end directive
  cleaned = cleaned.replace(backticksAfterEndPattern, '$$end$$');
  
  // Special case for React components
  cleaned = cleaned.replace(jsxBackticksPattern, '$$creation:react jsx:$1$$');
  
  // Special case for Python code blocks
  cleaned = cleaned.replace(pythonBackticksPattern, '$$creation:code python:$1$$');
  
  return cleaned;
};

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
}

interface MessageProps {
  content: string;
  isUser: boolean;
  isStreaming?: boolean;
  isThinking?: boolean;
  attachments?: FileAttachment[];
  isHistoryMessage?: boolean;
  reasoning?: string;
}

// New interface for tracking streamed creation state
interface StreamedCreation {
  type: string;
  title?: string;
  language?: string;
  content: string;
  isComplete: boolean;
  id: string;
}

const Message: FC<MessageProps> = ({ content, isUser, isStreaming = false, isThinking = false, attachments = [], isHistoryMessage = false, reasoning }) => {
  const [copied, setCopied] = useState(false);
  const [codeBlockCopied, setCodeBlockCopied] = useState<{[key: string]: boolean}>({});
  const contentRef = useRef<HTMLDivElement>(null);
  const [reasoningExpanded, setReasoningExpanded] = useState(false);
  
  // Debug logging for reasoning prop
  console.log('🎯 Message component rendered with reasoning:', reasoning ? 'YES' : 'NO', 'Length:', reasoning ? reasoning.length : 0);
  
  // Keep track of the current content for streaming
  const [displayedContent, setDisplayedContent] = useState(content);
  
  // Track if this component is mounted to avoid memory leaks
  const isMountedRef = useRef(true);
  
  // Track if we've processed creations for this message already
  const creationsProcessedRef = useRef(false);

  // New state variables for streaming creation detection
  const [isCollectingCreation, setIsCollectingCreation] = useState(false);
  const [streamedCreation, setStreamedCreation] = useState<StreamedCreation | null>(null);
  const [streamBuffer, setStreamBuffer] = useState('');
  
  // Add state variables to track content before and after creation
  const [preCreationContent, setPreCreationContent] = useState('');
  const [postCreationContent, setPostCreationContent] = useState('');
  const [creationComplete, setCreationComplete] = useState(false);
  
  // Memoize the regex patterns to prevent re-creating them on each render
  const creationStartPattern = useMemo(() => /\$\$creation:(\w+)(?:\s+([^\n]+))?\$\$/, []);
  const creationEndPattern = useMemo(() => /\$\$end\$\$/, []);
  
  const [creationSwitchTimeout, setCreationSwitchTimeout] = useState<ReturnType<typeof setTimeout> | null>(null);
  
  // Process any creations when content changes and streaming ends
  useEffect(() => {
    if (!isUser && !isStreaming && !isThinking && content) {
      // Detect creations in the content
      const creations = detectCreations(content);
      
      // Always clean the content for display, regardless of whether we add to gallery
        const cleanedContent = removeCreationDirectives(content);
      setDisplayedContent(cleanedContent);
      
      // Only add to gallery if this is NOT a history message and we haven't processed it yet
      if (creations.length > 0 && !isHistoryMessage && !creationsProcessedRef.current) {
        console.log('Detected creations in new message:', creations);
        
        // Add each creation to our CreationManager
        creations.forEach(creation => {
          // Check if this creation already exists in the CreationManager
          const existingCreation = creationManager.getCreations().find(
            c => c.content === creation.content && c.type === creation.type
          );
          
          // Only add the creation if it doesn't already exist
          if (!existingCreation) {
            const addedCreation = creationManager.addCreation(creation);
            
            // Track in view history
            if (addedCreation.id) {
              creationManager.viewCreation(addedCreation.id);
            }
          }
        });
        
        // Automatically show the first creation in the right window
        // Use a small timeout to ensure the creation is fully processed
        setTimeout(() => {
          if (creations.length > 0) {
          showCreation(creations[0]);
            
            // After showing the creation, set a timer to auto-switch to preview mode after 1 second
            const firstCreationId = creations[0].id;
            if (firstCreationId) {
              const previewTimeout = setTimeout(() => {
                // Dispatch event to switch to preview mode
                window.dispatchEvent(new CustomEvent('switch-creation-preview', {
                  detail: { creationId: firstCreationId }
                }));
              }, 1000);
              
              setCreationSwitchTimeout(previewTimeout);
            }
          }
        }, 100);
        
        // Mark that we've processed creations for this message
        creationsProcessedRef.current = true;
      } else if (creations.length > 0 && isHistoryMessage) {
        // For history messages, display the creations without adding to gallery
        console.log('Displaying creations from history message without adding to gallery');
        
        // If there are creations, we still want to show them, just not add them to gallery
        if (!creationsProcessedRef.current) {
          // Find these creations in the gallery if they exist
          const existingCreation = creationManager.getCreations().find(
            c => creations.some(creation => 
              c.content === creation.content && c.type === creation.type
            )
          );
          
          // If found, show it in the viewer
          if (existingCreation) {
            setTimeout(() => {
              showCreation(existingCreation);
              
              // Also auto-switch to preview for history creations after 1 second
              if (existingCreation.id) {
                const previewTimeout = setTimeout(() => {
                  window.dispatchEvent(new CustomEvent('switch-creation-preview', {
                    detail: { creationId: existingCreation.id }
                  }));
                }, 1000);
                
                setCreationSwitchTimeout(previewTimeout);
              }
            }, 100);
          }
          
          creationsProcessedRef.current = true;
        }
      }
    }
  }, [isUser, isStreaming, isThinking, content, isHistoryMessage]);
  
  // New useEffect for detecting creations during streaming
  useEffect(() => {
    if (isUser || isThinking || !isStreaming || isHistoryMessage) {
      // Skip streaming detection for history messages
      // Reset creation collection state when not streaming
      if (isCollectingCreation) {
        setIsCollectingCreation(false);
        setStreamedCreation(null);
        setStreamBuffer('');
        setCreationComplete(false);
      }
      return;
    }

    // Only process for assistant messages that are streaming and not from history
    if (isStreaming) {
      // Clean any backticks around creation blocks in the current content
      const cleanedContent = cleanBackticksForStreaming(content);
      
      // Check if we're already collecting a creation
      if (isCollectingCreation && streamedCreation) {
        // Look for the end pattern
        if (creationEndPattern.test(cleanedContent) && !creationComplete) {
          // Creation has ended, mark it complete to avoid reprocessing
          setCreationComplete(true);
          
          // Create a full creation from our streamed content
          const finalContent = cleanedContent.substring(0, cleanedContent.indexOf('$$end$$'));
          const creationContent = streamedCreation.content + 
            finalContent.substring(streamBuffer.length);

          // Create the final creation object
          const completeCreation: Creation = {
            type: streamedCreation.type as CreationType,
            content: creationContent.trim(),
            title: streamedCreation.title,
            language: streamedCreation.language,
            id: streamedCreation.id,
            // Add metadata to mark this as temporary - will be replaced by the final detection
            metadata: { isTemporary: true } 
          };

          // Set timeout to switch to preview after a delay
          const timeout = setTimeout(() => {
            // Dispatch event to switch to preview mode
            window.dispatchEvent(new CustomEvent('switch-creation-preview', {
              detail: { creationId: completeCreation.id }
            }));
          }, 1000);
          
          setCreationSwitchTimeout(timeout);
          
          // Extract initial text after the creation
          if (cleanedContent.indexOf('$$end$$') > -1) {
            const afterCreation = cleanedContent.substring(cleanedContent.indexOf('$$end$$') + 7);
            setPostCreationContent(afterCreation);
            
            // Update displayed content with both before and after parts
            setDisplayedContent(preCreationContent + afterCreation);
          }
        } else if (creationComplete) {
          // Creation is already complete, so we're now just receiving text after the creation
          // Check if there's new content beyond what we've already processed
          if (cleanedContent.length > streamBuffer.length) {
            // Extract only the new content that was added since last update
            const newContent = cleanedContent.substring(streamBuffer.length);
            
            // Append new content to post-creation content
            const updatedPostContent = postCreationContent + newContent;
            setPostCreationContent(updatedPostContent);
            
            // Update displayed content, preserving the structure
            setDisplayedContent(preCreationContent + updatedPostContent);
            
            // Update stream buffer to include this new content
            setStreamBuffer(cleanedContent);
          }
      } else {
          // Still collecting the creation
          // Extract the new content since the last update
          const newContent = cleanedContent.substring(streamBuffer.length);
          
          // Update our creation content
          setStreamedCreation(prev => {
            if (prev) {
              return {
                ...prev,
                content: prev.content + newContent,
              };
            }
            return prev;
          });

          // Send the new content to the creation window
          window.dispatchEvent(new CustomEvent('stream-to-creation', {
            detail: {
              content: newContent,
              creationId: streamedCreation.id
            }
          }));

          // Update our buffer
          setStreamBuffer(cleanedContent);
          
          // Keep the displayed content stable - only showing text before the creation
          // This prevents flickering as the creation content changes
          if (preCreationContent) {
            setDisplayedContent(preCreationContent);
          } else if (cleanedContent.indexOf('$$creation:') > -1) {
            const beforeCreation = cleanedContent.substring(0, cleanedContent.indexOf('$$creation:'));
            setPreCreationContent(beforeCreation);
            setDisplayedContent(beforeCreation);
          }
        }
      } else {
        // Not currently collecting a creation, check if we should start
        const match = creationStartPattern.exec(cleanedContent);
        if (match) {
          // We found a creation start marker!
          const [, type, titlePart] = match;
          
          // Extract language if present
          let language = undefined;
          let title = titlePart?.trim();
          
          if (title && title.includes(':')) {
            const parts = title.split(':');
            language = parts[0].trim();
            title = parts.slice(1).join(':').trim();
          }
          
          // Create a unique ID for this creation
          const creationId = `creation-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
          
          // Set up the creation object
          const newCreation: StreamedCreation = {
            type,
            title,
            language,
            content: '',
            isComplete: false,
            id: creationId
          };
          
          // Start collecting the creation
          setIsCollectingCreation(true);
          setStreamedCreation(newCreation);
          setStreamBuffer(cleanedContent);
          setCreationComplete(false);
          
          // Open the creation window and switch to code view
          showCreation({
            type: type as CreationType,
            content: '',
            title,
            language,
            id: creationId,
            // Mark as temporary until fully detected
            metadata: { isTemporary: true }
          });
          
          // Dispatch event to switch to code editing mode
          window.dispatchEvent(new CustomEvent('switch-creation-code', {
            detail: { creationId }
          }));
          
          // Store and display the content before the creation marker
          if (cleanedContent.indexOf('$$creation:') > -1) {
            const beforeCreation = cleanedContent.substring(0, cleanedContent.indexOf('$$creation:'));
            setPreCreationContent(beforeCreation);
            setDisplayedContent(beforeCreation);
          } else {
            // Fallback to removing creation directives if we can't find the marker
            const displayContent = removeCreationDirectives(cleanedContent);
            setDisplayedContent(displayContent);
          }
        } else {
          // No creation patterns detected, show the raw content
          // Only update if content actually changed to avoid unnecessary rerenders
          if (displayedContent !== cleanedContent) {
            setDisplayedContent(cleanedContent);
          }
        }
      }
    } else if (!isStreaming) {
      // When streaming ends, reset our streaming state
      setPreCreationContent('');
      setPostCreationContent('');
      setCreationComplete(false);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [content, isStreaming, isUser, isThinking, isHistoryMessage, creationEndPattern, creationStartPattern]);
  
  // Function to handle creation clicks - simplified since we use new components
  const toggleCreationWindow = useCallback((creation: Creation) => {
    // If we're currently streaming a creation, don't allow interaction
    if (isCollectingCreation && streamedCreation) {
      return;
    }
    
    // The creation is completed, allow toggling visibility
    const isVisible = document.querySelector('.creation-window.visible');
    
    if (isVisible) {
      // Check if we have a way to identify the current creation being displayed
      const currentCreationId = isVisible.getAttribute('data-creation-id');
      
      // If we're clicking the same creation that's already open, just close it
      // Or if either ID is missing, just close the current one
      if (!currentCreationId || !creation.id || currentCreationId === creation.id) {
        window.dispatchEvent(new CustomEvent('close-creation-window', {}));
      } else {
        // We're clicking a different creation, use the switch function for smooth transition
        switchCreation(creation);
      }
    } else {
      // If window is not visible, show this creation
      showCreation(creation);
    }
  }, [isCollectingCreation, streamedCreation]);
  
  // Cleanup creation switch timeout
  useEffect(() => {
    return () => {
      if (creationSwitchTimeout) {
        clearTimeout(creationSwitchTimeout);
      }
    };
  }, [creationSwitchTimeout]);
  
  // Force update when content changes during streaming
  useEffect(() => {
    if (isMountedRef.current) {
      if ((isUser || isThinking) && isStreaming) {
        // During streaming for user messages or thinking, just show the raw content
        setDisplayedContent(content);
      }
      
      // Force browser to paint the update
      if ((isStreaming || isThinking) && contentRef.current) {
        // The act of accessing these properties forces a layout calculation
        // which helps ensure the browser paints the update
        void contentRef.current.offsetHeight; // Using void to indicate deliberate non-use
      }
    }
  }, [content, isStreaming, isThinking, isUser]);
  
  // This effect runs on component mount/unmount only
  useEffect(() => {
    isMountedRef.current = true;
    return () => {
      isMountedRef.current = false;
    };
  }, []);
  
  // Add a class transition effect when a message stops streaming
  useEffect(() => {
    if (!isStreaming && !isThinking && contentRef.current) {
      // Add a transition class
      contentRef.current.classList.add('message-transition');
      // Remove it after animation completes
      setTimeout(() => {
        if (contentRef.current && isMountedRef.current) {
          contentRef.current.classList.remove('message-transition');
        }
      }, 500);
    }
  }, [isStreaming, isThinking]);

  const copyToClipboard = () => {
    navigator.clipboard.writeText(content);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const copyCodeBlock = (code: string, id: string) => {
    navigator.clipboard.writeText(code);
    setCodeBlockCopied(prev => ({ ...prev, [id]: true }));
    setTimeout(() => {
      setCodeBlockCopied(prev => ({ ...prev, [id]: false }));
    }, 2000);
  };

  const downloadCodeBlock = (code: string, language: string) => {
    const blob = new Blob([code], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `code-snippet.${language || 'txt'}`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

  const runHtml = (html: string) => {
    showHtmlPreview(html);
  };
  
  // Get appropriate className based on message type
  const getMessageClass = () => {
    if (isUser) return 'user-message';
    if (isThinking) return 'thinking-message assistant-message';
    return 'assistant-message';
  };
  
  // Memoize the thinking animation to prevent it from being recreated on every render
  const thinkingAnimation = useMemo(() => (
    <div className="thinking-animation">
      <div className="thinking-dots">
        <span></span>
        <span></span>
        <span></span>
      </div>
      <div className="thinking-text">Thinking...</div>
    </div>
  ), []);
  
  // Memoize the markdown content to optimize rendering performance
  const markdownContent = useMemo(() => {
    // Track detected creations in the message for displaying icons
    const detectedCreations = !isUser && !isCollectingCreation ? detectCreations(content) : [];
    
    // If we're not displaying any creations, just render the content normally
    if (detectedCreations.length === 0 && !isCollectingCreation) {
    return (
      <ReactMarkdown
          key={isStreaming ? 'streaming' : 'static'}
        remarkPlugins={[remarkGfm, remarkMath]}
        rehypePlugins={[rehypeKatex]}
        components={{
          code({ className, children, ...props }) {
              const match = /language-(\w+)/.exec(className || '');
              const language = match ? match[1] : '';
              const codeContent = String(children).replace(/\n$/, '');
              const blockId = `code-${Math.random().toString(36).substring(2, 9)}`;
              const isHtml = language === 'html';
              
              // Check if this is a creation directive
              const isCreation = codeContent.startsWith('creation:');
              
              if (isCreation) {
                // For any remaining creation blocks that weren't cleaned,
                // display a simple notification instead of the full creation
                
                // Parse the creation type from first line
                const firstLine = codeContent.split('\n')[0];
                const creationMatch = /creation:(\w+)(?:\s+(.+))?/.exec(firstLine);
                let creationType = '';
                let creationTitle = '';
                
                if (creationMatch) {
                  creationType = creationMatch[1];
                  creationTitle = creationMatch[2] || '';
                }
                
                // Show a simple notification that directs to the sidebar
                return (
                  <div className="creation-notification">
                    <span className="creation-notification-icon">
                      {getCreationIcon(creationType)}
                    </span>
                    <span className="creation-notification-text">
                      <strong>{creationTitle || `${creationType.charAt(0).toUpperCase() + creationType.slice(1)} Creation`}</strong> is open in the sidebar
                    </span>
                  </div>
                );
              }
              
              return match ? (
                <div className="code-block-container">
                  <div className="code-block-actions">
                    <button
                      className="code-action-button"
                      onClick={() => copyCodeBlock(codeContent, blockId)}
                      aria-label="Copy code"
                    >
                      {codeBlockCopied[blockId] ? 'Copied!' : 'Copy'}
                    </button>
                    <button
                      className="code-action-button"
                      onClick={() => downloadCodeBlock(codeContent, language)}
                      aria-label="Download code"
                    >
                      Download
                    </button>
                    {isHtml && (
                      <button
                        className="code-action-button run-button"
                        onClick={() => runHtml(codeContent)}
                        aria-label="Run HTML"
                      >
                        <svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                          <polygon points="5 3 19 12 5 21 5 3"></polygon>
                        </svg>
                        View
                      </button>
                    )}
                  </div>
                  <SyntaxHighlighter
                    // @ts-expect-error - Style type mismatch in library
                    style={vscDarkPlus}
                    language={language}
                    PreTag="div"
                    {...props}
                  >
                    {codeContent}
                  </SyntaxHighlighter>
                </div>
              ) : (
                <code className={className} {...props}>
                  {children}
                </code>
              );
            },
            p: ({ children }) => {
              return <p className={isStreaming ? 'streaming-paragraph' : ''}>{children}</p>;
            }
          }}
        >
          {displayedContent}
        </ReactMarkdown>
      );
    }
    
    // Handle the case where we need to position creation indicators inline
    if (!isStreaming && !isCollectingCreation && detectedCreations.length > 0) {
      // Extract creation positions from original content
      const creationPositions: {start: number; end: number; creation: Creation}[] = [];
      const creationPattern = /\$\$creation:(\w+)(?:\s+([^\n]+))?\$\$([\s\S]*?)\$\$end\$\$/g;
      
      let match;
      while ((match = creationPattern.exec(content)) !== null) {
        const startPos = match.index;
        const endPos = match.index + match[0].length;
        const creation = detectedCreations.find(c => 
          content.substr(startPos, endPos - startPos).includes(c.content)
        );
        
        if (creation) {
          creationPositions.push({
            start: startPos,
            end: endPos,
            creation
          });
        }
      }

      // If we didn't find any positions, fall back to displaying them at the end
      if (creationPositions.length === 0) {
        return (
          <>
            <ReactMarkdown
              key={isStreaming ? 'streaming' : 'static'}
              remarkPlugins={[remarkGfm, remarkMath]}
              rehypePlugins={[rehypeKatex]}
              components={{
                // Same components as above
                code({ className, children, ...props }) {
                  // ... same code rendering logic
            const match = /language-(\w+)/.exec(className || '');
            const language = match ? match[1] : '';
            const codeContent = String(children).replace(/\n$/, '');
            const blockId = `code-${Math.random().toString(36).substring(2, 9)}`;
            const isHtml = language === 'html';
            
            // Check if this is a creation directive - this should rarely happen now
            // since we're cleaning the content, but handle it just in case
            const isCreation = codeContent.startsWith('creation:');
            
            if (isCreation) {
              // For any remaining creation blocks that weren't cleaned,
              // display a simple notification instead of the full creation
              
              // Parse the creation type from first line
              const firstLine = codeContent.split('\n')[0];
              const creationMatch = /creation:(\w+)(?:\s+(.+))?/.exec(firstLine);
              let creationType = '';
              let creationTitle = '';
              
              if (creationMatch) {
                creationType = creationMatch[1];
                creationTitle = creationMatch[2] || '';
              }
              
              // Show a simple notification that directs to the sidebar
              return (
                <div className="creation-notification">
                  <span className="creation-notification-icon">
                    {getCreationIcon(creationType)}
                  </span>
                  <span className="creation-notification-text">
                    <strong>{creationTitle || `${creationType.charAt(0).toUpperCase() + creationType.slice(1)} Creation`}</strong> is open in the sidebar
                  </span>
                </div>
              );
            }
            
            return match ? (
              <div className="code-block-container">
                <div className="code-block-actions">
                  <button
                    className="code-action-button"
                    onClick={() => copyCodeBlock(codeContent, blockId)}
                    aria-label="Copy code"
                  >
                    {codeBlockCopied[blockId] ? 'Copied!' : 'Copy'}
                  </button>
                  <button
                    className="code-action-button"
                    onClick={() => downloadCodeBlock(codeContent, language)}
                    aria-label="Download code"
                  >
                    Download
                  </button>
                  {isHtml && (
                    <button
                      className="code-action-button run-button"
                      onClick={() => runHtml(codeContent)}
                      aria-label="Run HTML"
                    >
                      <svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                        <polygon points="5 3 19 12 5 21 5 3"></polygon>
                      </svg>
                      View
                    </button>
                  )}
                </div>
                <SyntaxHighlighter
                  // @ts-expect-error - Style type mismatch in library
                  style={vscDarkPlus}
                  language={language}
                  PreTag="div"
                  {...props}
                >
                  {codeContent}
                </SyntaxHighlighter>
              </div>
            ) : (
              <code className={className} {...props}>
                {children}
              </code>
            );
          },
          p: ({ children }) => {
            return <p className={isStreaming ? 'streaming-paragraph' : ''}>{children}</p>;
          }
        }}
      >
        {displayedContent}
      </ReactMarkdown>
            <CreationIndicators
              creations={detectedCreations}
              onCreationClick={toggleCreationWindow}
            />
          </>
        );
      }

      // Sort positions to ensure correct order
      creationPositions.sort((a, b) => a.start - b.start);

      // Now we need to split the displayedContent at those positions
      const contentParts: {isCreation: boolean; content: string; creation?: Creation}[] = [];
      
      let lastPos = 0;
      
      // For each creation position in the original content, find where it would be in the cleaned content
      for (const pos of creationPositions) {
        // Add the text before this creation
        const textBefore = content.substring(lastPos, pos.start);
        const cleanedTextBefore = removeCreationDirectives(textBefore);
        
        if (cleanedTextBefore) {
          contentParts.push({
            isCreation: false,
            content: cleanedTextBefore
          });
        }
        
        // Add the creation
        contentParts.push({
          isCreation: true,
          content: '',
          creation: pos.creation
        });
        
        lastPos = pos.end;
      }
      
      // Add any remaining text after the last creation
      const textAfter = content.substring(lastPos);
      const cleanedTextAfter = removeCreationDirectives(textAfter);
      
      if (cleanedTextAfter) {
        contentParts.push({
          isCreation: false,
          content: cleanedTextAfter
        });
      }
      
      // Now render each part
      return (
        <>
          {contentParts.map((part, index) => 
            part.isCreation ? (
              <CreationIndicators
                key={`creation-part-${index}`}
                creations={part.creation ? [part.creation] : []}
                onCreationClick={toggleCreationWindow}
              />
            ) : (
              <ReactMarkdown
                key={`text-part-${index}`}
                remarkPlugins={[remarkGfm, remarkMath]}
                rehypePlugins={[rehypeKatex]}
                components={{
                  // Same components as above
                  code({ className, children, ...props }) {
                    // ... same code rendering logic
                    const match = /language-(\w+)/.exec(className || '');
                    const language = match ? match[1] : '';
                    const codeContent = String(children).replace(/\n$/, '');
                    const blockId = `code-${Math.random().toString(36).substring(2, 9)}`;
                    const isHtml = language === 'html';
                    
                    // Check if this is a creation directive - this should rarely happen now
                    // since we're cleaning the content, but handle it just in case
                    const isCreation = codeContent.startsWith('creation:');
                    
                    if (isCreation) {
                      // For any remaining creation blocks that weren't cleaned,
                      // display a simple notification instead of the full creation
                      
                      // Parse the creation type from first line
                      const firstLine = codeContent.split('\n')[0];
                      const creationMatch = /creation:(\w+)(?:\s+(.+))?/.exec(firstLine);
                      let creationType = '';
                      let creationTitle = '';
                      
                      if (creationMatch) {
                        creationType = creationMatch[1];
                        creationTitle = creationMatch[2] || '';
                      }
                      
                      // Show a simple notification that directs to the sidebar
                      return (
                        <div className="creation-notification">
                          <span className="creation-notification-icon">
                            {getCreationIcon(creationType)}
                          </span>
                          <span className="creation-notification-text">
                            <strong>{creationTitle || `${creationType.charAt(0).toUpperCase() + creationType.slice(1)} Creation`}</strong> is open in the sidebar
                          </span>
                        </div>
                      );
                    }
                    
                    return match ? (
                      <div className="code-block-container">
                        <div className="code-block-actions">
                          <button
                            className="code-action-button"
                            onClick={() => copyCodeBlock(codeContent, blockId)}
                            aria-label="Copy code"
                          >
                            {codeBlockCopied[blockId] ? 'Copied!' : 'Copy'}
                          </button>
                          <button
                            className="code-action-button"
                            onClick={() => downloadCodeBlock(codeContent, language)}
                            aria-label="Download code"
                          >
                            Download
                          </button>
                          {isHtml && (
                            <button
                              className="code-action-button run-button"
                              onClick={() => runHtml(codeContent)}
                              aria-label="Run HTML"
                            >
                              <svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                                <polygon points="5 3 19 12 5 21 5 3"></polygon>
                              </svg>
                              View
                            </button>
                          )}
                        </div>
                        <SyntaxHighlighter
                          // @ts-expect-error - Style type mismatch in library
                          style={vscDarkPlus}
                          language={language}
                          PreTag="div"
                          {...props}
                        >
                          {codeContent}
                        </SyntaxHighlighter>
                      </div>
                    ) : (
                      <code className={className} {...props}>
                        {children}
                      </code>
                    );
                  },
                  p: ({ children }) => {
                    return <p className={isStreaming ? 'streaming-paragraph' : ''}>{children}</p>;
                  }
                }}
              >
                {part.content}
              </ReactMarkdown>
            )
          )}
        </>
      );
    }
    
    // For streaming content with a creation currently being collected
    if (isCollectingCreation && streamedCreation) {
      return (
        <>
          <ReactMarkdown
            key="streaming-with-creation"
            remarkPlugins={[remarkGfm, remarkMath]}
            rehypePlugins={[rehypeKatex]}
            components={{
              // Same components as above for code rendering
              code({ className, children, ...props }) {
                // ... same code rendering logic
                const match = /language-(\w+)/.exec(className || '');
                const language = match ? match[1] : '';
                const codeContent = String(children).replace(/\n$/, '');
                const blockId = `code-${Math.random().toString(36).substring(2, 9)}`;
                const isHtml = language === 'html';
                
                // Check if this is a creation directive
                const isCreation = codeContent.startsWith('creation:');
                
                if (isCreation) {
                  // Same handling as above
                  const firstLine = codeContent.split('\n')[0];
                  const creationMatch = /creation:(\w+)(?:\s+(.+))?/.exec(firstLine);
                  let creationType = '';
                  let creationTitle = '';
                  
                  if (creationMatch) {
                    creationType = creationMatch[1];
                    creationTitle = creationMatch[2] || '';
                  }
                  
                  return (
                    <div className="creation-notification">
                      <span className="creation-notification-icon">
                        {getCreationIcon(creationType)}
                      </span>
                      <span className="creation-notification-text">
                        <strong>{creationTitle || `${creationType.charAt(0).toUpperCase() + creationType.slice(1)} Creation`}</strong> is open in the sidebar
                      </span>
                    </div>
                  );
                }
                
                return match ? (
                  <div className="code-block-container">
                    <div className="code-block-actions">
                      <button
                        className="code-action-button"
                        onClick={() => copyCodeBlock(codeContent, blockId)}
                        aria-label="Copy code"
                      >
                        {codeBlockCopied[blockId] ? 'Copied!' : 'Copy'}
                      </button>
                      <button
                        className="code-action-button"
                        onClick={() => downloadCodeBlock(codeContent, language)}
                        aria-label="Download code"
                      >
                        Download
                      </button>
                      {isHtml && (
                        <button
                          className="code-action-button run-button"
                          onClick={() => runHtml(codeContent)}
                          aria-label="Run HTML"
                        >
                          <svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                            <polygon points="5 3 19 12 5 21 5 3"></polygon>
                          </svg>
                          View
                        </button>
                      )}
                    </div>
                    <SyntaxHighlighter
                      // @ts-expect-error - Style type mismatch in library
                      style={vscDarkPlus}
                      language={language}
                      PreTag="div"
                      {...props}
                    >
                      {codeContent}
                    </SyntaxHighlighter>
                  </div>
                ) : (
                  <code className={className} {...props}>
                    {children}
                  </code>
                );
              },
              p: ({ children }) => {
                return <p className={isStreaming ? 'streaming-paragraph' : ''}>{children}</p>;
              }
            }}
          >
            {displayedContent}
          </ReactMarkdown>
          
          <div className="creation-indicators streaming-creation-container">
            <CreationIndicators
              creations={streamedCreation ? [{
                type: streamedCreation.type as CreationType,
                content: streamedCreation.content,
                title: streamedCreation.title,
                language: streamedCreation.language,
                id: streamedCreation.id
              }] : []}
              onCreationClick={toggleCreationWindow}
              isStreaming={true}
            />
          </div>
        </>
      );
    }
    
    // Default case - render content normally
    return (
      <ReactMarkdown
        key={isStreaming ? 'streaming' : 'static'}
        remarkPlugins={[remarkGfm, remarkMath]}
        rehypePlugins={[rehypeKatex]}
        components={{
          // All the same components as above
          code({ className, children, ...props }) {
            // ... same code rendering logic
            const match = /language-(\w+)/.exec(className || '');
            const language = match ? match[1] : '';
            const codeContent = String(children).replace(/\n$/, '');
            const blockId = `code-${Math.random().toString(36).substring(2, 9)}`;
            const isHtml = language === 'html';
            
            // Check if this is a creation directive
            const isCreation = codeContent.startsWith('creation:');
            
            if (isCreation) {
              // Same handling as above
              const firstLine = codeContent.split('\n')[0];
              const creationMatch = /creation:(\w+)(?:\s+(.+))?/.exec(firstLine);
              let creationType = '';
              let creationTitle = '';
              
              if (creationMatch) {
                creationType = creationMatch[1];
                creationTitle = creationMatch[2] || '';
              }
              
              return (
                <div className="creation-notification">
                  <span className="creation-notification-icon">
                    {getCreationIcon(creationType)}
                  </span>
                  <span className="creation-notification-text">
                    <strong>{creationTitle || `${creationType.charAt(0).toUpperCase() + creationType.slice(1)} Creation`}</strong> is open in the sidebar
                  </span>
                </div>
              );
            }
            
            return match ? (
              <div className="code-block-container">
                <div className="code-block-actions">
                  <button
                    className="code-action-button"
                    onClick={() => copyCodeBlock(codeContent, blockId)}
                    aria-label="Copy code"
                  >
                    {codeBlockCopied[blockId] ? 'Copied!' : 'Copy'}
                  </button>
                  <button
                    className="code-action-button"
                    onClick={() => downloadCodeBlock(codeContent, language)}
                    aria-label="Download code"
                  >
                    Download
                  </button>
                  {isHtml && (
                    <button
                      className="code-action-button run-button"
                      onClick={() => runHtml(codeContent)}
                      aria-label="Run HTML"
                    >
                      <svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                        <polygon points="5 3 19 12 5 21 5 3"></polygon>
                      </svg>
                      View
                    </button>
                  )}
                </div>
                <SyntaxHighlighter
                  // @ts-expect-error - Style type mismatch in library
                  style={vscDarkPlus}
                  language={language}
                  PreTag="div"
                  {...props}
                >
                  {codeContent}
                </SyntaxHighlighter>
              </div>
            ) : (
              <code className={className} {...props}>
                {children}
              </code>
            );
          },
          p: ({ children }) => {
            return <p className={isStreaming ? 'streaming-paragraph' : ''}>{children}</p>;
          }
        }}
      >
        {displayedContent}
      </ReactMarkdown>
    );
  }, [displayedContent, isStreaming, codeBlockCopied, isCollectingCreation, streamedCreation, content, isUser, toggleCreationWindow]);

  // Render thinking animation directly for thinking state
  if (!isUser && isThinking) {
    return (
      <div className="message-wrapper">
        <div className={getMessageClass()}>
          <div ref={contentRef} className="message-content">
            {thinkingAnimation}
          </div>
        </div>
      </div>
    );
  }

  // Render file attachments based on their type
  const renderAttachment = (attachment: FileAttachment) => {
    // Determine document type properties outside switch cases
    const fileExtension = attachment.original_name.split('.').pop()?.toLowerCase() || '';
    const isPdf = attachment.mime_type === 'application/pdf';
    const isWordDoc = attachment.mime_type.includes('word') || ['doc', 'docx'].includes(fileExtension);
    const isSpreadsheet = attachment.mime_type.includes('excel') || attachment.mime_type.includes('spreadsheet') || ['xls', 'xlsx', 'csv'].includes(fileExtension);
    const isCodeFile = ['js', 'ts', 'py', 'java', 'c', 'cpp', 'cs', 'html', 'css'].includes(fileExtension);
    
    // Default document icon
    let docIcon = (
      <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor">
        <path fillRule="evenodd" d="M4 4a2 2 0 012-2h4.586A2 2 0 0112 2.586L15.414 6A2 2 0 0116 7.414V16a2 2 0 01-2 2H6a2 2 0 01-2-2V4zm2 6a1 1 0 011-1h6a1 1 0 110 2H7a1 1 0 01-1-1zm1 3a1 1 0 100 2h6a1 1 0 100-2H7z" clipRule="evenodd" />
      </svg>
    );
    
    // Use specific icons for common document types
    if (isPdf) {
      docIcon = (
        <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor">
          <path fillRule="evenodd" d="M4 4a2 2 0 012-2h8a2 2 0 012 2v12a2 2 0 01-2 2H6a2 2 0 01-2-2V4zm2 3a1 1 0 011-1h6a1 1 0 110 2H7a1 1 0 01-1-1zm1 3a1 1 0 100 2h6a1 1 0 100-2H7z" clipRule="evenodd" />
        </svg>
      );
    } else if (isWordDoc) {
      docIcon = (
        <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor">
          <path fillRule="evenodd" d="M4 4a2 2 0 012-2h4.586A2 2 0 0112 2.586L15.414 6A2 2 0 0116 7.414V16a2 2 0 01-2 2H6a2 2 0 01-2-2V4z" clipRule="evenodd" />
          <path fillRule="evenodd" d="M8 10a1 1 0 00-1 1v1a1 1 0 102 0v-1a1 1 0 00-1-1zm2-6a1 1 0 00-1 1v1a1 1 0 102 0V5a1 1 0 00-1-1z" clipRule="evenodd" />
        </svg>
      );
    } else if (isSpreadsheet) {
      docIcon = (
        <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor">
          <path fillRule="evenodd" d="M5 4a3 3 0 00-3 3v6a3 3 0 003 3h10a3 3 0 003-3V7a3 3 0 00-3-3H5zm-1 9v-1h5v2H5a1 1 0 01-1-1zm7 1h4a1 1 0 001-1v-1h-5v2zm0-4h5V8h-5v2zM9 8H4v2h5V8z" clipRule="evenodd" />
        </svg>
      );
    } else if (isCodeFile) {
      docIcon = (
        <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor">
          <path fillRule="evenodd" d="M12.316 3.051a1 1 0 01.633 1.265l-4 12a1 1 0 11-1.898-.632l4-12a1 1 0 011.265-.633zM5.707 6.293a1 1 0 010 1.414L3.414 10l2.293 2.293a1 1 0 11-1.414 1.414l-3-3a1 1 0 010-1.414l3-3a1 1 0 011.414 0zm8.586 0a1 1 0 011.414 0l3 3a1 1 0 010 1.414l-3 3a1 1 0 11-1.414-1.414L16.586 10l-2.293-2.293a1 1 0 010-1.414z" clipRule="evenodd" />
        </svg>
      );
    }

    switch (attachment.file_type) {
      case 'image':
        return (
          <div key={attachment.file_id} className="message-attachment message-document">
            <div className="attachment-icon">
              <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor">
                <path fillRule="evenodd" d="M4 3a2 2 0 00-2 2v10a2 2 0 002 2h12a2 2 0 002-2V5a2 2 0 00-2-2H4zm12 12H4l4-8 3 6 2-4 3 6z" clipRule="evenodd" />
              </svg>
            </div>
            <div className="attachment-label">{attachment.original_name}</div>
            {attachment.local_url && (
              <div className="attachment-thumbnail">
                <img 
                  src={attachment.local_url} 
                  alt={attachment.original_name} 
                  className="attachment-preview-image"
                />
              </div>
            )}
          </div>
        );
        
      case 'video':
        // Display video as a compact item with icon
        return (
          <div key={attachment.file_id} className="message-attachment message-document message-video-compact">
            <div className="attachment-icon">
              <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor">
                <path d="M2 6a2 2 0 012-2h6a2 2 0 012 2v8a2 2 0 01-2 2H4a2 2 0 01-2-2V6z" />
                <path fillRule="evenodd" d="M10.96 2a2 2 0 012 2v8a2 2 0 01-2 2h-6a2 2 0 01-2-2V4a2 2 0 012-2h6zm3.34 7.5a.75.75 0 01.75.75v2a.75.75 0 01-.75.75h-2.5a.75.75 0 01-.75-.75v-2a.75.75 0 01.75-.75h2.5zm3.44-2.4a.75.75 0 01.75.75v6a.75.75 0 01-.75.75h-2.5a.75.75 0 01-.75-.75v-6a.75.75 0 01.75-.75h2.5z" clipRule="evenodd" />
              </svg>
            </div>
            <div className="attachment-label">{attachment.original_name}</div>
          </div>
        );
        
      case 'audio':
        return (
          <div key={attachment.file_id} className="message-attachment message-document message-audio-compact">
            <div className="attachment-icon">
              <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor">
                <path fillRule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zM9.555 7.168A1 1 0 008 8v4a1 1 0 001.555.832l3-2a1 1 0 000-1.664l-3-2z" clipRule="evenodd" />
              </svg>
            </div>
            <div className="attachment-label">{attachment.original_name}</div>
          </div>
        );
        
      case 'document':
        return (
          <div key={attachment.file_id} className="message-attachment message-document">
            <div className="attachment-icon">
              {docIcon}
            </div>
            <div className="attachment-label">{attachment.original_name}</div>
          </div>
        );
        
      default:
        // Generic file type
        return (
          <div key={attachment.file_id} className="message-attachment message-document">
            <div className="attachment-icon">
              <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor">
                <path fillRule="evenodd" d="M4 4a2 2 0 012-2h4.586A2 2 0 0112 2.586L15.414 6A2 2 0 0116 7.414V16a2 2 0 01-2 2H6a2 2 0 01-2-2V4zm2 6a1 1 0 011-1h6a1 1 0 110 2H7a1 1 0 01-1-1zm1 3a1 1 0 100 2h6a1 1 0 100-2H7z" clipRule="evenodd" />
              </svg>
            </div>
            <div className="attachment-label">{attachment.original_name}</div>
          </div>
        );
    }
  };

  return (
    <div className="message-wrapper">
      <div className={getMessageClass()}>
        {!isUser && !isThinking && (
          <button 
            className="copy-button" 
            onClick={copyToClipboard}
            aria-label="Copy to clipboard"
          >
            {copied ? 'Copied!' : 'Copy'}
          </button>
        )}
        <div ref={contentRef} className="message-content">
          {reasoning && !isUser && (
            <div className="reasoning-section">
              <div 
                className="reasoning-header"
                onClick={() => setReasoningExpanded(!reasoningExpanded)}
              >
                <div className="reasoning-icon">
                  <svg 
                    xmlns="http://www.w3.org/2000/svg" 
                    viewBox="0 0 24 24" 
                    fill="none" 
                    stroke="currentColor" 
                    strokeWidth="2" 
                    strokeLinecap="round" 
                    strokeLinejoin="round"
                  >
                    <path d="M9 12l2 2 4-4"/>
                    <path d="M21 12c.552 0 1-.448 1-1s-.448-1-1-1-1 .448-1 1 .448 1 1 1"/>
                    <path d="M3 12c.552 0 1-.448 1-1s-.448-1-1-1-1 .448-1 1 .448 1 1 1"/>
                    <path d="M12 21c.552 0 1-.448 1-1s-.448-1-1-1-1 .448-1 1 .448 1 1 1"/>
                    <path d="M12 3c.552 0 1-.448 1-1s-.448-1-1-1-1 .448-1 1 .448 1 1 1"/>
                    <path d="M18.364 18.364c.39.39 1.024.39 1.414 0s.39-1.024 0-1.414-.024-.39-1.414 0-.39 1.024 0 1.414"/>
                    <path d="M4.222 4.222c.39.39 1.024.39 1.414 0s.39-1.024 0-1.414-1.024-.39-1.414 0-.39 1.024 0 1.414"/>
                    <path d="M19.778 4.222c.39.39.39 1.024 0 1.414s-1.024.39-1.414 0-.39-1.024 0-1.414 1.024-.39 1.414 0"/>
                    <path d="M5.636 18.364c.39.39.39 1.024 0 1.414s-1.024.39-1.414 0-.39-1.024 0-1.414 1.024-.39 1.414 0"/>
                  </svg>
                </div>
                <span className="reasoning-title">AI Thought Process</span>
                <div className="reasoning-badge">
                  <span className="reasoning-badge-text">{isStreaming ? 'Thinking...' : 'Reasoning'}</span>
                </div>
                {!reasoningExpanded && (
                  <span className="reasoning-preview">
                    {reasoning.length > 60 ? reasoning.substring(0, 60) + '...' : reasoning}
                  </span>
                )}
                <svg 
                  className={`reasoning-chevron ${reasoningExpanded ? 'expanded' : ''}`}
                  xmlns="http://www.w3.org/2000/svg" 
                  viewBox="0 0 24 24" 
                  fill="none" 
                  stroke="currentColor" 
                  strokeWidth="2" 
                  strokeLinecap="round" 
                  strokeLinejoin="round"
                >
                  <polyline points="6 9 12 15 18 9"></polyline>
                </svg>
              </div>
              <div className={`reasoning-content ${reasoningExpanded ? 'expanded' : ''}`}>
                <div className="reasoning-text">
                  <ReactMarkdown 
                    remarkPlugins={[remarkGfm]}
                    components={{
                      pre: ({ children }) => <pre className="reasoning-pre">{children}</pre>,
                      code: ({ children, className }) => {
                        const isInline = !className;
                        return isInline ? (
                          <code className="reasoning-inline-code">{children}</code>
                        ) : (
                          <code className="reasoning-code-block">{children}</code>
                        );
                      }
                    }}
                  >
                    {reasoning}
                  </ReactMarkdown>
                </div>
              </div>
            </div>
          )}
          {attachments.length > 0 && (
            <div className="message-attachments">
              {attachments.map((attachment) => renderAttachment(attachment))}
            </div>
          )}
          {markdownContent}
        </div>
      </div>
    </div>
  );
};

export default Message;