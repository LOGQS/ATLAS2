// status: complete

import React, { useState, useRef, useEffect, useCallback } from 'react';
import '../../styles/input/ModelSelector.css';

interface ModelInfo {
  id: string;
  model_id: string;
  provider: string;
  name: string;
  supports_reasoning?: boolean;
}

interface ModelsByProvider {
  [provider: string]: ModelInfo[];
}

interface ModelSelectorProps {
  models: ModelInfo[];
  modelsByProvider: ModelsByProvider;
  selectedModel: string | null; // null = Auto (router enabled)
  onModelSelect: (model: ModelInfo | null) => void;
  disabled?: boolean;
}

const PROVIDER_DISPLAY_NAMES: Record<string, string> = {
  gemini: 'Gemini',
  openrouter: 'OpenRouter',
  groq: 'Groq',
  cerebras: 'Cerebras',
  zenmux: 'Zenmux',
  cliproxy: 'CLI Proxy'
};

const ModelSelector: React.FC<ModelSelectorProps> = ({
  models,
  modelsByProvider,
  selectedModel,
  onModelSelect,
  disabled = false
}) => {
  const [isOpen, setIsOpen] = useState(false);
  const [isHovered, setIsHovered] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const containerRef = useRef<HTMLDivElement>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);

  // Close dropdown when clicking outside
  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(event.target as Node)) {
        setIsOpen(false);
        setSearchQuery('');
      }
    };

    if (isOpen) {
      document.addEventListener('mousedown', handleClickOutside);
    }

    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
    };
  }, [isOpen]);

  // Focus search input when dropdown opens
  useEffect(() => {
    if (isOpen && searchInputRef.current) {
      setTimeout(() => searchInputRef.current?.focus(), 50);
    }
  }, [isOpen]);

  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === 'Escape') {
      setIsOpen(false);
      setSearchQuery('');
    }
  }, []);

  const handleToggle = useCallback(() => {
    if (!disabled) {
      setIsOpen(prev => !prev);
    }
  }, [disabled]);

  const handleSelectAuto = useCallback(() => {
    onModelSelect(null);
    setIsOpen(false);
  }, [onModelSelect]);

  const handleSelectModel = useCallback((model: ModelInfo) => {
    onModelSelect(model);
    setIsOpen(false);
  }, [onModelSelect]);

  // Get the selected model info
  const selectedModelInfo = selectedModel
    ? models.find(m => m.id === selectedModel || m.model_id === selectedModel)
    : null;

  // Filter models based on search
  const filteredByProvider: ModelsByProvider = {};
  if (searchQuery.trim()) {
    const query = searchQuery.toLowerCase();
    Object.entries(modelsByProvider).forEach(([provider, providerModels]) => {
      const filtered = providerModels.filter(m =>
        m.name.toLowerCase().includes(query) ||
        m.model_id.toLowerCase().includes(query) ||
        provider.toLowerCase().includes(query)
      );
      if (filtered.length > 0) {
        filteredByProvider[provider] = filtered;
      }
    });
  }

  const displayModels = searchQuery.trim() ? filteredByProvider : modelsByProvider;
  const isAuto = !selectedModel;

  // Tooltip text
  const tooltipText = selectedModelInfo
    ? selectedModelInfo.name
    : 'Auto';

  return (
    <div
      ref={containerRef}
      className={`model-selector ${isOpen ? 'open' : ''} ${disabled ? 'disabled' : ''}`}
      onKeyDown={handleKeyDown}
    >
      {/* Icon-only trigger */}
      <button
        type="button"
        className={`model-selector__trigger ${isAuto ? 'auto' : 'selected'}`}
        onClick={handleToggle}
        disabled={disabled}
        aria-label={tooltipText}
        onMouseEnter={() => setIsHovered(true)}
        onMouseLeave={() => setIsHovered(false)}
      >
        {/* Sparkle/AI icon - color indicates state */}
        <svg
          className="model-selector__icon"
          viewBox="0 0 16 16"
          fill="none"
        >
          <path
            d="M8 1L9.2 6.8L15 8L9.2 9.2L8 15L6.8 9.2L1 8L6.8 6.8L8 1Z"
            fill="currentColor"
          />
        </svg>
      </button>

      {/* Hover tooltip showing current selection */}
      {isHovered && !isOpen && (
        <div className="model-selector__tooltip">
          {tooltipText}
        </div>
      )}

      {/* Dropdown panel */}
      {isOpen && (
        <div className="model-selector__dropdown">
          {/* Search input */}
          <div className="model-selector__search-container">
            <input
              ref={searchInputRef}
              type="text"
              className="model-selector__search"
              placeholder="Search models..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
            />
          </div>

          {/* Model list */}
          <div className="model-selector__list">
            {/* Auto option */}
            {!searchQuery.trim() && (
              <button
                type="button"
                className={`model-selector__item model-selector__item--auto ${isAuto ? 'active' : ''}`}
                onClick={handleSelectAuto}
              >
                <div className="model-selector__item-content">
                  <span className="model-selector__item-name">Auto</span>
                  <span className="model-selector__item-desc">Router decides best model</span>
                </div>
                {isAuto && <span className="model-selector__check">✓</span>}
              </button>
            )}

            {/* Models grouped by provider */}
            {Object.entries(displayModels).map(([provider, providerModels]) => (
              <div key={provider} className="model-selector__provider-group">
                <div className="model-selector__provider-header">
                  {PROVIDER_DISPLAY_NAMES[provider] || provider}
                </div>
                {providerModels.map((model) => {
                  const isActive = selectedModel === model.id || selectedModel === model.model_id;
                  return (
                    <button
                      key={model.id}
                      type="button"
                      className={`model-selector__item ${isActive ? 'active' : ''}`}
                      onClick={() => handleSelectModel(model)}
                    >
                      <span className="model-selector__item-name">{model.name}</span>
                      {model.supports_reasoning && (
                        <span className="model-selector__item-badge">Reasoning</span>
                      )}
                      {isActive && <span className="model-selector__check">✓</span>}
                    </button>
                  );
                })}
              </div>
            ))}

            {searchQuery.trim() && Object.keys(displayModels).length === 0 && (
              <div className="model-selector__empty">No models found</div>
            )}
          </div>
        </div>
      )}
    </div>
  );
};

export default ModelSelector;
