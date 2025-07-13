import { FC, useState, useRef, useEffect, useMemo, useCallback } from 'react';
import ReactMarkdown from 'react-markdown';
import { Prism as SyntaxHighlighter } from 'react-syntax-highlighter';
import { vscDarkPlus } from 'react-syntax-highlighter/dist/esm/styles/prism';
import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';
import rehypeKatex from 'rehype-katex';
import { showHtmlPreview } from '../utils/htmlPreview';
import { detectCreations, detectCreationEdits, showCreation, removeCreationDirectives, CreationType, switchCreation, parseExternalDependencies } from '../utils/creationsHelper';
import creationManager from '../utils/creationManager';
import CreationIndicators from './CreationIndicators';
import { getCreationIcon } from '../utils/creationIcons';
import UrlPreviewCard from './UrlPreviewCard';
import PDFViewer from './PDFViewer';

// Add new imports for streaming creation detection
import { Creation } from '../utils/creationsHelper';

// Regex patterns to clean up triple backticks around creation and edit blocks during streaming
const backticksBeforeCreationPattern = /```(\w*)\s*\n?\$\$creation:(\w+)(?:\s+([^\n]+))?\$\$/;
const backticksBeforeEditPattern = /```(\w*)\s*\n?\$\$(editcreation|appendcreation|replacecreation):([^$]+?)\$\$/;
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
  
  // Clean backticks before edit directives
  cleaned = cleaned.replace(backticksBeforeEditPattern, (_match, _language, editType, title) => {
    return `$$${editType}:${title}$$`;
  });
  
  // Clean backticks after end directive
  cleaned = cleaned.replace(backticksAfterEndPattern, '$$end$$');
  
  // Special case for React components
  cleaned = cleaned.replace(jsxBackticksPattern, '$$creation:react jsx:$1$$');
  
  // Special case for Python code blocks
  cleaned = cleaned.replace(pythonBackticksPattern, '$$creation:code python:$1$$');
  
  return cleaned;
};

// Helper function to check for partial end tags and exclude them from content being sent to creation window
// This prevents partial $$end$$ tags from being streamed to the creation window
const excludePartialEndTag = (content: string): { cleanContent: string; hasPartialEnd: boolean } => {
  // Check for complete end tag first
  const completeEndIndex = content.indexOf('$$end$$');
  if (completeEndIndex !== -1) {
    // Complete end tag found - return content up to (not including) the end tag
    return {
      cleanContent: content.substring(0, completeEndIndex),
      hasPartialEnd: false
    };
  }
  
  // Check for partial end tags at the end of content
  // Look for patterns like: $$, $$e, $$en, $$end, $$end$
  const partialEndPatterns = ['$$end$', '$$end', '$$en', '$$e', '$$'];
  
  for (const pattern of partialEndPatterns) {
    if (content.endsWith(pattern)) {
      // Found partial end tag - exclude it
      const cleanContent = content.substring(0, content.length - pattern.length);
      console.log('🛡️ EXCLUDING PARTIAL END TAG:', {
        pattern,
        originalLength: content.length,
        cleanLength: cleanContent.length,
        excluded: pattern
      });
      return {
        cleanContent,
        hasPartialEnd: true
      };
    }
  }
  
  // No partial end tag detected
  return {
    cleanContent: content,
    hasPartialEnd: false
  };
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
  onEdit?: () => void;
  onDelete?: () => void;
  onRefresh?: () => void;
}

// New interface for tracking streamed creation state
interface StreamedCreation {
  type: string;
  title?: string;
  language?: string;
  content: string;
  isComplete: boolean;
  id: string;
  forwarded: number;   // NEW – bytes already sent to the creation window
  externalDependencies?: Record<string, string>; // External dependencies for React components
  metadata?: {
    isTemporary?: boolean;
    isEdit?: boolean;
    originalId?: string;
  };
}

const Message: FC<MessageProps> = ({ content, isUser, isStreaming = false, isThinking = false, attachments = [], isHistoryMessage = false, reasoning, onEdit, onDelete, onRefresh }) => {
  const isMountedRef = useRef(true);
  const contentRef = useRef<HTMLDivElement>(null);
  const [isHovered, setIsHovered] = useState(false);
  const [copied, setCopied] = useState(false);
  const [codeBlockCopied, setCodeBlockCopied] = useState<{[key: string]: boolean}>({});
  const [reasoningExpanded, setReasoningExpanded] = useState(false);
  
  // Get copy button visibility setting from localStorage with live updates
  const [showCopyButton, setShowCopyButton] = useState(() => {
    const saved = localStorage.getItem('copyButtonEnabled');
    return saved ? JSON.parse(saved) : true;
  });
  
  // Listen for settings changes to update immediately
  useEffect(() => {
    const handleSettingsChange = (event: Event) => {
      const customEvent = event as CustomEvent<{ key: string; value: boolean }>;
      if (customEvent.detail.key === 'copyButtonEnabled') {
        setShowCopyButton(customEvent.detail.value);
      }
    };
    
    // Also listen for storage changes from other tabs/windows
    const handleStorageChange = (event: StorageEvent) => {
      if (event.key === 'copyButtonEnabled' && event.newValue !== null) {
        setShowCopyButton(JSON.parse(event.newValue));
      }
    };
    
    window.addEventListener('settingsChanged', handleSettingsChange);
    window.addEventListener('storage', handleStorageChange);
    
    return () => {
      window.removeEventListener('settingsChanged', handleSettingsChange);
      window.removeEventListener('storage', handleStorageChange);
    };
  }, []);
  
  // Refs to track completed creations during streaming
  const completedStreamCreationsRef = useRef<Creation[]>([]);
  
  // Track if we've processed creations for this message already
  const creationsProcessedRef = useRef(false);
  
  
  // State for managing creation streaming
  const [isCollectingCreation, setIsCollectingCreation] = useState(false);
  const [streamedCreation, setStreamedCreation] = useState<StreamedCreation | null>(null);
  const [creationComplete, setCreationComplete] = useState(false);
  const [displayedContent, setDisplayedContent] = useState(() => {
    // Initialize with cleaned content to prevent emergency cleanup from interfering
    return isUser ? content : removeCreationDirectives(content);
  });
  const [streamBuffer, setStreamBuffer] = useState('');
  const [preCreationContent, setPreCreationContent] = useState('');
  
  // CRITICAL: Store the raw content for position extraction in refresh render
  const rawContentRef = useRef(content);
  const [postCreationContent, setPostCreationContent] = useState('');
  const [currentCreationStartPos, setCurrentCreationStartPos] = useState(-1);
  
  // State for finalized creations (fallback for reliable rendering)
  const [finalizedCreations, setFinalizedCreations] = useState<Creation[]>([]);
  
  // New state for tracking content parts during streaming
  const [streamingContentParts, setStreamingContentParts] = useState<{isCreation: boolean; content: string; creation?: Creation}[]>([]);

  const [pdfUrl, setPdfUrl] = useState<string | null>(null);
  
  const [creationSwitchTimeout, setCreationSwitchTimeout] = useState<number | null>(null);

  
  // Memoize the regex patterns to prevent re-creating them on each render
  const creationStartPattern = useMemo(() => /\$\$creation:(\w+)(?:\s+([^\n]+))?\$\$/, []);
  const creationEndPattern = useMemo(() => /\$\$end\$\$/, []);
  
  // Function to split content into parts for proper streaming layout
  const splitContentIntoParts = useCallback((rawContent: string): {isCreation: boolean; content: string; creation?: Creation}[] => {
    const parts: {isCreation: boolean; content: string; creation?: Creation}[] = [];
    
    // Combined pattern for both creation and edit operations
    const creationPattern = /\$\$creation:(\w+)(?:\s+([^\n]+))?\$\$([\s\S]*?)(\$\$end\$\$|$)/g;
    const editPattern = /\$\$(editcreation|appendcreation):([^$]+?)\$\$([\s\S]*?)(\$\$end\$\$|$)/g;
    const replacePattern = /\$\$replacecreation:([^$]+?)\$\$([\s\S]*?)(\$\$with\$\$([\s\S]*?))?(\$\$end\$\$|$)/g;
    
    // Collect all matches with their positions
    const allMatches: Array<{
      match: RegExpMatchArray;
      isEdit: boolean;
      isReplace: boolean;
    }> = [];
    
    let match;
    
    // Find all creation matches
    while ((match = creationPattern.exec(rawContent)) !== null) {
      allMatches.push({ match, isEdit: false, isReplace: false });
    }
    
    // Find all edit matches
    while ((match = editPattern.exec(rawContent)) !== null) {
      allMatches.push({ match, isEdit: true, isReplace: false });
    }
    
    // Find all replace matches
    while ((match = replacePattern.exec(rawContent)) !== null) {
      allMatches.push({ match, isEdit: true, isReplace: true });
    }
    
    // Sort matches by position
    allMatches.sort((a, b) => (a.match.index || 0) - (b.match.index || 0));
    
    let lastIndex = 0;
    
    for (const { match, isEdit, isReplace } of allMatches) {
      const startPos = match.index || 0;
      const endPos = startPos + match[0].length;
      
      // Add text before this creation/edit
      if (startPos > lastIndex) {
        const textBefore = rawContent.substring(lastIndex, startPos);
        if (textBefore.trim()) {
          parts.push({
            isCreation: false,
            content: textBefore
          });
        }
      }
      
      let creation: Creation;
      
      if (isEdit) {
        // Handle edit operations
                 if (isReplace) {
           // $$replacecreation:title$$target$$with$$replacement$$end$$
           const [, title, target, , replacement, endTag] = match;
           const originalCreation = creationManager.getCreationByTitle(title?.trim() || '');
           
           creation = {
             type: originalCreation?.type as CreationType || 'code',
             content: replacement?.trim() || target?.trim() || '',
             title: title?.trim(),
             language: originalCreation?.language,
             id: streamedCreation?.id || `creation-${Date.now()}-${Math.random().toString(36).substring(2, 9)}`,
             metadata: { 
               isTemporary: true, 
               isStreaming: !endTag?.includes('$$end$$'),
               isEdit: true,
               originalId: originalCreation?.id
             }
           };
         } else {
           // $$editcreation:title$$ or $$appendcreation:title$$
           const [, , title, editContent, endTag] = match;
           const originalCreation = creationManager.getCreationByTitle(title?.trim() || '');
           
           creation = {
             type: originalCreation?.type as CreationType || 'code',
             content: editContent?.trim() || '',
             title: title?.trim(),
             language: originalCreation?.language,
             id: streamedCreation?.id || `creation-${Date.now()}-${Math.random().toString(36).substring(2, 9)}`,
             metadata: { 
               isTemporary: true, 
               isStreaming: !endTag?.includes('$$end$$'),
               isEdit: true,
               originalId: originalCreation?.id
             }
           };
         }
       } else {
         // Handle regular creation operations
         const [, type, titlePart, creationContent, endTag] = match;
        
        // Parse creation details
        let language = undefined;
        let title = titlePart?.trim();
        
        if (title && title.includes(':')) {
          const titleParts = title.split(':');
          language = titleParts[0].trim();
          title = titleParts.slice(1).join(':').trim();
        }
        
        creation = {
          type: type as CreationType,
          content: creationContent?.trim() || '',
          title,
          language,
          id: streamedCreation?.id || `creation-${Date.now()}-${Math.random().toString(36).substring(2, 9)}`,
          metadata: { isTemporary: true, isStreaming: !endTag?.includes('$$end$$') }
        };
      }
      
      // Add the creation/edit part
      parts.push({
        isCreation: true,
        content: '',
        creation
      });
      
      lastIndex = endPos;
    }
    
    // Add any remaining text after the last creation
    if (lastIndex < rawContent.length) {
      const textAfter = rawContent.substring(lastIndex);
      if (textAfter.trim()) {
        parts.push({
          isCreation: false,
          content: textAfter
        });
      }
    }
    
    // If no creations found, return the entire content as one part
    if (parts.length === 0 && rawContent.trim()) {
      parts.push({
        isCreation: false,
        content: rawContent
      });
    }
    
    return parts;
  }, [streamedCreation]);
  
  
  // Function to check if a creation header is complete
  const isCreationHeaderComplete = useCallback((content: string, startPos: number = 0): { isComplete: boolean; match?: RegExpMatchArray; isEdit?: boolean } => {
    // Only check content from the specified starting position
    const contentToCheck = content.substring(startPos);
    
    // Check if there's a complete creation pattern in the content after startPos
    const completeMatch = creationStartPattern.exec(contentToCheck);
    if (completeMatch) {
      // Adjust the match index to be relative to the original content
      const adjustedMatch = [...completeMatch] as RegExpMatchArray;
      adjustedMatch.index = (completeMatch.index || 0) + startPos;
      return { isComplete: true, match: adjustedMatch, isEdit: false };
    }
    
    // Check for complete edit patterns
    const editPatterns = [
      /\$\$(editcreation|appendcreation):([^$]+?)\$\$/,
      /\$\$replacecreation:([^$]+?)\$\$/
    ];
    
    for (const pattern of editPatterns) {
      const editMatch = pattern.exec(contentToCheck);
      if (editMatch) {
        const adjustedMatch = [...editMatch] as RegExpMatchArray;
        adjustedMatch.index = (editMatch.index || 0) + startPos;
        return { isComplete: true, match: adjustedMatch, isEdit: true };
      }
    }
    
    // Check if there's an incomplete pattern at the very end of the content after startPos
    // This regex looks for $$creation:, $$editcreation:, $$appendcreation:, or $$replacecreation: followed by any incomplete text at the end
    const incompleteAtEnd = /\$\$(creation|editcreation|appendcreation|replacecreation):[^$]*$/.exec(contentToCheck);
    if (incompleteAtEnd) {
      return { isComplete: false };
    }
    
    return { isComplete: false };
  }, [creationStartPattern]);
  
  // Safe wrapper for setDisplayedContent that prevents creation tags
  const safeSetDisplayedContent = useCallback((content: string) => {
    if (content.includes('$$creation:') || content.includes('$$end$$') || 
        content.includes('$$editcreation:') || content.includes('$$appendcreation:') || 
        content.includes('$$replacecreation:')) {
      // console.log('🔍 [SAFE-SET] Cleaning content with creation tags:', {
      //   contentLength: content.length,
      //   hasCreationTags: content.includes('$$creation:'),
      //   hasEndTags: content.includes('$$end$$')
      // });
      const cleanedContent = removeCreationDirectives(content);
      setDisplayedContent(cleanedContent);
    } else {
      setDisplayedContent(content);
    }
  }, []);
  
  // Track displayed content changes to identify when content appears in main chat
  useEffect(() => {
    const containsCreationTags = displayedContent.includes('$$creation:') || displayedContent.includes('$$end$$') ||
                                displayedContent.includes('$$editcreation:') || displayedContent.includes('$$appendcreation:') || 
                                displayedContent.includes('$$replacecreation:');
    
    // CRITICAL: If content contains creation tags, this should NEVER happen
    if (containsCreationTags) {
      // console.error('🚨 CREATION TAGS IN DISPLAYED CONTENT - This should never happen!', {
      //   length: displayedContent.length,
      //   isStreaming,
      //   hasActiveCreation: !!streamedCreation,
      //   creationComplete,
      //   stackTrace: new Error().stack?.split('\n').slice(1, 4)
      // });
      
      // EMERGENCY FIX: Immediately clean the content if it contains creation tags
      const cleanedContent = removeCreationDirectives(displayedContent);
      if (cleanedContent !== displayedContent) {
        // console.log('🧹 EMERGENCY CLEANUP - Removing creation tags from displayed content');
        safeSetDisplayedContent(cleanedContent);
        return; // Exit early to prevent logging the problematic content
      }
    }
    

  }, [displayedContent, isStreaming, streamedCreation, creationComplete, safeSetDisplayedContent]);

  const contentToProcess = content || rawContentRef.current || '';

  
  // Process any creations when content changes and streaming ends
  useEffect(() => {
    console.log('🔍 [MAIN-USEEFFECT] Running with:', {
      contentLength: content?.length || 0,
      isStreaming,
      hasContent: !!content,
      contentPreview: content?.substring(0, 100) + (content && content.length > 100 ? '...' : '')
    });
    
    // Update raw content ref when content actually has creation tags or is larger than before
    // This prevents clearing the ref when content temporarily becomes empty
    if (content !== rawContentRef.current && 
        (content.includes('$$creation:') || content.length > (rawContentRef.current?.length || 0))) {
      rawContentRef.current = content;
    }
    
    if (!isUser && !isThinking && (content || rawContentRef.current)) {
      // CRITICAL: Reset processed flag only once when streaming just stopped
      // This prevents the infinite loop issue where useEffect runs twice
      if (!isStreaming && (content || rawContentRef.current)) {
        const contentToCheck = content || rawContentRef.current || '';
        if (contentToCheck.includes('$$creation:') && creationsProcessedRef.current) {
          // Only reset if we haven't actually added ALL the creations to the gallery yet
          // Check if the CreationManager has ALL of these creations
          const detectedCreationsPreview = detectCreations(contentToCheck);
          const creationsInGallery = detectedCreationsPreview.filter(creation => 
            creationManager.getCreations().find(
              c => c.content === creation.content && c.type === creation.type
            )
          );
          const allCreationsInGallery = creationsInGallery.length === detectedCreationsPreview.length;
          
          if (!allCreationsInGallery && detectedCreationsPreview.length > 0) {
            creationsProcessedRef.current = false;
          }
        }
      }
      

      
      // CRITICAL: Detect creations from raw content (same as refresh render)
      // Use rawContentRef when content is empty (similar to render logic)
      const creations = detectCreations(contentToProcess);
      const edits = detectCreationEdits(contentToProcess);

      // Apply edits to existing creations - now creates new versions
      const editedCreations: Creation[] = [];
      console.log('🎯 [MAIN-USEEFFECT] Processing edits:', {
        editsCount: edits.length,
        editTitles: edits.map(e => e.title),
        isStreaming,
        currentFinalizedCount: finalizedCreations.length
      });
      
      edits.forEach(edit => {
        let newCreation: Creation | null = null;
        if (edit.mode === 'append' && edit.content) {
          newCreation = creationManager.editCreationByTitle(edit.title, edit.content, 'append');
        } else if (edit.mode === 'replace' && edit.content) {
          newCreation = creationManager.editCreationByTitle(edit.title, edit.content, 'replace');
        } else if (edit.mode === 'patch' && edit.target && edit.replacement) {
          newCreation = creationManager.patchCreationByTitle(edit.title, edit.target, edit.replacement);
        }
        
        // If a new creation version was created, add it to our list for display
        if (newCreation) {
          editedCreations.push(newCreation);
          console.log('✅ [MAIN-USEEFFECT] Added edited creation to finalizedCreations:', {
            title: newCreation.title,
            id: newCreation.id,
            mode: edit.mode
          });
        }
      });

      // Update finalized creations to include both new creations and edited versions
      // CRITICAL: During streaming, preserve any instant edit indicators that were already created
      const allCreations = [...creations, ...editedCreations];
      console.log('📋 [MAIN-USEEFFECT] Setting finalizedCreations:', {
        regularCreations: creations.length,
        editedCreations: editedCreations.length,
        totalCreations: allCreations.length,
        currentFinalizedCount: finalizedCreations.length,
        isStreaming,
        willPreserveExisting: isStreaming && finalizedCreations.length > 0
      });
      
      if (isStreaming && finalizedCreations.length > 0 && allCreations.length === 0) {
        // During streaming, if we have existing finalized creations (like instant edit indicators)
        // and no new complete creations, preserve the existing ones
        console.log('🔒 [PRESERVE-INDICATORS] Keeping existing instant indicators during streaming');
        // Don't reset finalizedCreations
      } else {
        // Merge existing instant indicators with new complete creations
        const existingInstantIndicators = isStreaming ? 
          finalizedCreations.filter(c => c.metadata?.isStreaming) : [];
        const mergedCreations = [...existingInstantIndicators, ...allCreations];
        setFinalizedCreations(mergedCreations);
      }
      
      // Clean content for display
      const cleanedContent = removeCreationDirectives(contentToProcess);
      safeSetDisplayedContent(cleanedContent);
      
      // Only add to gallery if this is NOT a history message and we haven't processed it yet
      if (allCreations.length > 0 && !isHistoryMessage && !creationsProcessedRef.current) {
        // Add each NEW creation to our CreationManager (edited creations were already added)
        creations.forEach((creation) => {
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
        
        // Track edited creations in view history (they were already added to gallery)
        editedCreations.forEach((editedCreation) => {
          if (editedCreation.id) {
            creationManager.viewCreation(editedCreation.id);
          }
        });
        
        // Automatically show the first creation in the right window (new or edited)
        // Use a small timeout to ensure the creation is fully processed
        // CRITICAL FIX: Only prevent auto-show during ACTIVE streaming, not after streaming completes
        const shouldAutoShow = !isStreaming && !isCollectingCreation;
        
        if (shouldAutoShow) {
          setTimeout(() => {
            if (allCreations.length > 0) {
              // Prioritize edited creations over new ones, as they represent active edits
              const creationToShow = editedCreations.length > 0 ? editedCreations[0] : allCreations[0];
            
            // For edited creations, we want to show the original content first, then stream the changes
            if (editedCreations.length > 0) {
              const originalCreation = creationManager.getCreationById(editedCreations[0].metadata?.originalId as string);
              if (originalCreation) {
                // First show the original creation content in the window
                showCreation(originalCreation);
                
                // Then immediately switch to the new edited version to show the changes
                setTimeout(() => {
                  switchCreation(editedCreations[0]);
                }, 100);
                
                // Set timer to auto-switch to preview mode after showing changes
                const editedCreationId = editedCreations[0].id;
                if (editedCreationId) {
                  const previewTimeout = setTimeout(() => {
                    window.dispatchEvent(new CustomEvent('switch-creation-preview', {
                      detail: { creationId: editedCreationId }
                    }));
                  }, 1500); // Longer delay for edits to see the changes
                  
                  setCreationSwitchTimeout(previewTimeout as unknown as number);
                }
              } else {
                // Fallback: just show the edited creation if original not found
                showCreation(editedCreations[0]);
              }
            } else {
              // Show new creation normally
              showCreation(creationToShow);
              
              // After showing the creation, set a timer to auto-switch to preview mode after 1 second
              const firstCreationId = creationToShow.id;
              if (firstCreationId) {
                const previewTimeout = setTimeout(() => {
                  // Dispatch event to switch to preview mode
                  window.dispatchEvent(new CustomEvent('switch-creation-preview', {
                    detail: { creationId: firstCreationId }
                  }));
                }, 1000);
                
                setCreationSwitchTimeout(previewTimeout as unknown as number);
              }
            }
          }
        }, 100);
        }
        
        // Mark that we've processed creations for this message
        creationsProcessedRef.current = true;
      } else if (allCreations.length > 0 && isHistoryMessage) {
        // For history messages, display the creations without adding to gallery
        
        // If there are creations, we still want to show them, just not add them to gallery
        if (!creationsProcessedRef.current) {
          // Find these creations in the gallery if they exist
          const existingCreation = creationManager.getCreations().find(
            c => allCreations.some(creation => 
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
                
                setCreationSwitchTimeout(previewTimeout as unknown as number);
              }
            }, 100);
          }
          
          creationsProcessedRef.current = true;
        }
              }
      }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- isStreaming, isThinking, content, isHistoryMessage, safeSetDisplayedContent are read for logging only and adding them causes infinite loops
  }, [isUser, isStreaming, isThinking, content, isHistoryMessage, safeSetDisplayedContent]);
  
  // New useEffect for detecting creations during streaming
  useEffect(() => {
    if (isUser || isThinking || !isStreaming || isHistoryMessage) {
      // Skip streaming detection for history messages
      // Reset creation collection state when not streaming
      if (isCollectingCreation) {
        // If we have a current creation that's being collected, save it before resetting
        if (streamedCreation && !isStreaming) {
          const finalCreation: Creation = {
            type: streamedCreation.type as CreationType,
            content: streamedCreation.content.trim() || `// ${streamedCreation.type} creation`,
            title: streamedCreation.title,
            language: streamedCreation.language,
            id: streamedCreation.id,
            metadata: { isTemporary: true }
          };
          
          // Check if this creation is already in the completed list
          const isDuplicate = completedStreamCreationsRef.current.some(existing => 
            existing.id === finalCreation.id
          );
          
          if (!isDuplicate) {
            completedStreamCreationsRef.current = [...completedStreamCreationsRef.current, finalCreation];
          }
        }
        
        setIsCollectingCreation(false);
        setStreamedCreation(null);
        setStreamBuffer('');
        setCreationComplete(false);
        
        console.log('🧹 [STREAMING-END-CLEANUP] Streaming ended, keeping existing finalizedCreations:', {
          currentFinalizedCount: finalizedCreations.length,
          skipReason: 'Main useEffect handles creation detection and processing'
        });
        
        completedStreamCreationsRef.current = []; // Reset completed creations when streaming ends
        setCurrentCreationStartPos(-1); // Reset position tracking
      }
      return;
    }

    // Only process for assistant messages that are streaming and not from history
    if (isStreaming) {
      
      console.log('🎬 [STREAMING-DETECTION] Starting streaming detection:', {
        contentLength: content.length,
        isCollectingCreation,
        hasStreamedCreation: !!streamedCreation,
        contentPreview: content.substring(0, 100) + (content.length > 100 ? '...' : '')
      });
      
      // Clean any backticks around creation blocks in the current content
      const cleanedContent = cleanBackticksForStreaming(content);
      
      // Update content parts on every streaming update to ensure text between creations streams properly
      const updatedParts = splitContentIntoParts(cleanedContent);
      setStreamingContentParts(updatedParts);
      

      
      // First, check if there's a new creation or edit starting
      // Find ALL creation and edit matches in the content to get the last/newest one
      const allCreationMatches: RegExpMatchArray[] = [];
      const allEditMatches: RegExpMatchArray[] = [];
      let match;
      const globalCreationPattern = /\$\$creation:(\w+)(?:\s+([^\n]+))?\$\$/g;
      const globalEditPattern = /\$\$(editcreation|appendcreation):([^$]+?)\$\$/g;
      const globalReplacePattern = /\$\$replacecreation:([^$]+?)\$\$/g;
      
      while ((match = globalCreationPattern.exec(cleanedContent)) !== null) {
        allCreationMatches.push(match);
      }
      
      while ((match = globalEditPattern.exec(cleanedContent)) !== null) {
        allEditMatches.push(match);
      }
      
      // Handle replacecreation separately since it has a different structure
      while ((match = globalReplacePattern.exec(cleanedContent)) !== null) {
        // Modify the match to fit the same structure as edit matches
        const modifiedMatch: RegExpMatchArray = [match[0], 'replacecreation', match[1]];
        modifiedMatch.index = match.index;
        allEditMatches.push(modifiedMatch as RegExpMatchArray);
      }
      
      // Get the last (newest) creation or edit match based on position
      const lastCreationMatch = allCreationMatches.length > 0 ? allCreationMatches[allCreationMatches.length - 1] : null;
      const lastEditMatch = allEditMatches.length > 0 ? allEditMatches[allEditMatches.length - 1] : null;
      
      // Determine which one comes last in the content
      let newCreationMatch: RegExpMatchArray | null = null;
      let isEditOperation = false;
      
      if (lastCreationMatch && lastEditMatch) {
        if ((lastEditMatch.index || 0) > (lastCreationMatch.index || 0)) {
          newCreationMatch = lastEditMatch;
          isEditOperation = true;
        } else {
          newCreationMatch = lastCreationMatch;
        }
      } else if (lastEditMatch) {
        newCreationMatch = lastEditMatch;
        isEditOperation = true;
      } else if (lastCreationMatch) {
        newCreationMatch = lastCreationMatch;
      }
      let shouldStartNewCreation = false;
      let newCreationDetails: {type: string; title?: string; language?: string; id?: string} | null = null;
      

      
      if (newCreationMatch) {
        console.log('🔄 [COMPLEX-PATH] Processing creation/edit in complex path:', {
          isEditOperation,
          matchText: newCreationMatch[0],
          matchIndex: newCreationMatch.index,
          currentCreationStartPos,
          hasStreamedCreation: !!streamedCreation
        });
        
        let newType: string;
        let newTitlePart: string | undefined;
        
        if (isEditOperation) {
          // Handle edit operations: $$editcreation:title$$ or $$appendcreation:title$$
          const [, , title] = newCreationMatch;
          newTitlePart = title?.trim();
          
          // For edit operations, we need to find the original creation to get its type
          const originalCreation = creationManager.getCreationByTitle(newTitlePart || '');
          if (originalCreation) {
            newType = originalCreation.type;
          } else {
            // If original creation not found, skip this edit
            return;
          }
        } else {
          // Handle regular creation operations: $$creation:type title$$
          const [, type, title] = newCreationMatch;
          newType = type;
          newTitlePart = title;
        }
        
        // CRITICAL FIX: Check if this creation header is complete before proceeding
        // Only check from the position of this new creation match to avoid false positives from earlier headers
        const headerStartPos = newCreationMatch.index || 0;
        const headerCheck = isCreationHeaderComplete(cleanedContent, headerStartPos);
        
        let shouldProcessCreation = true;
        if (!headerCheck.isComplete) {
          shouldProcessCreation = false;
        }
        
        if (shouldProcessCreation) {
          // Parse the new creation details
          let newLanguage = undefined;
          let newTitle = newTitlePart?.trim();
          
          if (!isEditOperation && newTitle && newTitle.includes(':')) {
            const parts = newTitle.split(':');
            newLanguage = parts[0].trim();
            newTitle = parts.slice(1).join(':').trim();
          } else if (isEditOperation) {
            // For edit operations, get language from original creation
            const originalCreation = creationManager.getCreationByTitle(newTitle || '');
            if (originalCreation) {
              newLanguage = originalCreation.language;
            }
          }
          
          // Check if this is actually a different creation from what we're currently collecting
          // OR if we don't have a current creation, treat it as new
          // CRITICAL: Ignore matches at the same position as our current creation
          const isAtCurrentCreationPosition = currentCreationStartPos >= 0 && 
            newCreationMatch.index === currentCreationStartPos;
          
          const isDifferentCreation = !isAtCurrentCreationPosition && 
            (!streamedCreation ||
            streamedCreation.type !== newType ||
            streamedCreation.title !== newTitle ||
            streamedCreation.language !== newLanguage);
          
                  if (isDifferentCreation) {
            // CRITICAL FIX: Cancel any existing preview timeout immediately
            // This handles the case where a new creation is detected during the preview animation
            if (creationSwitchTimeout) {
              clearTimeout(creationSwitchTimeout);
              setCreationSwitchTimeout(null);
            }
            
            if (streamedCreation) {
              // CRITICAL FIX: Save the current creation to completed list BEFORE resetting
              // Save it regardless of content length - even empty creations should be preserved for UI consistency
              const completedCreation: Creation = {
                type: streamedCreation.type as CreationType,
                content: streamedCreation.content.trim() || `// ${streamedCreation.type} creation started...`,
                title: streamedCreation.title,
                language: streamedCreation.language,
                id: streamedCreation.id,
                metadata: { isTemporary: true, fromTransition: true }
              };
              // Check for duplicates before adding
              const isDuplicate = completedStreamCreationsRef.current.some(existing => 
                existing.type === completedCreation.type && 
                existing.title === completedCreation.title &&
                existing.id === completedCreation.id
              );
              

              
              if (!isDuplicate) {
                completedStreamCreationsRef.current = [...completedStreamCreationsRef.current, completedCreation];

                              }
          }
          
          // CRITICAL FIX: Create new creation object IMMEDIATELY to prevent gaps
          const creationId = `creation-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
          
          // For edit operations, start with the original content
          let initialContent = '';
          if (isEditOperation) {
            const originalCreation = creationManager.getCreationByTitle(newTitle || '');
            if (originalCreation) {
              initialContent = originalCreation.content;
            }
          }
          
          const newCreation: StreamedCreation = {
            type: newType,
            title: newTitle,
            language: newLanguage,
            content: initialContent,
            forwarded: 0,
            isComplete: false,
            id: creationId,
            metadata: { 
              isTemporary: true,
              isEdit: isEditOperation,
              originalId: isEditOperation ? creationManager.getCreationByTitle(newTitle || '')?.id : undefined
            }
          };
          
          // CRITICAL: Set new creation state IMMEDIATELY before any events or resets
          // This prevents the gap where there's no active creation
          setIsCollectingCreation(true);
          setStreamedCreation(newCreation);
          setCreationComplete(false);
          setCurrentCreationStartPos(newCreationMatch?.index ?? -1);
          

          
          // Dispatch event to switch to code editing mode before the update, ensuring the window is open
          window.dispatchEvent(new CustomEvent('switch-creation-code', {
            detail: { creationId }
          }));
          
          // Now dispatch the creation update so the window receives it after mounting
          window.dispatchEvent(new CustomEvent('stream-creation-update', {
            detail: {
              type: newType as CreationType,
              content: initialContent,
              title: newTitle,
              language: newLanguage,
              id: creationId,
              metadata: { 
                isTemporary: true,
                isEdit: isEditOperation,
                originalId: isEditOperation ? creationManager.getCreationByTitle(newTitle || '')?.id : undefined
              }
            }
          }));
          
          // Now safely update displayed content to show only content before the new creation
          if (newCreationMatch && newCreationMatch.index !== undefined) {
            const contentBeforeNewCreation = cleanedContent.substring(0, newCreationMatch.index);
            const cleanedContentBeforeNew = removeCreationDirectives(contentBeforeNewCreation);
            
            console.log('🚨 [CONTENT-BEFORE-CREATION] Setting preCreationContent:', {
              isEditOperation,
              contentBeforeLength: contentBeforeNewCreation.length,
              cleanedContentBeforeLength: cleanedContentBeforeNew.length,
              contentPreview: cleanedContentBeforeNew.substring(0, 200) + (cleanedContentBeforeNew.length > 200 ? '...' : ''),
              newCreationMatchIndex: newCreationMatch.index
            });
            
            // For edit operations, create immediate indicator by adding to finalizedCreations
            if (isEditOperation && newTitle) {
              const originalCreation = creationManager.getCreationByTitle(newTitle);
              if (originalCreation) {
                const tempEditCreation: Creation = {
                  ...originalCreation,
                  id: creationId,
                  metadata: { 
                    isTemporary: true,
                    isEdit: true,
                    isStreaming: true,
                    originalId: originalCreation.id
                  }
                };
                
                console.log('⚡ [INSTANT-EDIT-INDICATOR] Creating immediate edit indicator:', {
                  title: newTitle,
                  id: creationId,
                  originalId: originalCreation.id
                });
                
                setFinalizedCreations(prev => [...prev, tempEditCreation]);
              }
            }
            
            safeSetDisplayedContent(cleanedContentBeforeNew);
            setPreCreationContent(cleanedContentBeforeNew);
          }
          
          // FINAL CLEANUP: Reset remaining state variables
          setPostCreationContent('');
          // buffer only up to the header – nothing inside the creation yet
          setStreamBuffer(cleanedContent.substring(0, (newCreationMatch?.index ?? 0) + (newCreationMatch?.[0]?.length ?? 0)));
          
          // Mark that we should start a new creation (for the content positioning logic)
          shouldStartNewCreation = true;
          newCreationDetails = { type: newType, title: newTitle, language: newLanguage, id: creationId };
        }
          }
      }
      
      // Handle content positioning for new creation (state is already set above)
      if (shouldStartNewCreation && newCreationDetails) {
        // Note: Creation state was already set above to prevent timing gaps
        // Note: Creation window update and code switch were already dispatched above
        

      } else if (isCollectingCreation && streamedCreation) {
        // If creation is already complete, handle post-creation content or new creations
        if (creationComplete) {
          // Creation is already complete, so we're now just receiving text after the creation
          // BUT FIRST: Check if the new content contains a NEW creation pattern
          if (cleanedContent.length > streamBuffer.length) {
            // Extract only the new content that was added since last update
            const newContent = cleanedContent.substring(streamBuffer.length);

            
            // CRITICAL FIX: Check if new content contains a creation start before treating as post-creation
            const newCreationInPostContent = creationStartPattern.exec(newContent);
            
            if (newCreationInPostContent) {
              // There's a new creation in what we thought was post-creation content!
              // This means we need to trigger new creation detection instead

              
              // CRITICAL FIX: Cancel any existing preview timeout immediately
              // This handles rapid-fire creation sequences
              if (creationSwitchTimeout) {

                clearTimeout(creationSwitchTimeout);
                setCreationSwitchTimeout(null);
              }
              
              // Reset the creationComplete flag so the new creation detection logic runs
              setCreationComplete(false);
              
              // Important: Don't process this as post-creation content, let it fall through
              // to the new creation detection logic by returning early
              return;
            }
            
            // No new creation detected, treat as normal post-creation content
            const updatedPostContent = postCreationContent + newContent;
            setPostCreationContent(updatedPostContent);

            
            // Update displayed content, preserving the structure
            const newDisplayedContent = preCreationContent + updatedPostContent;
            safeSetDisplayedContent(newDisplayedContent);
            
            // Update stream buffer to include this new content
            setStreamBuffer(cleanedContent);
          }
              } else {
          // Still collecting the creation
          // Check if the end tag is in the new content AFTER the current creation start
          // Find the start position of the current creation being collected
          // CRITICAL FIX: Use dynamic pattern that matches the actual operation type
          let headerPattern: RegExp;
          if (streamedCreation.metadata?.isEdit) {
            // For edit operations, match the actual edit pattern being used
            headerPattern = /\$\$(editcreation|appendcreation|replacecreation):([^$]+?)\$\$/;
          } else {
            // For regular creation operations
            headerPattern = creationStartPattern;
          }
          
          const currentCreationHeaderMatch = headerPattern.exec(cleanedContent.substring(currentCreationStartPos));
          const headerLength = currentCreationHeaderMatch?.[0]?.length ?? 0;
          
          // Look for end tag only after the current creation start position
          const endTagIndex = currentCreationStartPos >= 0 ? 
            cleanedContent.indexOf('$$end$$', currentCreationStartPos + headerLength) : 
            cleanedContent.indexOf('$$end$$');
          
          // all text that has arrived **inside** the creation so far
          let fullCreationText =
            cleanedContent.slice(currentCreationStartPos + headerLength,
                                 endTagIndex === -1 ? undefined : endTagIndex);
          
          // For edit operations, strip out the edit tags from the content
          if (streamedCreation.metadata?.isEdit) {
            // Remove edit directives from the content before processing
            fullCreationText = fullCreationText.replace(/\$\$(appendcreation|editcreation|replacecreation):([^$]+?)\$\$/g, '');
            fullCreationText = fullCreationText.replace(/\$\$with\$\$/g, '');
          }

          // send only what hasn't been forwarded yet
          if (fullCreationText.length > streamedCreation.forwarded) {
            const newChunk = fullCreationText.slice(streamedCreation.forwarded);
            if (newChunk.length) {
              // CRITICAL FIX: Check for partial end tags and exclude them before sending to creation window
              // This check should ideally be on newChunk, but since fullCreationText already excludes beyond $$end$$,
              // a partial end tag within newChunk itself is unlikely unless $$end$$ is malformed or part of the actual content.
              const { cleanContent: cleanNewChunk } = excludePartialEndTag(newChunk);

              if (cleanNewChunk.length) {
                console.log('🚀 [STREAM-TO-CREATION] Sending content to creation window:', {
                  creationId: streamedCreation.id,
                  chunkLength: cleanNewChunk.length,
                  isEditOperation: streamedCreation.metadata?.isEdit,
                  title: streamedCreation.title,
                  chunkPreview: cleanNewChunk.substring(0, 50) + (cleanNewChunk.length > 50 ? '...' : '')
                });
                
                window.dispatchEvent(new CustomEvent('stream-to-creation', {
                  detail: { content: cleanNewChunk, creationId: streamedCreation.id }
                }));

                setStreamedCreation(prev => {
                  if (!prev) return prev;
                  return {
                    ...prev,
                    content: prev.content + cleanNewChunk, // Append only the clean, new chunk
                    forwarded: prev.forwarded + cleanNewChunk.length // Update forwarded by the length of the chunk sent
                  };
                });
              }
            }
          }
          
          // Update streamBuffer to reflect all processed content so far, up to where fullCreationText ends
          // If endTag is found, buffer includes it. Otherwise, it includes all of fullCreationText.
          const bufferEndPosition = endTagIndex === -1 ? 
                                    currentCreationStartPos + headerLength + fullCreationText.length :
                                    endTagIndex + '$$end$$'.length; // Include the end tag in buffer if found
          setStreamBuffer(cleanedContent.substring(0, bufferEndPosition));

          // If end tag was found and creation is not yet marked complete by this logic path
          if (endTagIndex !== -1 && !creationComplete) {
            // For React creations, check if external dependencies are expected
            let shouldMarkComplete = true;
            
            if (streamedCreation.type === 'react') {
              // Check if there are external dependencies in the content after $$end$$
              const afterEndContent = cleanedContent.substring(endTagIndex + '$$end$$'.length);
              const hasExternalStart = afterEndContent.includes('$$external$$');
              const hasExternalEnd = afterEndContent.includes('$$externalend$$');
              
              console.log('🔍 [REACT-COMPLETION-CHECK] Checking external dependencies for React creation:', {
                creationId: streamedCreation.id,
                title: streamedCreation.title,
                hasExternalStart,
                hasExternalEnd,
                afterEndContentLength: afterEndContent.length,
                afterEndPreview: afterEndContent.substring(0, 100) + (afterEndContent.length > 100 ? '...' : '')
              });
              
              // If external start tag is found but external end tag is not found yet, wait
              if (hasExternalStart && !hasExternalEnd) {
                shouldMarkComplete = false;
                console.log('⏳ [REACT-COMPLETION-DELAYED] React creation waiting for external dependencies to complete');
              }
              
              // If both external start and end are found, parse the external dependencies
              if (hasExternalStart && hasExternalEnd) {
                try {
                  const externalDeps = parseExternalDependencies(afterEndContent);
                  if (externalDeps) {
                    // Update the streamed creation with external dependencies
                    setStreamedCreation(prev => {
                      if (!prev) return prev;
                      return {
                        ...prev,
                        externalDependencies: externalDeps
                      };
                    });
                    console.log('✅ [REACT-EXTERNAL-DEPS] Added external dependencies to React creation:', {
                      creationId: streamedCreation.id,
                      dependencies: Object.keys(externalDeps)
                    });
                  }
                } catch (error) {
                  console.warn('⚠️ [REACT-EXTERNAL-PARSE-ERROR] Failed to parse external dependencies:', error);
                  // Continue with completion even if parsing fails
                }
              }
            }
            
            if (shouldMarkComplete) {
              setCreationComplete(true);

              const completeCreation: Creation = {
                type: streamedCreation.type as CreationType,
                content: streamedCreation.content.trim(), // content is already updated via setStreamedCreation
                title: streamedCreation.title,
                language: streamedCreation.language,
                id: streamedCreation.id,
                externalDependencies: streamedCreation.externalDependencies, // Include external dependencies
                metadata: { isTemporary: true }
              };

              const isDuplicateFinalized = completedStreamCreationsRef.current.some(existing =>
                existing.type === completeCreation.type &&
                existing.title === completeCreation.title &&
                existing.id === completeCreation.id
              );

              if (!isDuplicateFinalized) {
                completedStreamCreationsRef.current = [...completedStreamCreationsRef.current, completeCreation];
              }

              const timeout = setTimeout(() => {
                window.dispatchEvent(new CustomEvent('switch-creation-preview', {
                  detail: { creationId: completeCreation.id }
                }));
              }, 1000);
              setCreationSwitchTimeout(timeout as unknown as number);

              // For React creations with external dependencies, include content up to $$externalend$$
              let contentEndIndex = endTagIndex + '$$end$$'.length;
              if (streamedCreation.type === 'react' && cleanedContent.includes('$$externalend$$')) {
                const externalEndIndex = cleanedContent.indexOf('$$externalend$$', endTagIndex);
                if (externalEndIndex !== -1) {
                  contentEndIndex = externalEndIndex + '$$externalend$$'.length;
                }
              }
              
              const afterCreationContent = cleanedContent.substring(contentEndIndex);
              if (afterCreationContent) {
                setPostCreationContent(afterCreationContent);
                const newDisplayedContent = preCreationContent + afterCreationContent;
                safeSetDisplayedContent(newDisplayedContent);
              }
            }
          } else if (endTagIndex === -1) {
            // No end tag yet, ensure displayed content is only pre-creation content
            console.log('📝 [DISPLAYED-CONTENT] Setting during streaming:', {
              isEditOperation: streamedCreation.metadata?.isEdit,
              preCreationLength: preCreationContent.length,
              currentCreationStartPos,
              preCreationPreview: preCreationContent.substring(0, 100) + (preCreationContent.length > 100 ? '...' : '')
            });
            
            // CRITICAL: For creation/edit operations, ONLY show pre-creation content
            // Never show any content that includes creation/edit tags
            if (preCreationContent) {
              safeSetDisplayedContent(preCreationContent);
            } else {
              // For edit operations starting at position 0, show NOTHING in chat
              // All content should go to creation window only
              console.log('🚫 [BLOCK-CHAT-CONTENT] Blocking all content from chat during creation/edit streaming');
              safeSetDisplayedContent('');
            }
          }
        }
      } else {
        
        console.log('🔍 [FALLBACK-PATH] Entering fallback detection path:', {
          isCollectingCreation,
          hasStreamedCreation: !!streamedCreation,
          contentLength: cleanedContent.length,
          contentPreview: cleanedContent.substring(0, 200) + (cleanedContent.length > 200 ? '...' : ''),
          hasCreationTags: cleanedContent.includes('$$creation:'),
          hasEditTags: cleanedContent.includes('$$editcreation:') || cleanedContent.includes('$$appendcreation:') || cleanedContent.includes('$$replacecreation:')
        });
        
        // CRITICAL FIX: Check if creation header is complete before proceeding
        const headerCheck = isCreationHeaderComplete(cleanedContent, 0);
        
        console.log('🔍 [HEADER-CHECK] Header completeness check result:', {
          isComplete: headerCheck.isComplete,
          isEdit: headerCheck.isEdit,
          matchText: headerCheck.match?.[0],
          matchIndex: headerCheck.match?.index
        });
        
        if (headerCheck.isComplete && headerCheck.match) {
          const match = headerCheck.match;
          const isEditOperation = headerCheck.isEdit || false;

          // CRITICAL FIX: Cancel any existing preview timeout immediately
          // This handles the case where a new creation is detected during any preview animation
          if (creationSwitchTimeout) {
            clearTimeout(creationSwitchTimeout);
            setCreationSwitchTimeout(null);
          }
          
          console.log('🆕 [NEW-CREATION-DETECTION] Found complete header:', {
            isEditOperation,
            matchText: match[0],
            matchIndex: match.index
          });
          
          let type: string;
          let titlePart: string | undefined;
          let language = undefined;
          let title: string | undefined;
          let creationId: string;
          let initialContent = '';
          
          if (isEditOperation) {
            // Handle edit operations: $$editcreation:title$$ or $$appendcreation:title$$
            const [, , editTitle] = match;
            title = editTitle?.trim();
            
            // For edit operations, we need to find the original creation to get its type
            const originalCreation = creationManager.getCreationByTitle(title || '');
            if (originalCreation) {
              type = originalCreation.type;
              language = originalCreation.language;
              initialContent = originalCreation.content;
            } else {
              // If original creation not found, skip this edit
              return;
            }
            
            creationId = `creation-${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;
          } else {
            // Handle regular creation operations: $$creation:type title$$
            const [, creationType, titlePartRaw] = match;
            type = creationType;
            titlePart = titlePartRaw;
            title = titlePart?.trim();
            
            // Extract language if present
            if (title && title.includes(':')) {
              const parts = title.split(':');
              language = parts[0].trim();
              title = parts.slice(1).join(':').trim();
            }
            
            creationId = `creation-${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;
          }
          
          // Set up the creation object
          const newCreation: StreamedCreation = {
            type,
            title,
            language,
            content: initialContent,
            forwarded: 0,
            isComplete: false,
            id: creationId,
            metadata: { 
              isTemporary: true,
              isEdit: isEditOperation,
              originalId: isEditOperation ? creationManager.getCreationByTitle(title || '')?.id : undefined
            }
          };
          
          // Start collecting the creation
          setIsCollectingCreation(true);
          setStreamedCreation(newCreation);
          // buffer only up to the header – nothing inside the creation yet
          setStreamBuffer(cleanedContent.substring(0, (match.index ?? 0) + (match[0]?.length ?? 0)));
          setCreationComplete(false);
          setCurrentCreationStartPos(match.index ?? -1);

          // Dispatch event to switch to code editing mode
          window.dispatchEvent(new CustomEvent('switch-creation-code', {
            detail: { creationId }
          }));

          // For streaming creations, directly update the creation window without closing/reopening
          // This prevents the flash of content in main chat during creation transitions
          window.dispatchEvent(new CustomEvent('stream-creation-update', {
            detail: {
              type: type as CreationType,
              content: initialContent,
              title,
              language,
              id: creationId,
              metadata: { 
                isTemporary: true,
                isEdit: isEditOperation,
                originalId: isEditOperation ? creationManager.getCreationByTitle(title || '')?.id : undefined
              }
            }
          }));
          
          // For edit operations, create immediate indicator by adding to finalizedCreations
          if (isEditOperation && title) {
            const originalCreation = creationManager.getCreationByTitle(title);
            if (originalCreation) {
              const tempEditCreation: Creation = {
                ...originalCreation,
                id: creationId,
                metadata: { 
                  isTemporary: true,
                  isEdit: true,
                  isStreaming: true,
                  originalId: originalCreation.id
                }
              };
              
              console.log('⚡ [INSTANT-EDIT-INDICATOR-FALLBACK] Creating immediate edit indicator via fallback path:', {
                title: title,
                id: creationId,
                originalId: originalCreation.id
              });
              
              setFinalizedCreations(prev => [...prev, tempEditCreation]);
            }
          }
          
          // Store and display the content before the creation/edit marker
          const markerPattern = isEditOperation ? 
            /\$\$(editcreation|appendcreation|replacecreation):/ : 
            /\$\$creation:/;
          const markerMatch = markerPattern.exec(cleanedContent);
          
          if (markerMatch && markerMatch.index !== undefined) {
            const beforeMarker = cleanedContent.substring(0, markerMatch.index);
            setPreCreationContent(beforeMarker);
            safeSetDisplayedContent(beforeMarker);
          } else {
            // Fallback to removing creation directives if we can't find the marker
            const displayContent = removeCreationDirectives(cleanedContent);
            safeSetDisplayedContent(displayContent);
          }
        } else if (cleanedContent.includes('$$creation:') || cleanedContent.includes('$$editcreation:') || cleanedContent.includes('$$appendcreation:') || cleanedContent.includes('$$replacecreation:')) {
          // We detected a creation tag but the header is not complete yet
          // Don't create any indicators or windows yet, just clean the content for display
          const cleanedForDisplay = removeCreationDirectives(cleanedContent);
          safeSetDisplayedContent(cleanedForDisplay);
        } else {
          // Only update if content actually changed to avoid unnecessary rerenders
          if (displayedContent !== cleanedContent) {
            // CRITICAL FIX: Never display content with creation tags in main chat
            // Always clean creation directives, even if no pattern is initially detected
            if (cleanedContent.includes('$$creation:') || cleanedContent.includes('$$end$$')) {
              const cleanedForDisplay = removeCreationDirectives(cleanedContent);
              safeSetDisplayedContent(cleanedForDisplay);
            } else {
              safeSetDisplayedContent(cleanedContent);
            }
          }
        }
      }
    } else if (!isStreaming) {
      // When streaming ends, reset our streaming state
      setPreCreationContent('');
      setPostCreationContent('');
      setCreationComplete(false);
      setStreamingContentParts([]);
      
      console.log('🧹 [STREAMING-END] Cleaned up streaming state, keeping existing finalizedCreations:', {
        currentFinalizedCount: finalizedCreations.length
      });
      
    } else {
      // For non-streaming cases, ensure we still have content parts if needed
      if (isCollectingCreation && streamingContentParts.length === 0) {
        const cleanedContent = cleanBackticksForStreaming(content);
        const initialParts = splitContentIntoParts(cleanedContent);
        setStreamingContentParts(initialParts);
      }
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
      // CRITICAL FIX: Don't override displayedContent for assistant messages during streaming
      // This was causing creation tags to appear in main chat by bypassing creation logic
      if (isUser && isStreaming) {
        // Only set raw content for user messages (user messages don't have creations)

        safeSetDisplayedContent(content);
      }
      // For assistant messages, let the main creation logic handle displayedContent
      
      // Force browser to paint the update
      if ((isStreaming || isThinking) && contentRef.current) {
        // The act of accessing these properties forces a layout calculation
        // which helps ensure the browser paints the update
        void contentRef.current.offsetHeight; // Using void to indicate deliberate non-use
      }
    }
  }, [content, isStreaming, isThinking, isUser, safeSetDisplayedContent]);
  
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
    // CRITICAL: Always detect from content (same as refresh render) with fallback for robustness
    const detectedCreations = !isUser && !isCollectingCreation ? 
      detectCreations(content) : [];
    
    // Use finalized creations as fallback if fresh detection fails (ensures reliability)
    const creations = detectedCreations.length > 0 ? detectedCreations : finalizedCreations;
    
    console.log('🎭 [RENDER-CREATIONS] Creation selection logic:', {
      detectedCreationsCount: detectedCreations.length,
      finalizedCreationsCount: finalizedCreations.length,
      selectedCreationsCount: creations.length,
      isCollectingCreation,
      isStreaming,
      isUser,
      willShowCreations: creations.length > 0,
      finalizedCreationIds: finalizedCreations.map(c => ({ id: c.id, title: c.title, isEdit: c.metadata?.isEdit, isStreaming: c.metadata?.isStreaming })),
      detectedCreationIds: detectedCreations.map(c => ({ id: c.id, title: c.title })),
      selectedCreationIds: creations.map(c => ({ id: c.id, title: c.title, isEdit: c.metadata?.isEdit }))
    });
    
    // If we're not displaying any creations, just render the content normally
    if (creations.length === 0 && !isCollectingCreation) {
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
            },
            a: ({ href, children, ...props }) => {
              const isUrl = href && (href.startsWith('http://') || href.startsWith('https://'));
              
              if (isUrl && !isStreaming && !isThinking) {
                return (
                  <>
                    <a href={href} {...props}>{children}</a>
                    <UrlPreviewCard url={href} />
                  </>
                );
              }
              
              return <a href={href} {...props}>{children}</a>;
            }
          }}
        >
          {displayedContent}
        </ReactMarkdown>
      );
    }
    
    // REFRESH RENDER PATH: Handle the case where we need to position creation indicators inline
    if (!isStreaming && !isCollectingCreation && finalizedCreations.length > 0) {

      // Extract creation positions from original raw content (not cleaned content)
      const creationPositions: {start: number; end: number; creation: Creation}[] = [];
      const creationPattern = /\$\$creation:(\w+)(?:\s+([^\n]+))?\$\$([\s\S]*?)\$\$end\$\$/g;
      const editPattern = /\$\$(editcreation|appendcreation):([^$]+?)\$\$([\s\S]*?)\$\$end\$\$/g;
      
      // CRITICAL: Use rawContentRef which has the original content with creation tags
      const rawContent = rawContentRef.current || content;
      

      
      let match;
      // Handle regular creations
      while ((match = creationPattern.exec(rawContent)) !== null) {
        const startPos = match.index;
        const endPos = match.index + match[0].length;
        const creation = finalizedCreations.find(c => 
          rawContent.substr(startPos, endPos - startPos).includes(c.content)
        );
        
        if (creation) {
          creationPositions.push({
            start: startPos,
            end: endPos,
            creation
          });
        }
      }
      
      // Handle edit operations (simple edits only - replace operations handled separately below)
      while ((match = editPattern.exec(rawContent)) !== null) {
        const startPos = match.index;
        const endPos = match.index + match[0].length;
        const [, editMode, title] = match;
        
        // Find the edited creation that corresponds to this edit directive
        const expectedEditMode = editMode === 'appendcreation' ? 'append' : 'replace';
        const editedCreation = finalizedCreations.find(c => 
          c.title?.toLowerCase() === title.trim().toLowerCase() && 
          c.metadata?.editMode === expectedEditMode
        );
        
        if (editedCreation) {
          creationPositions.push({
            start: startPos,
            end: endPos,
            creation: editedCreation
          });
        }
      }
      
      // Handle replacecreation operations separately (they have $$with$$ structure)
      const replacePattern = /\$\$replacecreation:([^$]+?)\$\$([\s\S]*?)\$\$with\$\$([\s\S]*?)\$\$end\$\$/g;
      while ((match = replacePattern.exec(rawContent)) !== null) {
        const startPos = match.index;
        const endPos = match.index + match[0].length;
        const [, title] = match;
        
        // Find the edited creation that corresponds to this replace directive
        const editedCreation = finalizedCreations.find(c => 
          c.title?.toLowerCase() === title.trim().toLowerCase() && 
          c.metadata?.editMode === 'patch'
        );
        
        if (editedCreation) {
          creationPositions.push({
            start: startPos,
            end: endPos,
            creation: editedCreation
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
              creations={finalizedCreations}
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
        const textBefore = rawContent.substring(lastPos, pos.start);
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
      const textAfter = rawContent.substring(lastPos);
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
      console.log('🎬 [STREAMING-RENDER] Rendering during streaming:', {
        streamingContentPartsLength: streamingContentParts.length,
        finalizedCreationsCount: finalizedCreations.length,
        streamedCreationType: streamedCreation.type,
        streamedCreationTitle: streamedCreation.title,
        streamedCreationIsEdit: streamedCreation.metadata?.isEdit,
        streamingParts: streamingContentParts.map(p => ({ isCreation: p.isCreation, creationId: p.creation?.id, creationTitle: p.creation?.title }))
      });
      
      // Use the parts-based rendering to properly position creation indicators
      return (
        <>
          {streamingContentParts.map((part, index) => 
            part.isCreation ? (
              <CreationIndicators
                key={`streaming-creation-${index}`}
                creations={part.creation ? [part.creation] : []}
                onCreationClick={toggleCreationWindow}
                isStreaming={part.creation?.metadata?.isStreaming !== false}
              />
            ) : (
              (() => {
                const cleanedContent = removeCreationDirectives(part.content);
                console.log('📄 [STREAMING-MARKDOWN-RENDER] About to render streaming text part:', {
                  partIndex: index,
                  originalContentLength: part.content.length,
                  cleanedContentLength: cleanedContent.length,
                  originalContentPreview: part.content.substring(0, 100) + (part.content.length > 100 ? '...' : ''),
                  cleanedContentPreview: cleanedContent.substring(0, 100) + (cleanedContent.length > 100 ? '...' : ''),
                  hasCreationTags: part.content.includes('$$creation:') || part.content.includes('$$editcreation:') || part.content.includes('$$appendcreation:'),
                  willRenderEmptyString: cleanedContent.trim() === ''
                });
                
                // If the cleaned content is empty, render nothing to prevent empty paragraphs
                if (cleanedContent.trim() === '') {
                  console.log('⚪ [EMPTY-CONTENT] Skipping empty content part to prevent unnecessary rendering');
                  return null;
                }
                
                return (
                  <ReactMarkdown
                    key={`streaming-text-${index}`}
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
                    {cleanedContent}
                  </ReactMarkdown>
                );
              })()
            )
          )}
        </>
      );
    }
    
    // DEFAULT CASE (AFTER-STREAM): Apply EXACT SAME LOGIC as refresh render for after-stream cases
    console.log('🔴 [DEFAULT-RENDER] *** ENTERING DEFAULT RENDER PATH (AFTER-STREAM) ***');
    console.log('🔴 [DEFAULT-RENDER] Applying inline positioning logic:', {
      creationCount: creations.length,
      isStreaming,
      isCollectingCreation,
      willApplyPositioning: creations.length > 0,
      conditions: {
        isStreaming,
        isCollecting: isCollectingCreation,
        hasCreations: creations.length > 0
      },
      whyDefaultPath: {
        failedRefreshCondition1: isStreaming, // should be false for refresh
        failedRefreshCondition2: isCollectingCreation, // should be false for refresh
        failedStreamingCondition: !isCollectingCreation || !streamedCreation
      }
    });
    
    // Apply the EXACT SAME positioning logic as the refresh render above
    if (creations.length > 0) {
      // Extract creation positions from original content (SAME AS REFRESH RENDER)
      const creationPositions: {start: number; end: number; creation: Creation}[] = [];
      const creationPattern = /\$\$creation:(\w+)(?:\s+([^\n]+))?\$\$([\s\S]*?)\$\$end\$\$/g;
      
      let match;
      while ((match = creationPattern.exec(content)) !== null) {
        const startPos = match.index;
        const endPos = match.index + match[0].length;
        const creation = creations.find(c => 
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
      
      console.log('🔴 [DEFAULT-RENDER] Creation position extraction (SAME AS REFRESH):', {
        foundPositions: creationPositions.length,
        positions: creationPositions.map(p => ({ start: p.start, end: p.end, type: p.creation.type, title: p.creation.title })),
        contentLength: content.length,
        patternUsed: creationPattern.toString()
      });

      // If we didn't find any positions, fall back to displaying them at the end (SAME AS REFRESH RENDER)
      if (creationPositions.length === 0) {
        console.log('🔴 [DEFAULT-RENDER] No positions found - fallback to end display (SAME AS REFRESH)');
        console.log('🔴 [DEFAULT-RENDER] *** EXITING DEFAULT RENDER PATH ***');
        console.log('🎨 [RENDER-END] ===========================================');
        return (
          <>
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
                  
                  const isCreation = codeContent.startsWith('creation:');
                  
                  if (isCreation) {
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
            <CreationIndicators
              creations={creations}
              onCreationClick={toggleCreationWindow}
            />
          </>
        );
      }

      // Sort positions to ensure correct order (SAME AS REFRESH RENDER)
      creationPositions.sort((a, b) => a.start - b.start);
      console.log('🔴 [DEFAULT-RENDER] Sorted positions (SAME AS REFRESH):', creationPositions.map(p => ({ start: p.start, end: p.end })));

      // Split content into parts (SAME AS REFRESH RENDER)
      const contentParts: {isCreation: boolean; content: string; creation?: Creation}[] = [];
      
      let lastPos = 0;
      
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
      
      // Render each part (SAME AS REFRESH RENDER)
      console.log('🔴 [DEFAULT-RENDER] Final content parts (SAME AS REFRESH):', {
        totalParts: contentParts.length,
        partTypes: contentParts.map((p, i) => ({ index: i, isCreation: p.isCreation, contentLength: p.content?.length || 0 }))
      });
      console.log('🔴 [DEFAULT-RENDER] *** EXITING DEFAULT RENDER PATH ***');
      console.log('🎨 [RENDER-END] ===========================================');
      return (
        <>
          {contentParts.map((part, index) => 
            part.isCreation ? (
              <CreationIndicators
                key={`default-creation-${index}`}
                creations={part.creation ? [part.creation] : []}
                onCreationClick={toggleCreationWindow}
              />
            ) : (
              <ReactMarkdown
                key={`default-text-${index}`}
                remarkPlugins={[remarkGfm, remarkMath]}
                rehypePlugins={[rehypeKatex]}
                components={{
                  code({ className, children, ...props }) {
                    const match = /language-(\w+)/.exec(className || '');
                    const language = match ? match[1] : '';
                    const codeContent = String(children).replace(/\n$/, '');
                    const blockId = `code-${Math.random().toString(36).substring(2, 9)}`;
                    const isHtml = language === 'html';
                    
                    const isCreation = codeContent.startsWith('creation:');
                    
                    if (isCreation) {
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
                {part.content}
              </ReactMarkdown>
            )
          )}
        </>
      );
    }
    
    // No creations - just render text normally
    console.log('🎨 [RENDER] No creations in default path - rendering plain text');
    console.log('🎨 [RENDER-END] ===========================================');
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
          },
          a: ({ href, children, ...props }) => {
            const isUrl = href && (href.startsWith('http://') || href.startsWith('https://'));
            
            if (isUrl && !isStreaming && !isThinking) {
              return (
                <>
                  <a href={href} {...props}>{children}</a>
                  <UrlPreviewCard url={href} />
                </>
              );
            }
            
            return <a href={href} {...props}>{children}</a>;
          }
        }}
      >
        {displayedContent}
      </ReactMarkdown>
    );
  }, [isUser, isCollectingCreation, content, isStreaming, streamedCreation, displayedContent, codeBlockCopied, isThinking, toggleCreationWindow, streamingContentParts, finalizedCreations]);

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
        
      case 'document': {
        const openViewer = () => {
          if (isPdf) {
            // Strip 'files/' prefix from file_id if present for download URL
            const cleanFileId = attachment.file_id?.replace(/^files\//, '') || attachment.file_id;
            const url = attachment.local_url || `/api/download/${cleanFileId}`;
            setPdfUrl(url);
          }
        };
        return (
          <div key={attachment.file_id} className={`message-attachment message-document ${isPdf ? 'pdf-viewer-trigger' : ''}`} onClick={openViewer}>
            <div className="attachment-icon">
              {docIcon}
            </div>
            <div className="attachment-label">{attachment.original_name}</div>
          </div>
        );
      }
        
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
    <>
    <div
      className="message-wrapper"
      onMouseEnter={() => setIsHovered(true)}
      onMouseLeave={() => setIsHovered(false)}
    >
      <div className={getMessageClass()}>
        {isHovered && (
          <div className="message-actions">
            {isUser ? (
              <>
                {onEdit && (
                  <button className="message-action-btn" onClick={onEdit} title="Edit message">
                    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" width="16" height="16">
                      <path d="M17.414 2.586a2 2 0 00-2.828 0L7 10.172V13h2.828l7.586-7.586a2 2 0 000-2.828z" />
                      <path fillRule="evenodd" d="M2 15.5A1.5 1.5 0 003.5 17h13a.5.5 0 000-1h-13a.5.5 0 01-.5-.5v-13a.5.5 0 00-1 0v13z" clipRule="evenodd" />
                    </svg>
                  </button>
                )}
                {onDelete && (
                  <button className="message-action-btn" onClick={onDelete} title="Delete to here">
                    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" width="16" height="16">
                      <path d="M6 2a1 1 0 00-1 1v1H3.5a.5.5 0 000 1h13a.5.5 0 000-1H15V3a1 1 0 00-1-1H6z" />
                      <path d="M5 6a1 1 0 011-1h8a1 1 0 011 1v9a2 2 0 01-2 2H7a2 2 0 01-2-2V6z" />
                    </svg>
                  </button>
                )}
                {onRefresh && (
                  <button className="message-action-btn" onClick={onRefresh} title="Refresh response">
                    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" width="16" height="16">
                      <path d="M3 10a7 7 0 0112-4.9V3a1 1 0 112 0v5h-5a1 1 0 110-2h2.026A5 5 0 105 10a1 1 0 11-2 0z" />
                    </svg>
                  </button>
                )}
              </>
            ) : null}
          </div>
        )}
        {!isUser && !isThinking && showCopyButton && (
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
    {pdfUrl && (
      <PDFViewer url={pdfUrl} onClose={() => setPdfUrl(null)} />
    )}
    </>
  );
};

export default Message;
