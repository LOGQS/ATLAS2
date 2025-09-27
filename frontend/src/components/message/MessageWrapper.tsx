import React, { useState, useCallback, useRef, useEffect } from 'react';
import MessageControls from './MessageControls';
import MessageEditEmbed from './MessageEditEmbed';
import type { AttachedFile } from '../../types/messages';
import MessageVersionSwitcher from './MessageVersionSwitcher';
import MessageInfoOverlay from './MessageInfoOverlay';
import '../../styles/message/MessageWrapper.css';

interface MessageWrapperProps {
  messageId: string;
  messageRole: 'user' | 'assistant';
  messageContent: string;
  attachedFiles?: AttachedFile[];
  messageTimestamp?: string;
  messageProvider?: string;
  messageModel?: string;
  messageRouterDecision?: {
    route: string;
    available_routes: any[];
    selected_model: string | null;
  } | null;
  messageClientId?: string;
  isStatic?: boolean;
  isEditing?: boolean;
  children: React.ReactNode;
  onCopy?: (content: string) => void;
  onTTSToggle?: (messageId: string, enabled: boolean) => void;
  onRetry?: (messageId: string) => void;
  onEdit?: (messageId: string) => void;
  onEditSave?: (newContent: string) => void;
  onEditCancel?: () => void;
  onAddFilesToMessage?: (fileIds: string[]) => Promise<void> | void;
  onDeleteFile?: (fileId: string) => Promise<void>;
  onDelete?: (messageId: string) => void;
  onVersionSwitch?: (versionChatId: string) => void;
  hasVersions?: boolean;
  currentChatId?: string;
  isTTSEnabled?: boolean;
  isTTSPlaying?: boolean;
  isTTSSupported?: boolean;
  className?: string;
}

const MessageWrapper: React.FC<MessageWrapperProps> = ({
  messageId,
  messageRole,
  messageContent,
  attachedFiles,
  messageTimestamp,
  messageProvider,
  messageModel,
  messageRouterDecision,
  messageClientId,
  isStatic = true,
  isEditing = false,
  children,
  onCopy,
  onTTSToggle,
  onRetry,
  onEdit,
  onEditSave,
  onEditCancel,
  onAddFilesToMessage,
  onDeleteFile,
  onDelete,
  onVersionSwitch,
  hasVersions = false,
  currentChatId,
  isTTSEnabled = false,
  isTTSPlaying = false,
  isTTSSupported = true,
  className = ''
}) => {
  const [showControls, setShowControls] = useState(false);
  const [isInfoOpen, setIsInfoOpen] = useState(false);
  const hoverTimeoutRef = useRef<NodeJS.Timeout | null>(null);

  const handleMouseEnter = useCallback(() => {
    if (hoverTimeoutRef.current) {
      clearTimeout(hoverTimeoutRef.current);
    }
    hoverTimeoutRef.current = setTimeout(() => {
      setShowControls(true);
    }, 200);
  }, []);

  const handleMouseLeave = useCallback(() => {
    if (hoverTimeoutRef.current) {
      clearTimeout(hoverTimeoutRef.current);
    }
    hoverTimeoutRef.current = setTimeout(() => {
      setShowControls(false);
    }, 300);
  }, []);

  useEffect(() => {
    return () => {
      if (hoverTimeoutRef.current) {
        clearTimeout(hoverTimeoutRef.current);
      }
    };
  }, []);

  const wrapperClasses = [
    'message-wrapper',
    messageRole,
    className,
    showControls && !isEditing && 'show-controls',
    isEditing && 'editing'
  ].filter(Boolean).join(' ');

  const handleInfoOpen = useCallback(() => {
    setIsInfoOpen(true);
  }, []);

  const handleInfoClose = useCallback(() => {
    setIsInfoOpen(false);
  }, []);

  return (
    <div
      className={wrapperClasses}
      onMouseEnter={!isEditing ? handleMouseEnter : undefined}
      onMouseLeave={!isEditing ? handleMouseLeave : undefined}
    >
      <div className="message-content">
        {isEditing ? (
          <MessageEditEmbed
            messageContent={messageContent}
            messageRole={messageRole}
            onSave={onEditSave ?? (() => {})}
            onCancel={onEditCancel ?? (() => {})}
            attachedFiles={attachedFiles}
            onAttachFiles={onAddFilesToMessage}
            onFileDelete={onDeleteFile}
          />
        ) : (
          children
        )}
      </div>

      {!isEditing && (
        <MessageControls
          messageId={messageId}
          messageContent={messageContent}
          messageRole={messageRole}
          isVisible={showControls && isStatic}
          showInfoButton={messageRole === 'assistant'}
          onInfoClick={handleInfoOpen}
          onCopy={onCopy}
          onTTSToggle={onTTSToggle}
          onRetry={onRetry}
          onEdit={onEdit}
          onDelete={onDelete}
          isTTSEnabled={isTTSEnabled}
          isTTSPlaying={isTTSPlaying}
          isTTSSupported={isTTSSupported}
        />
      )}

      <MessageVersionSwitcher
        messageId={messageId}
        currentChatId={currentChatId || ''}
        onVersionSwitch={onVersionSwitch}
        isVisible={showControls && isStatic && !!onVersionSwitch && !!currentChatId}
        hasVersions={hasVersions}
        messageRole={messageRole}
      />

      <MessageInfoOverlay
        isOpen={isInfoOpen}
        onClose={handleInfoClose}
        messageId={messageId}
        messageClientId={messageClientId}
        chatId={currentChatId}
        messageContent={messageContent}
        timestamp={messageTimestamp}
        provider={messageProvider}
        model={messageModel}
        routerDecision={messageRouterDecision}
        isAssistant={messageRole === 'assistant'}
      />

    </div>
  );
};

export default MessageWrapper;
