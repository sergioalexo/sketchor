import { useEffect, useRef, useState } from "react";
import { commandSuggestions, pushHistory, recallHistory } from "./commandLine";

export interface CommandEcho {
  text: string;
  kind: "in" | "out" | "error";
}

/**
 * The docked command line (roadmap T-08): a text box at the bottom of the
 * drawing area that starts tools, runs commands and takes coordinates,
 * with an echo of the last few lines and ↑/↓ history. `commandLine.ts`
 * parses; the viewport executes; this only handles the typing.
 *
 * Esc hands focus back to the canvas rather than closing the box — the
 * drawing is where the keyboard usually belongs, and Esc in a half-drawn
 * tool means "cancel that", which the canvas handles.
 */
export function CommandBar({
  echo,
  prompt,
  onSubmit,
  onClose,
}: {
  echo: readonly CommandEcho[];
  prompt: string;
  onSubmit: (text: string) => void;
  onClose: () => void;
}) {
  const [text, setText] = useState("");
  const [history, setHistory] = useState<string[]>([]);
  const [recall, setRecall] = useState(-1);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  const suggestions = commandSuggestions(text);

  return (
    <div className="command-line" data-testid="command-line">
      {echo.length > 0 && (
        <div className="command-line-echo">
          {echo.map((line, i) => (
            <div key={i} className={`command-line-${line.kind}`}>
              {line.kind === "in" ? "> " : ""}
              {line.text}
            </div>
          ))}
        </div>
      )}
      <div className="command-line-row">
        <span className="command-line-prompt" title="What the active tool is waiting for">
          {prompt}
        </span>
        <input
          ref={inputRef}
          className="command-line-input"
          data-testid="command-line-input"
          value={text}
          placeholder="Command (l, c, o 5, 100,50, u)"
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              // Enter on an empty box repeats the last command, as it does
              // in AutoCAD — the single most-used key in the whole app.
              const line = text.trim() || history[history.length - 1] || "";
              if (line) {
                onSubmit(line);
                setHistory((h) => pushHistory(h, line));
              }
              setText("");
              setRecall(-1);
              e.preventDefault();
            } else if (e.key === "ArrowUp" || e.key === "ArrowDown") {
              const step = recallHistory(history, recall, e.key === "ArrowUp" ? -1 : 1);
              setRecall(step.index);
              setText(step.text);
              e.preventDefault();
            } else if (e.key === "Tab" && suggestions.length > 0) {
              setText(suggestions[0]);
              e.preventDefault();
            } else if (e.key === "Escape") {
              setText("");
              inputRef.current?.blur();
              e.preventDefault();
            }
            // Everything else stays in the box: the global shortcuts skip
            // events from an input, so typing "line" doesn't start four tools.
            e.stopPropagation();
          }}
        />
        {suggestions.length > 0 && (
          <span className="command-line-suggest" title="Tab completes the first one">
            {suggestions.join("  ")}
          </span>
        )}
        <button className="btn ghost sm" title="Hide the command line" onClick={onClose}>
          ✕
        </button>
      </div>
    </div>
  );
}
