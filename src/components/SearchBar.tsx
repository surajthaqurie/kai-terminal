import { FC, useState, useEffect, useRef } from "react";
import { X, ChevronUp, ChevronDown, Type, WholeWord, Regex } from "lucide-react";

interface SearchBarProps {
  onSearch: (
    term: string,
    options: { caseSensitive: boolean; wholeWord: boolean; regex: boolean }
  ) => void;
  onSearchNext: (
    term: string,
    options: { caseSensitive: boolean; wholeWord: boolean; regex: boolean }
  ) => void;
  onSearchPrevious: (
    term: string,
    options: { caseSensitive: boolean; wholeWord: boolean; regex: boolean }
  ) => void;
  onClose: () => void;
}

export const SearchBar: FC<SearchBarProps> = ({
  onSearch,
  onSearchNext,
  onSearchPrevious,
  onClose,
}) => {
  const [searchTerm, setSearchTerm] = useState("");
  const [caseSensitive, setCaseSensitive] = useState(false);
  const [wholeWord, setWholeWord] = useState(false);
  const [regex, setRegex] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
  }, []);

  const getOptions = () => ({ caseSensitive, wholeWord, regex });

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
        className="search-input"
        placeholder="Search terminal output..."
        aria-label="Search terminal output"
        value={searchTerm}
        onChange={(e) => handleInputChange(e.target.value)}
      />

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
          title="Find Previous (Shift+Enter)"
          aria-label="Find previous match"
        >
          <ChevronUp size={14} />
        </button>

        <button
          className="search-nav-btn"
          onClick={() => onSearchNext(searchTerm, getOptions())}
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
