import React, { useState, useEffect, useRef } from 'react';
import profileManager, { Profile } from '../utils/profileManager';

interface SettingsWindowProps {
  isOpen: boolean;
  onClose: () => void;
}

const SettingsWindow: React.FC<SettingsWindowProps> = ({ isOpen, onClose }) => {
  const [profiles, setProfiles] = useState<Profile[]>([]);
  const [activeProfile, setActiveProfile] = useState<string | null>(profileManager.getActiveProfile());
  const [newProfileName, setNewProfileName] = useState('');
  const [editingProfileId, setEditingProfileId] = useState<string | null>(null);
  const [editingProfileName, setEditingProfileName] = useState('');
  const [activeTab, setActiveTab] = useState<'profiles' | 'general'>('profiles');
  const modalRef = useRef<HTMLDivElement>(null);
  
  // Track knowledge base state separately from vectorization
  const [knowledgeBaseEnabled, setKnowledgeBaseEnabled] = useState<Record<string, boolean>>({});

  useEffect(() => {
    if (!isOpen) return;
    
    profileManager.refresh();
    const unsub = profileManager.subscribe((profs, active) => {
      setProfiles(profs);
      setActiveProfile(active);
      
      // Update knowledge base state - consider it enabled if the profile has files or vectorize is true
      setKnowledgeBaseEnabled(prevState => {
        const newState: Record<string, boolean> = { ...prevState };
        profs.forEach(profile => {
          // Keep existing state if manually set, otherwise auto-enable if files exist
          if (!(profile.id in prevState)) {
            newState[profile.id] = (profile.files && profile.files.length > 0) || profile.vectorize || false;
          } else {
            // Auto-enable if files were uploaded
            if (!newState[profile.id] && profile.files && profile.files.length > 0) {
              newState[profile.id] = true;
            }
          }
        });
        return newState;
      });
    });
    return () => unsub();
  }, [isOpen]);

  const handleCreateProfile = async () => {
    if (!newProfileName.trim()) return;
    await profileManager.create(newProfileName.trim());
    setNewProfileName('');
  };

  const handleSelectProfile = (id: string) => {
    profileManager.setActiveProfile(id);
  };

  const handleDeleteProfile = async (profile: Profile) => {
    const fileCount = profile.files?.length || 0;
    let confirmMessage = 'Are you sure you want to delete this profile?';
    
    if (fileCount > 0) {
      confirmMessage = `Are you sure you want to delete this profile? This will also permanently delete ${fileCount} file${fileCount !== 1 ? 's' : ''} in its knowledge base.`;
    }
    
    if (window.confirm(confirmMessage)) {
      await profileManager.remove(profile.id);
    }
  };

  const handleStartEdit = (profile: Profile, e: React.MouseEvent) => {
    e.stopPropagation();
    setEditingProfileId(profile.id);
    setEditingProfileName(profile.name);
  };

  const handleSaveEdit = async () => {
    if (!editingProfileId || !editingProfileName.trim()) return;
    
    await profileManager.update(editingProfileId, { name: editingProfileName.trim() });
    setEditingProfileId(null);
    setEditingProfileName('');
  };

  const handleCancelEdit = () => {
    setEditingProfileId(null);
    setEditingProfileName('');
  };

  const handleEditKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') {
      handleSaveEdit();
    } else if (e.key === 'Escape') {
      handleCancelEdit();
    }
  };

  const handleKnowledgeBaseToggle = (profileId: string) => {
    setKnowledgeBaseEnabled(prev => ({
      ...prev,
      [profileId]: !prev[profileId]
    }));
  };

  const handleVectorizeToggle = async (profile: Profile) => {
    await profileManager.update(profile.id, { vectorize: !profile.vectorize });
  };

  const handleFileUpload = async (profileId: string, e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (!files || files.length === 0) return;
    
    try {
      for (const file of Array.from(files)) {
        await profileManager.uploadFile(profileId, file);
      }
      
      // Ensure knowledge base is enabled after successful upload
      setKnowledgeBaseEnabled(prev => ({
        ...prev,
        [profileId]: true
      }));
    } catch (error) {
      console.error('Failed to upload files:', error);
    } finally {
      // Reset the input
      e.target.value = '';
    }
  };

  const handleDeleteFile = async (profileId: string, filename: string) => {
    if (window.confirm(`Are you sure you want to delete "${filename}"?`)) {
      try {
        await profileManager.deleteFile(profileId, filename);
      } catch (error) {
        console.error('Failed to delete file:', error);
      }
    }
  };

  // Handle escape key to close
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && isOpen) {
        onClose();
      }
    };
    
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isOpen, onClose]);

  // Handle click outside to close
  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (modalRef.current && !modalRef.current.contains(e.target as Node)) {
        onClose();
      }
    };
    
    if (isOpen) {
      setTimeout(() => {
        document.addEventListener('mousedown', handleClickOutside);
      }, 100);
    }
    
    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
    };
  }, [isOpen, onClose]);

  if (!isOpen) return null;

  return (
    <div className="settings-overlay">
      <div ref={modalRef} className="settings-window">
        <div className="settings-header">
          <h2>Settings</h2>
          <button className="settings-close-button" onClick={onClose}>
            <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <line x1="18" y1="6" x2="6" y2="18"></line>
              <line x1="6" y1="6" x2="18" y2="18"></line>
            </svg>
          </button>
        </div>
        
        <div className="settings-tabs">
          <button 
            className={`settings-tab ${activeTab === 'profiles' ? 'active' : ''}`}
            onClick={() => setActiveTab('profiles')}
          >
            Profiles
          </button>
          <button 
            className={`settings-tab ${activeTab === 'general' ? 'active' : ''}`}
            onClick={() => setActiveTab('general')}
          >
            General
          </button>
        </div>
        
        <div className="settings-content">
          {activeTab === 'profiles' ? (
            <div className="profiles-section">
              <h3>Manage Profiles</h3>
              <p className="settings-description">
                Create and manage different profiles for organizing your conversations and knowledge bases. Enable knowledge base to upload files, then optionally enable smart retrieval for AI-powered file search.
              </p>
              
              <div className="profile-list">
                {profiles.map((profile) => (
                  <div 
                    key={profile.id} 
                    className={`profile-item ${activeProfile === profile.id ? 'active' : ''}`}
                    onClick={() => handleSelectProfile(profile.id)}
                  >
                    <div className="profile-main">
                      <div className="profile-info">
                        {editingProfileId === profile.id ? (
                          <input
                            type="text"
                            value={editingProfileName}
                            onChange={(e) => setEditingProfileName(e.target.value)}
                            onKeyDown={handleEditKeyDown}
                            onBlur={handleSaveEdit}
                            autoFocus
                            className="profile-edit-input"
                            onClick={(e) => e.stopPropagation()}
                          />
                        ) : (
                          <>
                            <span className="profile-name">{profile.name}</span>
                            {activeProfile === profile.id && (
                              <span className="profile-active-badge">Active</span>
                            )}
                          </>
                        )}
                      </div>
                      
                      <div className="profile-actions">
                        {editingProfileId !== profile.id && (
                          <>
                            <button 
                              className="profile-action-button"
                              onClick={(e) => handleStartEdit(profile, e)}
                              title="Rename profile"
                            >
                              <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                                <path d="M17 3a2.85 2.85 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5L17 3z"></path>
                              </svg>
                            </button>
                            <button 
                              className="profile-action-button delete"
                              onClick={(e) => {
                                e.stopPropagation();
                                handleDeleteProfile(profile);
                              }}
                              title="Delete profile"
                            >
                              <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                                <path d="M3 6h18"></path>
                                <path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6"></path>
                                <path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2"></path>
                              </svg>
                            </button>
                          </>
                        )}
                      </div>
                    </div>
                    
                    <div className="profile-options">
                      <label className="profile-option" onClick={(e) => e.stopPropagation()}>
                        <input
                          type="checkbox"
                          checked={knowledgeBaseEnabled[profile.id] || false}
                          onChange={() => handleKnowledgeBaseToggle(profile.id)}
                        />
                        <span>Enable Knowledge Base</span>
                      </label>
                      
                      {knowledgeBaseEnabled[profile.id] && (
                        <div className="vectorize-option" onClick={(e) => e.stopPropagation()}>
                          <label className="profile-option">
                            <input
                              type="checkbox"
                              checked={profile.vectorize || false}
                              onChange={() => handleVectorizeToggle(profile)}
                            />
                            <span>Smart Retrieval (vectorized search)</span>
                          </label>
                          <span className="option-help">When enabled: AI selects most relevant files. When disabled: all files are attached directly to messages</span>
                        </div>
                      )}
                      
                      {(knowledgeBaseEnabled[profile.id] || (profile.files && profile.files.length > 0)) && (
                        <div className="profile-knowledge-section" onClick={(e) => e.stopPropagation()}>
                          {knowledgeBaseEnabled[profile.id] && (
                            <div className="profile-file-upload">
                              <label htmlFor={`file-upload-${profile.id}`} className="file-upload-label">
                                <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                                  <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path>
                                  <polyline points="17 8 12 3 7 8"></polyline>
                                  <line x1="12" y1="3" x2="12" y2="15"></line>
                                </svg>
                                <span>Upload Files</span>
                              </label>
                              <input
                                id={`file-upload-${profile.id}`}
                                type="file"
                                onChange={(e) => handleFileUpload(profile.id, e)}
                                style={{ display: 'none' }}
                                multiple
                                accept=".txt,.md,.pdf,.doc,.docx"
                              />
                            </div>
                          )}
                          
                          {profile.files && profile.files.length > 0 && (
                            <div className="profile-files-list">
                              <div className="profile-files-header">
                                <span className="files-count">{profile.files.length} file{profile.files.length !== 1 ? 's' : ''}</span>
                                {!knowledgeBaseEnabled[profile.id] && (
                                  <span className="files-disabled-note">Enable Knowledge Base to upload more files</span>
                                )}
                              </div>
                              <div className="profile-files">
                                {profile.files.map((filename) => (
                                  <div key={filename} className="profile-file-item">
                                    <span className="file-name" title={filename}>
                                      <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                                        <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path>
                                        <polyline points="14,2 14,8 20,8"></polyline>
                                      </svg>
                                      {filename}
                                    </span>
                                    <button
                                      className="file-delete-button"
                                      onClick={() => handleDeleteFile(profile.id, filename)}
                                      title="Delete file"
                                    >
                                      <svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                                        <line x1="18" y1="6" x2="6" y2="18"></line>
                                        <line x1="6" y1="6" x2="18" y2="18"></line>
                                      </svg>
                                    </button>
                                  </div>
                                ))}
                              </div>
                            </div>
                          )}
                        </div>
                      )}
                    </div>
                  </div>
                ))}
              </div>
              
              <div className="new-profile-form">
                <input
                  type="text"
                  value={newProfileName}
                  onChange={(e) => setNewProfileName(e.target.value)}
                  onKeyDown={(e) => e.key === 'Enter' && handleCreateProfile()}
                  placeholder="Enter profile name"
                  className="new-profile-input"
                />
                <button 
                  className="new-profile-button"
                  onClick={handleCreateProfile}
                  disabled={!newProfileName.trim()}
                >
                  <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <line x1="12" y1="5" x2="12" y2="19"></line>
                    <line x1="5" y1="12" x2="19" y2="12"></line>
                  </svg>
                  <span>Create Profile</span>
                </button>
              </div>
            </div>
          ) : (
            <div className="general-section">
              <h3>General Settings</h3>
              <p className="settings-description">
                General application settings and preferences.
              </p>
              <div className="settings-placeholder">
                <p>General settings coming soon...</p>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
};

export default SettingsWindow;