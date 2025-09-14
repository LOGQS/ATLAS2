import React, { useState, useCallback, useRef, useEffect } from 'react';
import '../../styles/message/MessageEditEmbed.css';
import UserMessageFiles from '../files/UserMessageFiles';
import { BrowserStorage } from '../../utils/storage/BrowserStorage';
import logger from '../../utils/core/logger';
import type { AttachedFile as MessageAttachedFile } from '../../types/messages';

interface MessageEditEmbedProps {
  messageContent: string;
  messageRole: 'user' | 'assistant';
  onSave: (newContent: string) => void;
  onCancel: () => void;
  attachedFiles?: MessageAttachedFile[];
  onAttachFiles?: (fileIds: string[]) => Promise<void> | void;
  onFileDelete?: (fileId: string) => Promise<void>;
}

const MessageEditEmbed: React.FC<MessageEditEmbedProps> = ({
  messageContent,
  messageRole,
  onSave,
  onCancel,
  attachedFiles,
  onAttachFiles,
  onFileDelete
}) => {
  const [content, setContent] = useState(messageContent);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const [showAddMenu, setShowAddMenu] = useState(false);
  const [readyFiles, setReadyFiles] = useState<MessageAttachedFile[]>([]);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const pickerRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (textareaRef.current) {
      textareaRef.current.focus();
      textareaRef.current.select();
    }
  }, []);

  useEffect(() => {
    setContent(messageContent);
  }, [messageContent]);

  useEffect(() => {
    if (!showAddMenu) return;
    try {
      const all = BrowserStorage.getAttachedFiles();
      const ready = all.filter(f => f.api_state === 'ready');
      setReadyFiles(ready);
      setSelectedIds(new Set());
      logger.info(`[EditEmbed] Ready files available for attaching: ${ready.length}`);
    } catch (e) {
      logger.error('[EditEmbed] Failed to load ready files from storage', e);
    }
  }, [showAddMenu]);

  useEffect(() => {
    if (!showAddMenu) return;
    const handleClickOutside = (e: MouseEvent) => {
      const target = e.target as Node;
      if (pickerRef.current && !pickerRef.current.contains(target)) {
        setShowAddMenu(false);
      }
    };
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setShowAddMenu(false);
    };
    document.addEventListener('mousedown', handleClickOutside);
    document.addEventListener('keydown', handleKey);
    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
      document.removeEventListener('keydown', handleKey);
    };
  }, [showAddMenu]);

  const toggleSelect = useCallback((id: string) => {
    setSelectedIds(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }, []);

  const attachSelected = useCallback(async () => {
    if (!onAttachFiles) return;
    const ids = Array.from(selectedIds);
    if (ids.length === 0) return;
    try {
      await onAttachFiles(ids);
      setShowAddMenu(false);
      setSelectedIds(new Set());
    } catch (e) {
      logger.error('[EditEmbed] Failed to attach selected files', e);
    }
  }, [onAttachFiles, selectedIds]);

  const handleSave = useCallback(() => {
    const trimmedContent = content.trim();
    if (trimmedContent && trimmedContent !== messageContent.trim()) {
      onSave(trimmedContent);
    } else {
      onCancel();
    }
  }, [content, messageContent, onSave, onCancel]);

  const handleCancel = useCallback(() => {
    setContent(messageContent);
    onCancel();
  }, [messageContent, onCancel]);

  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === 'Escape') {
      handleCancel();
    } else if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      handleSave();
    }
  }, [handleCancel, handleSave]);

  const handleTextareaChange = useCallback((e: React.ChangeEvent<HTMLTextAreaElement>) => {
    setContent(e.target.value);
    const textarea = e.target;
    textarea.style.height = 'auto';
    textarea.style.height = `${textarea.scrollHeight}px`;
  }, []);

  const isContentChanged = content.trim() !== messageContent.trim() && content.trim() !== '';

  return (
    <div className={`message-edit-embed ${messageRole === 'user' ? 'user-edit' : 'assistant-edit'}`}>
      <div className="edit-embed-content">
        <textarea
          ref={textareaRef}
          value={content}
          onChange={handleTextareaChange}
          onKeyDown={handleKeyDown}
          className="edit-embed-textarea"
          placeholder="Enter message content..."
          rows={Math.max(3, Math.min(15, content.split('\n').length + 1))}
        />

        {messageRole === 'user' && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
              <div style={{ fontSize: '13px', opacity: 0.85 }}>Attached Files</div>
              {!!onAttachFiles && (
                <div style={{ position: 'relative' }} ref={pickerRef}>
                  <button
                    className="edit-embed-btn edit-embed-btn-secondary"
                    onClick={() => setShowAddMenu(v => !v)}
                    title="Add file to this message"
                  >
                    +
                  </button>
                  {showAddMenu && (
                    <div
                      style={{
                        position: 'absolute',
                        right: 0,
                        marginTop: '6px',
                        background: 'rgba(0,0,0,0.8)',
                        border: '1px solid rgba(255,255,255,0.15)',
                        borderRadius: '8px',
                        padding: '8px',
                        minWidth: '260px',
                        zIndex: 1500,
                        boxShadow: '0 8px 24px rgba(0,0,0,0.4)'
                      }}
                    >
                      {readyFiles.length === 0 ? (
                        <div style={{ fontSize: '12px', color: 'rgba(255,255,255,0.7)' }}>
                          No ready files found. Use the + near the input to upload.
                        </div>
                      ) : (
                        <>
                          <div style={{ display: 'flex', flexDirection: 'column', gap: '6px', maxHeight: '220px', overflowY: 'auto', paddingBottom: '6px' }}>
                            {readyFiles.map((f) => {
                              const checked = selectedIds.has(f.id);
                              return (
                                <label key={f.id} style={{ display: 'flex', alignItems: 'center', gap: '8px', cursor: 'pointer' }} title={`Select ${f.name}`}>
                                  <input
                                    type="checkbox"
                                    checked={checked}
                                    onChange={() => toggleSelect(f.id)}
                                    style={{ cursor: 'pointer' }}
                                  />
                                  <span style={{ display: 'inline-flex', alignItems: 'center', gap: '6px' }}>
                                    <span>📎</span>
                                    <span style={{ fontSize: '13px' }}>{f.name.length > 26 ? `${f.name.slice(0, 26)}…` : f.name}</span>
                                  </span>
                                </label>
                              );
                            })}
                          </div>
                          <div style={{ display: 'flex', justifyContent: 'space-between', gap: '8px', borderTop: '1px solid rgba(255,255,255,0.1)', paddingTop: '6px' }}>
                            <button
                              className="edit-embed-btn edit-embed-btn-secondary"
                              onClick={() => setShowAddMenu(false)}
                            >
                              Cancel
                            </button>
                            <button
                              className="edit-embed-btn edit-embed-btn-primary"
                              onClick={attachSelected}
                              disabled={selectedIds.size === 0}
                              title={selectedIds.size ? `Attach ${selectedIds.size} file(s)` : 'Select files to attach'}
                            >
                              Attach {selectedIds.size > 0 ? `(${selectedIds.size})` : ''}
                            </button>
                          </div>
                        </>
                      )}
                    </div>
                  )}
                </div>
              )}
            </div>

            {attachedFiles && attachedFiles.length > 0 ? (
              <UserMessageFiles
                files={attachedFiles}
                onFileDelete={onFileDelete}
                isStatic={true}
              />
            ) : (
              <div style={{ fontSize: '12px', opacity: 0.75 }}>No files attached. Click + to add.</div>
            )}
          </div>
        )}
        
        <div className="edit-embed-actions">
          <div className="edit-embed-shortcuts">
            <span>Ctrl+Enter to save • Escape to cancel</span>
          </div>
          <div className="edit-embed-buttons">
            <button 
              className="edit-embed-btn edit-embed-btn-secondary" 
              onClick={handleCancel}
            >
              Cancel
            </button>
            <button 
              className="edit-embed-btn edit-embed-btn-primary" 
              onClick={handleSave}
              disabled={!isContentChanged}
            >
              Save
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};

export default MessageEditEmbed;
