import React, { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { useCoderContext } from '../../contexts/CoderContext';
import { getFileIcon } from '../ui/Icons';
import { PhosphorIcon } from '../ui/PhosphorIcons';

interface QuickFileSearchProps {
  isOpen: boolean;
  onClose: () => void;
}

interface FileMatch {
  path: string;
  name: string;
  score: number;
  matchIndices: number[];
}

/**
 * Fuzzy search implementation
 * Returns match score and indices of matched characters
 */
function fuzzyMatch(query: string, text: string): { score: number; indices: number[] } | null {
  const queryLower = query.toLowerCase();
  const textLower = text.toLowerCase();

  if (!query) return { score: 0, indices: [] };

  const indices: number[] = [];
  let queryIndex = 0;
  let score = 0;
  let lastMatchIndex = -1;

  for (let i = 0; i < textLower.length && queryIndex < queryLower.length; i++) {
    if (textLower[i] === queryLower[queryIndex]) {
      indices.push(i);

      // Bonus for consecutive matches
      if (lastMatchIndex === i - 1) {
        score += 5;
      }

      // Bonus for matching start of path segment
      if (i === 0 || text[i - 1] === '/' || text[i - 1] === '\\') {
        score += 10;
      }

      // Bonus for case match
      if (text[i] === query[queryIndex]) {
        score += 2;
      }

      score += 1;
      lastMatchIndex = i;
      queryIndex++;
    }
  }

  // Must match all query characters
  if (queryIndex !== queryLower.length) {
    return null;
  }

  // Penalty for longer paths (prefer shorter paths)
  score -= text.length * 0.1;

  return { score, indices };
}

/**
 * Recursively collect all file paths from the file tree
 */
function collectFilePaths(node: any, paths: string[] = []): string[] {
  if (node.type === 'file') {
    paths.push(node.path);
  } else if (node.type === 'directory' && node.children) {
    node.children.forEach((child: any) => collectFilePaths(child, paths));
  }
  return paths;
}

export const QuickFileSearch: React.FC<QuickFileSearchProps> = ({ isOpen, onClose }) => {
  const { fileTree, openTab } = useCoderContext();
  const [query, setQuery] = useState('');
  const [selectedIndex, setSelectedIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const selectedRef = useRef<HTMLDivElement>(null);

  // Collect all file paths
  const allFilePaths = useMemo(() => {
    if (!fileTree) return [];
    return collectFilePaths(fileTree);
  }, [fileTree]);

  // Fuzzy search and rank results
  const searchResults = useMemo(() => {
    if (!query.trim()) {
      // Show all files when no query
      return allFilePaths
        .map(path => ({
          path,
          name: path.split(/[/\\]/).pop() || path,
          score: 0,
          matchIndices: [] as number[],
        }))
        .slice(0, 50); // Limit to 50 results
    }

    const matches: FileMatch[] = [];

    for (const filePath of allFilePaths) {
      const fileName = filePath.split(/[/\\]/).pop() || filePath;

      // Try matching against filename first
      const fileNameMatch = fuzzyMatch(query, fileName);
      // Also try matching against full path
      const fullPathMatch = fuzzyMatch(query, filePath);

      // Use the better match
      const bestMatch = fileNameMatch && fullPathMatch
        ? (fileNameMatch.score > fullPathMatch.score ? fileNameMatch : fullPathMatch)
        : (fileNameMatch || fullPathMatch);

      if (bestMatch) {
        matches.push({
          path: filePath,
          name: fileName,
          score: bestMatch.score,
          matchIndices: bestMatch.indices,
        });
      }
    }

    // Sort by score (highest first)
    return matches.sort((a, b) => b.score - a.score).slice(0, 50);
  }, [query, allFilePaths]);

  // Reset selected index when results change
  useEffect(() => {
    setSelectedIndex(0);
  }, [searchResults]);

  // Focus input when opened
  useEffect(() => {
    if (isOpen) {
      inputRef.current?.focus();
      setQuery('');
      setSelectedIndex(0);
    }
  }, [isOpen]);

  // Scroll selected item into view
  useEffect(() => {
    if (selectedRef.current) {
      selectedRef.current.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    }
  }, [selectedIndex]);

  const handleSelectFile = useCallback(async (filePath: string) => {
    await openTab(filePath);
    onClose();
  }, [openTab, onClose]);

  // Keyboard navigation
  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setSelectedIndex(prev => Math.min(prev + 1, searchResults.length - 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setSelectedIndex(prev => Math.max(prev - 1, 0));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      if (searchResults[selectedIndex]) {
        handleSelectFile(searchResults[selectedIndex].path);
      }
    } else if (e.key === 'Escape') {
      e.preventDefault();
      onClose();
    }
  }, [searchResults, selectedIndex, handleSelectFile, onClose]);

  // Render matched characters with highlights
  const renderHighlightedText = (text: string, indices: number[]) => {
    const parts: React.ReactElement[] = [];
    let lastIndex = 0;

    indices.forEach((index, i) => {
      // Add non-matched text
      if (index > lastIndex) {
        parts.push(
          <span key={`text-${i}`}>
            {text.substring(lastIndex, index)}
          </span>
        );
      }
      // Add matched character
      parts.push(
        <span key={`match-${i}`} className="text-blue-400 font-semibold">
          {text[index]}
        </span>
      );
      lastIndex = index + 1;
    });

    // Add remaining text
    if (lastIndex < text.length) {
      parts.push(
        <span key="text-end">
          {text.substring(lastIndex)}
        </span>
      );
    }

    return <>{parts}</>;
  };

  if (!isOpen) return null;

  return (
    <AnimatePresence>
      <motion.div
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        exit={{ opacity: 0 }}
        transition={{ duration: 0.15 }}
        className="fixed inset-0 z-[999] flex items-start justify-center pt-[15vh] bg-black/50"
        onClick={onClose}
      >
        <motion.div
          initial={{ scale: 0.95, opacity: 0, y: -20 }}
          animate={{ scale: 1, opacity: 1, y: 0 }}
          exit={{ scale: 0.95, opacity: 0, y: -20 }}
          transition={{ duration: 0.2, ease: [0.4, 0, 0.2, 1] }}
          className="w-full max-w-2xl mx-4 bg-bolt-elements-background-depth-1 rounded-lg shadow-2xl overflow-hidden border border-bolt-elements-borderColor"
          onClick={(e) => e.stopPropagation()}
        >
          {/* Search Input */}
          <div className="flex items-center gap-3 px-4 py-3 border-b border-bolt-elements-borderColor">
            <PhosphorIcon.MagnifyingGlass className="w-5 h-5 text-bolt-elements-textTertiary" />
            <input
              ref={inputRef}
              type="text"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder="Search files..."
              className="flex-1 bg-transparent outline-none text-bolt-elements-textPrimary placeholder:text-bolt-elements-textTertiary"
            />
            <div className="flex items-center gap-2 text-xs text-bolt-elements-textTertiary">
              <span className="px-1.5 py-0.5 bg-bolt-elements-background-depth-3 rounded">↑↓</span>
              <span className="px-1.5 py-0.5 bg-bolt-elements-background-depth-3 rounded">Enter</span>
              <span className="px-1.5 py-0.5 bg-bolt-elements-background-depth-3 rounded">Esc</span>
            </div>
          </div>

          {/* Results List */}
          <div className="max-h-[60vh] overflow-y-auto modern-scrollbar">
            {searchResults.length === 0 ? (
              <div className="flex flex-col items-center justify-center py-12 text-bolt-elements-textTertiary">
                <PhosphorIcon.FileSearch className="w-12 h-12 mb-3 opacity-50" />
                <p className="text-sm">No files found</p>
              </div>
            ) : (
              searchResults.map((result, index) => {
                const FileIconComponent = getFileIcon(result.name);
                const isSelected = index === selectedIndex;

                return (
                  <div
                    key={result.path}
                    ref={isSelected ? selectedRef : null}
                    className={`
                      flex items-center gap-3 px-4 py-2.5 cursor-pointer border-l-2 transition-all duration-150
                      ${isSelected
                        ? 'bg-blue-500/20 border-blue-500 text-bolt-elements-textPrimary'
                        : 'border-transparent text-bolt-elements-textSecondary hover:bg-bolt-elements-item-backgroundActive hover:text-bolt-elements-textPrimary'
                      }
                    `}
                    onClick={() => handleSelectFile(result.path)}
                    onMouseEnter={() => setSelectedIndex(index)}
                  >
                    <FileIconComponent className="w-4 h-4 shrink-0" />
                    <div className="flex-1 min-w-0 flex flex-col">
                      <div className="text-sm font-medium truncate">
                        {renderHighlightedText(result.name, result.matchIndices)}
                      </div>
                      <div className="text-xs text-bolt-elements-textTertiary truncate">
                        {result.path}
                      </div>
                    </div>
                  </div>
                );
              })
            )}
          </div>
        </motion.div>
      </motion.div>
    </AnimatePresence>
  );
};
