import { FC, useState, useEffect, useId, useRef } from "react";
import { X, ChevronUp, ChevronDown, Type, WholeWord, Regex } from "lucide-react";

export interface SearchOptions {
  caseSensitive: boolean;
  wholeWord: boolean;
  regex: boolean;
}

/** From xterm's search addon: `index` is -1 when the count passes its highlight limit. */
export interface SearchResults {
  index: number;
  count: number;
}

interface SearchBarProps {
  onSearch: (term: string, options: SearchOptions) => void;
  onSearchNext: (term: string, options: SearchOptions) => void;
  onSearchPrevious: (term: string, options: SearchOptions) => void;
  onClose: () => void;
  /** Latest result event for the current term; null before the first search. */
  results?: SearchResults | null;
}

/** "3 of 17", "No results", or "17+ matches" past the highlight limit. */
export function searchResultLabel(results: SearchResults | null | undefined): string {
  if (!results) return "";
  if (results.count === 0) return "No results";
  if (results.index < 0) return `${results.count}+ matches`;
  return `${results.index + 1} of ${results.count}`;
}

export const SearchBar: FC<SearchBarProps> = ({
  onSearch,
  onSearchNext,
  onSearchPrevious,
  onClose,
  results,
}) => {
  const [searchTerm, setSearchTerm] = useState("");
  const [caseSensitive, setCaseSensitive] = useState(false);
  const [wholeWord, setWholeWord] = useState(false);
  const [regex, setRegex] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const countId = useId();

  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
  }, []);

  const getOptions = (): SearchOptions => ({ caseSensitive, wholeWord, regex });

  const handleInputChange = (val: string) => {
    setSearchTerm(val);
    onSearch(val, getOptions());
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") {
      onClose();
    } else if (e.key === "Enter") {
      if (e.shiftKey) {
        onSearchPrevious(searchTerm, getOptions());
      } else {
        onSearchNext(searchTerm, getOptions());
      }
    }
  };

  // Only meaningful once something was typed; a cleared field shows nothing.
  const label = searchTerm ? searchResultLabel(results) : "";
  const noResults = Boolean(searchTerm) && results?.count === 0;
  const canStep = Boolean(searchTerm) && !noResults;

  return (
    <div
      className="terminal-search-bar"
      onKeyDown={handleKeyDown}
      role="search"
      aria-label="Search terminal output"
    >
      <input
        ref={inputRef}
        type="text"
        className={`search-input${noResults ? " no-results" : ""}`}
        placeholder="Search terminal output..."
        aria-label="Search terminal output"
        aria-invalid={noResults || undefined}
        aria-describedby={countId}
        value={searchTerm}
        onChange={(e) => handleInputChange(e.target.value)}
      />

      <span
        id={countId}
        className={`search-count${noResults ? " no-results" : ""}`}
        role="status"
        aria-live="polite"
      >
        {label}
      </span>

      <div className="search-options">
        <button
          className={`search-option-btn ${caseSensitive ? "active" : ""}`}
          onClick={() => {
            const next = !caseSensitive;
            setCaseSensitive(next);
            onSearch(searchTerm, { caseSensitive: next, wholeWord, regex });
          }}
          title="Match Case"
          aria-label="Match case"
          aria-pressed={caseSensitive}
        >
          <Type size={14} />
        </button>

        <button
          className={`search-option-btn ${wholeWord ? "active" : ""}`}
          onClick={() => {
            const next = !wholeWord;
            setWholeWord(next);
            onSearch(searchTerm, { caseSensitive, wholeWord: next, regex });
          }}
          title="Match Whole Word"
          aria-label="Match whole word"
          aria-pressed={wholeWord}
        >
          <WholeWord size={14} />
        </button>

        <button
          className={`search-option-btn ${regex ? "active" : ""}`}
          onClick={() => {
            const next = !regex;
            setRegex(next);
            onSearch(searchTerm, { caseSensitive, wholeWord, regex: next });
          }}
          title="Use Regular Expression"
          aria-label="Use regular expression"
          aria-pressed={regex}
        >
          <Regex size={14} />
        </button>
      </div>

      <div className="search-actions">
        <button
          className="search-nav-btn"
          onClick={() => onSearchPrevious(searchTerm, getOptions())}
          disabled={!canStep}
          title="Find Previous (Shift+Enter)"
          aria-label="Find previous match"
        >
          <ChevronUp size={14} />
        </button>

        <button
          className="search-nav-btn"
          onClick={() => onSearchNext(searchTerm, getOptions())}
          disabled={!canStep}
          title="Find Next (Enter)"
          aria-label="Find next match"
        >
          <ChevronDown size={14} />
        </button>

        <button
          className="search-close-btn"
          onClick={onClose}
          title="Close Search (Esc)"
          aria-label="Close search"
        >
          <X size={14} />
        </button>
      </div>
    </div>
  );
};
