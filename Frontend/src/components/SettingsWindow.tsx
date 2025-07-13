import React, { useState, useEffect, useRef } from 'react';
import profileManager, { Profile } from '../utils/profileManager';

interface Model {
  id: string;
  name: string;
  description: string;
}

interface SettingsWindowProps {
  isOpen: boolean;
  onClose: () => void;
}

interface GenerationSettings {
  temperature: number | undefined;
  maxTokens: number | undefined;
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
  
  // General settings state
  const [ttsEnabled, setTtsEnabled] = useState(() => {
    const saved = localStorage.getItem('ttsButtonEnabled');
    return saved ? JSON.parse(saved) : true;
  });
  const [sttEnabled, setSttEnabled] = useState(() => {
    const saved = localStorage.getItem('sttButtonEnabled');
    return saved ? JSON.parse(saved) : true;
  });
  const [copyButtonEnabled, setCopyButtonEnabled] = useState(() => {
    const saved = localStorage.getItem('copyButtonEnabled');
    return saved ? JSON.parse(saved) : true;
  });
  const [modelParametersEnabled, setModelParametersEnabled] = useState(() => {
    const saved = localStorage.getItem('modelParametersEnabled');
    return saved ? JSON.parse(saved) : false;
  });
  const [imageAnnotationEnabled, setImageAnnotationEnabled] = useState(() => {
    const saved = localStorage.getItem('imageAnnotationEnabled');
    return saved ? JSON.parse(saved) : true;
  });
  const [summarizeButtonEnabled, setSummarizeButtonEnabled] = useState(() => {
    const saved = localStorage.getItem('summarizeButtonEnabled');
    return saved ? JSON.parse(saved) : true;
  });
  const [ttsVoice, setTtsVoice] = useState(() => {
    return localStorage.getItem('ttsVoice') || 'default';
  });
  const [ttsSpeed, setTtsSpeed] = useState(() => {
    const saved = localStorage.getItem('ttsSpeed');
    return saved ? parseFloat(saved) : 1.0;
  });
  const [availableVoices, setAvailableVoices] = useState<SpeechSynthesisVoice[]>([]);
  
  // Default model setting
  const [defaultModel, setDefaultModel] = useState(() => {
    return localStorage.getItem('defaultModel') || 'gemini-2.5-flash-preview-05-20';
  });
  
  // Available models (same as in Chat.tsx)
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
      id: 'deepseek/deepseek-chat-v3-0324:free', 
      name: 'DeepSeek V3',
      description: 'DeepSeek V3 chat model via OpenRouter'
    },
    { 
      id: 'qwen/qwen3-30b-a3b:free', 
      name: 'Qwen 3 30B',
      description: 'Qwen3 model via OpenRouter'
    },
    { 
      id: 'llama-3.3-70b-versatile', 
      name: 'Llama 3.3 70B',
      description: 'Really fast model via Groq'
    },
    { 
      id: 'qwen-qwq-32b', 
      name: 'Qwen QwQ 32B',
      description: 'Deep thinking model via Groq'
    }
  ];
  
  // Generation parameters state
  const [generationSettings, setGenerationSettings] = useState<GenerationSettings>(() => {
    const saved = localStorage.getItem('generationSettings');
    return saved ? JSON.parse(saved) : {
      temperature: undefined,
      maxTokens: undefined,
    };
  });
  
  // Edit state for inline editing
  const [editingTemperature, setEditingTemperature] = useState(false);
  const [editingMaxTokens, setEditingMaxTokens] = useState(false);
  const [tempTemperatureValue, setTempTemperatureValue] = useState('');
  const [tempMaxTokensValue, setTempMaxTokensValue] = useState('');

  // Load available TTS voices
  useEffect(() => {
    if ('speechSynthesis' in window) {
      const loadVoices = () => {
        const voices = window.speechSynthesis.getVoices();
        setAvailableVoices(voices);
      };
      
      loadVoices();
      window.speechSynthesis.onvoiceschanged = loadVoices;
    }
  }, []);
  
  // Save general settings to localStorage and dispatch custom events
  useEffect(() => {
    localStorage.setItem('ttsButtonEnabled', JSON.stringify(ttsEnabled));
    // Dispatch custom event for same-window updates
    window.dispatchEvent(new CustomEvent('settingsChanged', { 
      detail: { key: 'ttsButtonEnabled', value: ttsEnabled } 
    }));
  }, [ttsEnabled]);
  
  useEffect(() => {
    localStorage.setItem('sttButtonEnabled', JSON.stringify(sttEnabled));
    // Dispatch custom event for same-window updates
    window.dispatchEvent(new CustomEvent('settingsChanged', { 
      detail: { key: 'sttButtonEnabled', value: sttEnabled } 
    }));
  }, [sttEnabled]);
  
  useEffect(() => {
    localStorage.setItem('copyButtonEnabled', JSON.stringify(copyButtonEnabled));
    // Dispatch custom event for same-window updates
    window.dispatchEvent(new CustomEvent('settingsChanged', { 
      detail: { key: 'copyButtonEnabled', value: copyButtonEnabled } 
    }));
  }, [copyButtonEnabled]);
  
  useEffect(() => {
    localStorage.setItem('ttsVoice', ttsVoice);
    window.dispatchEvent(new CustomEvent('settingsChanged', { 
      detail: { key: 'ttsVoice', value: ttsVoice } 
    }));
  }, [ttsVoice]);
  
  useEffect(() => {
    localStorage.setItem('ttsSpeed', ttsSpeed.toString());
    window.dispatchEvent(new CustomEvent('settingsChanged', { 
      detail: { key: 'ttsSpeed', value: ttsSpeed } 
    }));
  }, [ttsSpeed]);
  
  useEffect(() => {
    localStorage.setItem('modelParametersEnabled', JSON.stringify(modelParametersEnabled));
    window.dispatchEvent(new CustomEvent('settingsChanged', { 
      detail: { key: 'modelParametersEnabled', value: modelParametersEnabled } 
    }));
  }, [modelParametersEnabled]);

  useEffect(() => {
    localStorage.setItem('imageAnnotationEnabled', JSON.stringify(imageAnnotationEnabled));
    window.dispatchEvent(new CustomEvent('settingsChanged', { 
      detail: { key: 'imageAnnotationEnabled', value: imageAnnotationEnabled } 
    }));
  }, [imageAnnotationEnabled]);

  useEffect(() => {
    localStorage.setItem('summarizeButtonEnabled', JSON.stringify(summarizeButtonEnabled));
    window.dispatchEvent(new CustomEvent('settingsChanged', { 
      detail: { key: 'summarizeButtonEnabled', value: summarizeButtonEnabled } 
    }));
  }, [summarizeButtonEnabled]);
  
  useEffect(() => {
    localStorage.setItem('generationSettings', JSON.stringify(generationSettings));
    window.dispatchEvent(new CustomEvent('settingsChanged', { 
      detail: { key: 'generationSettings', value: generationSettings } 
    }));
  }, [generationSettings]);

  useEffect(() => {
    localStorage.setItem('defaultModel', defaultModel);
    window.dispatchEvent(new CustomEvent('settingsChanged', { 
      detail: { key: 'defaultModel', value: defaultModel } 
    }));
  }, [defaultModel]);

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

  const handleTemperatureChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const newValue = parseFloat(e.target.value);
    setGenerationSettings((prev: GenerationSettings) => ({ ...prev, temperature: newValue }));
  };

  const handleMaxTokensChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    let newValue = parseInt(e.target.value);
    
    // Handle the step logic: 1, 100, 200, 300, etc.
    if (newValue === 1) {
      // Keep as 1
    } else if (newValue > 1 && newValue < 100) {
      // Round up to 100 for any value between 1 and 100
      newValue = 100;
    } else {
      // For values >= 100, round to nearest 100
      newValue = Math.round(newValue / 100) * 100;
    }
    
    setGenerationSettings((prev: GenerationSettings) => ({ ...prev, maxTokens: newValue }));
  };

  const handleResetParameters = () => {
    setGenerationSettings({
      temperature: undefined,
      maxTokens: undefined,
    });
    setModelParametersEnabled(false);
  };

  const handleTemperatureLabelClick = () => {
    setEditingTemperature(true);
    setTempTemperatureValue(generationSettings.temperature?.toString() || '1.0');
  };

  const handleMaxTokensLabelClick = () => {
    setEditingMaxTokens(true);
    setTempMaxTokensValue(generationSettings.maxTokens?.toString() || '4096');
  };

  const handleTemperatureInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    setTempTemperatureValue(e.target.value);
  };

  const handleMaxTokensInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    setTempMaxTokensValue(e.target.value);
  };

  const handleTemperatureInputSubmit = () => {
    const newValue = parseFloat(tempTemperatureValue);
    if (!isNaN(newValue) && newValue >= 0 && newValue <= 2) {
      setGenerationSettings(prev => ({ ...prev, temperature: newValue }));
    }
    setEditingTemperature(false);
  };

  const handleMaxTokensInputSubmit = () => {
    let newValue = parseInt(tempMaxTokensValue);
    if (!isNaN(newValue) && newValue >= 1 && newValue <= 1000000) {
      // Apply the same stepping logic as the slider
      if (newValue === 1) {
        // Keep as 1
      } else if (newValue > 1 && newValue < 100) {
        // Round up to 100 for any value between 1 and 100
        newValue = 100;
      } else {
        // For values >= 100, round to nearest 100
        newValue = Math.round(newValue / 100) * 100;
      }
      setGenerationSettings(prev => ({ ...prev, maxTokens: newValue }));
    }
    setEditingMaxTokens(false);
  };

  const handleTemperatureKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') {
      handleTemperatureInputSubmit();
    } else if (e.key === 'Escape') {
      setEditingTemperature(false);
    }
  };

  const handleMaxTokensKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') {
      handleMaxTokensInputSubmit();
    } else if (e.key === 'Escape') {
      setEditingMaxTokens(false);
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
              
              <div className="settings-group">
                <h4>Default Model</h4>
                
                <div className="setting-item">
                  <label className="setting-label-block">
                    <span>Default Model for New Chats</span>
                    <select
                      className="setting-select"
                      value={defaultModel}
                      onChange={(e) => setDefaultModel(e.target.value)}
                    >
                      {models.map((model) => (
                        <option key={model.id} value={model.id}>
                          {model.name} - {model.description}
                        </option>
                      ))}
                    </select>
                  </label>
                  <span className="setting-description">Choose the model that will be selected by default when starting new chats</span>
                </div>
              </div>
              
              <div className="settings-group">
                <h4>Interface Controls</h4>
                
                <div className="setting-item">
                  <label className="setting-label">
                    <input
                      type="checkbox"
                      checked={copyButtonEnabled}
                      onChange={(e) => setCopyButtonEnabled(e.target.checked)}
                    />
                    <span>Show Copy Button on Messages</span>
                  </label>
                  <span className="setting-description">Display a copy button on assistant messages for easy copying</span>
                </div>
                
                <div className="setting-item">
                  <label className="setting-label">
                    <input
                      type="checkbox"
                      checked={ttsEnabled}
                      onChange={(e) => setTtsEnabled(e.target.checked)}
                    />
                    <span>Show Text-to-Speech Button</span>
                  </label>
                  <span className="setting-description">Enable the TTS button in chat for spoken responses</span>
                </div>
                
                <div className="setting-item">
                  <label className="setting-label">
                    <input
                      type="checkbox"
                      checked={sttEnabled}
                      onChange={(e) => setSttEnabled(e.target.checked)}
                    />
                    <span>Show Speech-to-Text Button</span>
                  </label>
                  <span className="setting-description">Enable the microphone button for voice input</span>
                </div>
                
                <div className="setting-item">
                  <label className="setting-label">
                    <input
                      type="checkbox"
                      checked={modelParametersEnabled}
                      onChange={(e) => setModelParametersEnabled(e.target.checked)}
                    />
                    <span>Customize Model Parameters</span>
                  </label>
                  <span className="setting-description">Enable advanced model parameters like temperature and max tokens</span>
                </div>
                
                <div className="setting-item">
                  <label className="setting-label">
                    <input
                      type="checkbox"
                      checked={imageAnnotationEnabled}
                      onChange={(e) => setImageAnnotationEnabled(e.target.checked)}
                    />
                    <span>Enable Image Annotation</span>
                  </label>
                  <span className="setting-description">Show annotation modal when uploading images to add drawings before sending</span>
                </div>
                
                <div className="setting-item">
                  <label className="setting-label">
                    <input
                      type="checkbox"
                      checked={summarizeButtonEnabled}
                      onChange={(e) => setSummarizeButtonEnabled(e.target.checked)}
                    />
                    <span>Show Summarize Button</span>
                  </label>
                  <span className="setting-description">Display the summarize button in the header for generating chat summaries</span>
                </div>
              </div>
              
              {ttsEnabled && (
                <div className="settings-group">
                  <h4>Text-to-Speech Settings</h4>
                  
                  <div className="setting-item">
                    <label className="setting-label-block">
                      <span>Voice</span>
                      <select
                        className="setting-select"
                        value={ttsVoice}
                        onChange={(e) => setTtsVoice(e.target.value)}
                      >
                        <option value="default">Default Browser Voice</option>
                        {availableVoices.map((voice, index) => (
                          <option key={index} value={voice.name}>
                            {voice.name} ({voice.lang})
                          </option>
                        ))}
                      </select>
                    </label>
                  </div>
                  
                  <div className="setting-item">
                    <label className="setting-label-block">
                      <span>Speed: {ttsSpeed.toFixed(1)}x</span>
                      <input
                        type="range"
                        className="setting-slider"
                        min="0.2"
                        max="5.0"
                        step="0.1"
                        value={ttsSpeed}
                        onChange={(e) => setTtsSpeed(parseFloat(e.target.value))}
                      />
                      <div className="slider-labels">
                        <span>0.2x</span>
                        <span style={{ position: 'absolute', left: '16.67%', transform: 'translateX(-50%)' }}>1.0x</span>
                        <span>5.0x</span>
                      </div>
                    </label>
                  </div>
                </div>
              )}
              
              {modelParametersEnabled && (
                <div className="settings-group">
                  <h4>Model Parameters</h4>
                  <div className="setting-actions">
                    <button 
                      className="reset-button"
                      onClick={handleResetParameters}
                      title="Reset to default values"
                    >
                      Reset
                    </button>
                  </div>
                  
                  <div className="setting-item">
                    <label className="setting-label-block">
                      {editingTemperature ? (
                        <input
                          type="text"
                          className="parameter-edit-input"
                          value={tempTemperatureValue}
                          onChange={handleTemperatureInputChange}
                          onBlur={handleTemperatureInputSubmit}
                          onKeyDown={handleTemperatureKeyDown}
                          autoFocus
                          placeholder="0.0 - 2.0"
                        />
                      ) : (
                        <span 
                          className="parameter-label-clickable"
                          onClick={handleTemperatureLabelClick}
                          title="Click to edit (0.0 - 2.0)"
                        >
                          Temperature: {generationSettings.temperature !== undefined ? generationSettings.temperature.toFixed(1) : 'Default'}
                        </span>
                      )}
                      <input
                        type="range"
                        className="setting-slider"
                        min="0"
                        max="2"
                        step="0.1"
                        value={generationSettings.temperature ?? 1}
                        onChange={handleTemperatureChange}
                      />
                      <div className="slider-labels">
                        <span>Precise (0.0)</span>
                        <span style={{ position: 'absolute', left: '50%', transform: 'translateX(-50%)' }}>Balanced (1.0)</span>
                        <span>Creative (2.0)</span>
                      </div>
                    </label>
                    <span className="setting-description">Controls randomness in responses. Lower values are more focused and deterministic.</span>
                  </div>
                  
                  <div className="setting-item">
                    <label className="setting-label-block">
                      {editingMaxTokens ? (
                        <input
                          type="text"
                          className="parameter-edit-input"
                          value={tempMaxTokensValue}
                          onChange={handleMaxTokensInputChange}
                          onBlur={handleMaxTokensInputSubmit}
                          onKeyDown={handleMaxTokensKeyDown}
                          autoFocus
                          placeholder="1 - 1,000,000"
                        />
                      ) : (
                        <span 
                          className="parameter-label-clickable"
                          onClick={handleMaxTokensLabelClick}
                          title="Click to edit (1 - 1,000,000)"
                        >
                          Max Tokens: {generationSettings.maxTokens !== undefined ? generationSettings.maxTokens.toLocaleString() : 'Default'}
                        </span>
                      )}
                      <input
                        type="range"
                        className="setting-slider"
                        min="1"
                        max="1000000"
                        step="1"
                        value={generationSettings.maxTokens ?? 4096}
                        onChange={handleMaxTokensChange}
                      />
                      <div className="slider-labels">
                        <span>1</span>
                        <span style={{ position: 'absolute', left: '25%', transform: 'translateX(-50%)' }}>250K</span>
                        <span style={{ position: 'absolute', left: '50%', transform: 'translateX(-50%)' }}>500K</span>
                        <span style={{ position: 'absolute', left: '75%', transform: 'translateX(-50%)' }}>750K</span>
                        <span>1M</span>
                      </div>
                    </label>
                    <span className="setting-description">Maximum number of tokens in the response. Higher values allow longer responses.</span>
                  </div>
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
};

export default SettingsWindow;