import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useCoderContext } from '../../contexts/CoderContext';
import { Icons } from '../ui/Icons';
import { apiUrl } from '../../config/api';

type ApiContextLine = { lineNumber: number; text: string };
type ApiSubmatch = { start: number; end: number };

type ApiMatch = {
  lineNumber: number;
  lineText: string;
  submatches: ApiSubmatch[];
  before: ApiContextLine[];
  after: ApiContextLine[];
};

type ApiFileResult = {
  path: string;
  matches: ApiMatch[];
};

type SearchStats = {
  totalMatches: number;
  filesWithMatches: number;
  durationMs: number;
};

type SearchResponse = {
  success: boolean;
  results: ApiFileResult[];
  truncated: boolean;
  stats: SearchStats;
  error?: string;
};

type TextMatch = { start: number; length: number };

type DisplayMatch = {
  lineNumber: number;
  lineText: string;
  submatches: TextMatch[];
  before: ApiContextLine[];
  after: ApiContextLine[];
};

type DisplayFileResult = {
  path: string;
  name: string;
  fileNameMatches: TextMatch[];
  matches: DisplayMatch[];
};

type CaseSensitivity = 'smart' | 'sensitive' | 'insensitive';

const CASE_SEQUENCE: CaseSensitivity[] = ['smart', 'sensitive', 'insensitive'];

const CASE_LABEL: Record<CaseSensitivity, string> = {
  smart: 'Smart Case',
  sensitive: 'Match Case',
  insensitive: 'Ignore Case',
};

const CASE_BADGE: Record<CaseSensitivity, string> = {
  smart: 'Aa',
  sensitive: 'AA',
  insensitive: 'aa',
};

const DEFAULT_CONTEXT_LINES = 2;
const MAX_RESULTS = 400;

const computeCaseSensitive = (mode: CaseSensitivity, query: string): boolean => {
  if (mode === 'sensitive') return true;
  if (mode === 'insensitive') return false;
  return /[A-Z]/.test(query);
};

const findAllOccurrences = (haystack: string, needle: string, forceCaseSensitive: boolean): TextMatch[] => {
  if (!needle) return [];
  const matches: TextMatch[] = [];
  const target = forceCaseSensitive ? haystack : haystack.toLowerCase();
  const search = forceCaseSensitive ? needle : needle.toLowerCase();
  let index = 0;
  const step = Math.max(needle.length, 1);
  while (index <= target.length) {
    const found = target.indexOf(search, index);
    if (found === -1) break;
    matches.push({ start: found, length: needle.length });
    index = found + step;
  }
  return matches;
};

const renderHighlighted = (text: string, matches: TextMatch[]) => {
  if (matches.length === 0) return <>{text}</>;
  const parts: React.ReactNode[] = [];
  let cursor = 0;
  matches
    .slice()
    .sort((a, b) => a.start - b.start)
    .forEach((match, idx) => {
      if (match.start > cursor) {
        parts.push(<span key={`text-${idx}`}>{text.slice(cursor, match.start)}</span>);
      }
      const end = match.start + match.length;
      parts.push(
        <span key={`match-${idx}`} className="bg-yellow-600/40">
          {text.slice(match.start, end)}
        </span>
      );
      cursor = end;
    });
  if (cursor < text.length) {
    parts.push(<span key="tail">{text.slice(cursor)}</span>);
  }
  return <>{parts}</>;
};

interface ControlButtonProps {
  active: boolean;
  onClick: () => void;
  title: string;
  children: React.ReactNode;
}

const ControlButton: React.FC<ControlButtonProps> = ({ active, onClick, title, children }) => (
  <button
    type="button"
    className={`
      px-2 py-1 text-xs rounded-md border transition-all duration-150
      ${active
        ? 'border-blue-500/60 bg-blue-500/20 text-bolt-elements-textPrimary'
        : 'border-bolt-elements-borderColor bg-bolt-elements-background-depth-3 text-bolt-elements-textSecondary hover:text-bolt-elements-textPrimary'}
    `}
    onClick={onClick}
    title={title}
  >
    {children}
  </button>
);

export const SearchPanel: React.FC = () => {
  const { openTab, chatId, setActiveTab } = useCoderContext();

  const [query, setQuery] = useState('');
  const [caseSensitivity, setCaseSensitivity] = useState<CaseSensitivity>('smart');
  const [useRegex, setUseRegex] = useState(false);
  const [wholeWord, setWholeWord] = useState(false);

  const [isSearching, setIsSearching] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [results, setResults] = useState<DisplayFileResult[]>([]);
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [stats, setStats] = useState<SearchStats | null>(null);
  const [truncated, setTruncated] = useState(false);

  const controllerRef = useRef<AbortController | null>(null);
  const mountedRef = useRef(true);

  useEffect(() => {
    return () => {
      mountedRef.current = false;
      controllerRef.current?.abort();
    };
  }, []);

  useEffect(() => {
    setExpanded(prev => {
      const next: Record<string, boolean> = {};
      results.forEach(file => {
        next[file.path] = prev[file.path] ?? true;
      });
      return next;
    });
  }, [results]);

  const toggleExpanded = useCallback((path: string) => {
    setExpanded(prev => ({ ...prev, [path]: !prev[path] }));
  }, []);

  const cycleCaseSensitivity = useCallback(() => {
    setCaseSensitivity(prev => {
      const idx = CASE_SEQUENCE.indexOf(prev);
      return CASE_SEQUENCE[(idx + 1) % CASE_SEQUENCE.length];
    });
  }, []);

  const handleOpenMatch = useCallback(async (filePath: string) => {
    await openTab(filePath);
    setActiveTab('files');
  }, [openTab, setActiveTab]);

  useEffect(() => {
    const trimmed = query.trim();
    if (!chatId) {
      setError('Select a workspace to search.');
      setResults([]);
      setStats(null);
      setTruncated(false);
      return;
    }

    if (!trimmed) {
      controllerRef.current?.abort();
      setError(null);
      setResults([]);
      setStats(null);
      setTruncated(false);
      setIsSearching(false);
      return;
    }

    const controller = new AbortController();
    controllerRef.current?.abort();
    controllerRef.current = controller;

    setIsSearching(true);
    setError(null);

    const payload = {
      chat_id: chatId,
      query: trimmed,
      case_sensitivity: caseSensitivity,
      regex: useRegex,
      whole_word: wholeWord,
      context_lines: DEFAULT_CONTEXT_LINES,
      max_results: MAX_RESULTS,
    };

    (async () => {
      try {
        const response = await fetch(apiUrl('/api/coder-workspace/search'), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
          signal: controller.signal,
        });

        if (!response.ok) {
          const message = await response.text();
          throw new Error(message || `Search failed (${response.status})`);
        }

        const data: SearchResponse = await response.json();
        if (!data.success) {
          throw new Error(data.error || 'Search failed');
        }

        if (controller.signal.aborted || !mountedRef.current) {
          return;
        }

        const caseSensitiveForHighlight = computeCaseSensitive(caseSensitivity, trimmed);
        const mapped: DisplayFileResult[] = data.results.map(file => {
          const name = file.path.split('/').pop() || file.path;
          const fileNameMatches = useRegex
            ? []
            : findAllOccurrences(name, trimmed, caseSensitiveForHighlight);

          const matches: DisplayMatch[] = file.matches.map(match => ({
            lineNumber: match.lineNumber,
            lineText: match.lineText,
            submatches: match.submatches.map(sub => ({
              start: sub.start,
              length: sub.end - sub.start,
            })),
            before: match.before ?? [],
            after: match.after ?? [],
          }));

          return {
            path: file.path,
            name,
            fileNameMatches,
            matches,
          };
        });

        setResults(mapped);
        setStats(data.stats);
        setTruncated(Boolean(data.truncated));
        setIsSearching(false);
      } catch (err) {
        if ((err as DOMException).name === 'AbortError') {
          return;
        }
        if (!mountedRef.current) return;
        setIsSearching(false);
        setResults([]);
        setStats(null);
        setTruncated(false);
        setError(err instanceof Error ? err.message : 'Search failed');
      }
    })();

    return () => {
      controller.abort();
    };
  }, [chatId, query, caseSensitivity, useRegex, wholeWord]);

  const resultSummary = useMemo(() => {
    if (!stats) return null;
    const { totalMatches, filesWithMatches, durationMs } = stats;
    return `${totalMatches} match${totalMatches === 1 ? '' : 'es'} in ${filesWithMatches} file${filesWithMatches === 1 ? '' : 's'} | ${durationMs}ms`;
  }, [stats]);

  return (
    <div className="p-3 flex flex-col gap-3 h-full">
      <div className="relative">
        <input
          type="text"
          className="
            w-full px-3 py-2 pr-8
            text-sm
            bg-bolt-elements-background-depth-3
            border border-bolt-elements-borderColor
            rounded-lg
            text-bolt-elements-textPrimary
            placeholder-bolt-elements-textTertiary
            focus:outline-none
            focus:ring-2
            focus:ring-blue-500/50
            focus:border-blue-500
            transition-all duration-150
          "
          placeholder="Search in workspace..."
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        {query && (
          <button
            type="button"
            className="
              absolute right-2 top-1/2 -translate-y-1/2
              w-6 h-6 flex items-center justify-center
              rounded-md
              text-bolt-elements-textTertiary
              hover:text-bolt-elements-textPrimary
              hover:bg-bolt-elements-item-backgroundActive
              transition-all duration-150
            "
            onClick={() => setQuery('')}
            title="Clear search"
          >
            <Icons.Close className="w-4 h-4" />
          </button>
        )}
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <ControlButton
          active={caseSensitivity !== 'smart'}
          onClick={cycleCaseSensitivity}
          title={CASE_LABEL[caseSensitivity]}
        >
          {CASE_BADGE[caseSensitivity]}
        </ControlButton>
        <ControlButton
          active={useRegex}
          onClick={() => setUseRegex(prev => !prev)}
          title="Use regular expression"
        >
          .*
        </ControlButton>
        <ControlButton
          active={wholeWord}
          onClick={() => setWholeWord(prev => !prev)}
          title="Match whole word"
        >
          <span className="font-semibold">W</span>
        </ControlButton>
      </div>

      {error && (
        <div className="px-3 py-2 text-xs text-red-400 bg-red-500/10 border border-red-500/40 rounded-md">
          {error}
        </div>
      )}

      {isSearching && (
        <div className="px-3 py-2 text-xs text-bolt-elements-textSecondary">
          Searching...
        </div>
      )}

      {!isSearching && resultSummary && (
        <div className="px-3 py-2 text-xs text-bolt-elements-textSecondary">
          {resultSummary}
          {truncated && (
            <span className="text-bolt-elements-textTertiary ml-2">
              Results truncated. Refine your query for more precise matches.
            </span>
          )}
        </div>
      )}

      {!isSearching && !error && query.trim() && results.length === 0 && (
        <div className="px-3 py-2 text-xs text-bolt-elements-textSecondary">
          No matches found.
        </div>
      )}

      <div className="flex-1 overflow-auto modern-scrollbar">
        {results.map(file => {
          const isOpen = expanded[file.path] ?? true;
          return (
            <div key={file.path} className="mb-3 border-b border-bolt-elements-borderColor/40 pb-2">
              <button
                type="button"
                className="w-full text-left px-2 py-1.5 flex items-center gap-2 rounded-md hover:bg-bolt-elements-item-backgroundActive"
                onClick={() => toggleExpanded(file.path)}
              >
                <Icons.File className="w-4 h-4" />
                <div className="truncate">
                  {useRegex
                    ? file.name
                    : renderHighlighted(file.name, file.fileNameMatches)}
                </div>
                <span className="ml-auto text-xs text-bolt-elements-textTertiary">
                  {file.matches.length} match{file.matches.length === 1 ? '' : 'es'}
                </span>
              </button>

              {isOpen && file.matches.length > 0 && (
                <div className="pl-6 pt-1">
                  {file.matches.map((match, idx) => (
                    <div key={`${file.path}:${match.lineNumber}:${idx}`} className="mb-2">
                      {match.before.map(ctx => (
                        <div key={`b-${ctx.lineNumber}`} className="text-xs text-bolt-elements-textTertiary truncate">
                          {ctx.lineNumber}: {ctx.text}
                        </div>
                      ))}
                      <button
                        type="button"
                        className="w-full text-left text-sm truncate hover:bg-bolt-elements-item-backgroundActive rounded px-1"
                        onClick={() => handleOpenMatch(file.path)}
                        title={`${file.path}:${match.lineNumber}`}
                      >
                        <span className="text-bolt-elements-textTertiary mr-1">
                          {match.lineNumber}:
                        </span>
                        {renderHighlighted(match.lineText, match.submatches)}
                      </button>
                      {match.after.map(ctx => (
                        <div key={`a-${ctx.lineNumber}`} className="text-xs text-bolt-elements-textTertiary truncate">
                          {ctx.lineNumber}: {ctx.text}
                        </div>
                      ))}
                    </div>
                  ))}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
};

