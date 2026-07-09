import { useEffect, useRef, useState } from "react";
import { diffToCommands, parseCode, toCode, type ParseIssue } from "@sketchor/core";
import { bus, doc, useApp } from "../state/store";

/**
 * Two-way code view of the sketch.
 *
 * Drawing on canvas regenerates the text; editing the text and applying
 * turns the diff into ordinary undoable commands. This same text format
 * is the surface an AI agent will use to read and modify drawings.
 */
export function CodePanel() {
  const revision = useApp((s) => s.revision);
  const [text, setText] = useState(() => toCode(doc));
  const [dirty, setDirty] = useState(false);
  const [errors, setErrors] = useState<ParseIssue[]>([]);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (!dirty) {
      setText(toCode(doc));
      setErrors([]);
    }
  }, [revision, dirty]);

  const apply = () => {
    const result = parseCode(text);
    if (result.errors.length > 0) {
      setErrors(result.errors);
      return;
    }
    const commands = diffToCommands(doc, result.entities);
    if (commands.length === 1) {
      bus.execute(commands[0]);
    } else if (commands.length > 1) {
      bus.execute({ type: "batch", commands });
    }
    setDirty(false);
    setErrors([]);
    setText(toCode(doc));
  };

  const revert = () => {
    setDirty(false);
    setErrors([]);
    setText(toCode(doc));
  };

  return (
    <aside className="codepanel">
      <div className="codepanel-header">
        <span>Sketch code</span>
        <div className="codepanel-actions">
          <button className="btn ghost" onClick={revert} disabled={!dirty} title="Discard edits">
            Revert
          </button>
          <button
            className="btn primary"
            onClick={apply}
            disabled={!dirty}
            title="Apply to drawing (Ctrl+Enter)"
            data-testid="code-apply"
          >
            Apply
          </button>
        </div>
      </div>
      <textarea
        ref={textareaRef}
        className="codepanel-text"
        data-testid="code-text"
        spellCheck={false}
        value={text}
        onChange={(e) => {
          setText(e.target.value);
          setDirty(true);
        }}
        onKeyDown={(e) => {
          if (e.ctrlKey && e.key === "Enter") {
            e.preventDefault();
            apply();
          }
        }}
      />
      {errors.length > 0 && (
        <div className="code-errors" data-testid="code-errors">
          {errors.map((err, i) => (
            <div key={i}>
              line {err.line}: {err.message}
            </div>
          ))}
        </div>
      )}
      <div className="codepanel-footer">
        <code>line L1 from (x, y) to (x, y)</code>
        <code>circle C1 at (x, y) r 20</code>
        <span className="soon">soon: param &middot; constraint &middot; dim</span>
      </div>
    </aside>
  );
}
