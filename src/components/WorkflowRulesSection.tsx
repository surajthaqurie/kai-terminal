import { FC, useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { ChevronRight } from "lucide-react";
import type { IntegrationErrorBody } from "../core/integrations/rpcTypes";
import {
  MAX_PATTERN,
  checkBranchPattern,
  type WorkflowRules,
} from "../core/integrations/workflowRules";
import { setIntegrationRules } from "../services/integrationService";
import { formatError } from "./integrationsViewModel";

interface WorkflowRulesSectionProps {
  projectDir: string;
  /** The rules in force for this project (stored changes on top of the defaults). */
  rules: WorkflowRules;
  /** Another request is running; the form stays read-only until it ends. */
  disabled: boolean;
  /** Called after the rules were saved, so the card can re-read its status. */
  onSaved: () => void;
}

/** The pattern box stops growing here and scrolls instead. */
const PATTERN_MAX_PX = 140;

/** Line breaks are never part of a branch naming pattern: a paste is flattened to one line. */
export function oneLine(text: string): string {
  return text.replace(/[\r\n]+/g, "");
}

/** How full the pattern is, for the counter's colour. */
export function patternFill(length: number): "ok" | "near" | "over" {
  if (length > MAX_PATTERN) return "over";
  return length >= Math.ceil(MAX_PATTERN * 0.9) ? "near" : "ok";
}

/**
 * The git rules of the connected project: the merge branch (where agents start new
 * branches and which branch their pull requests target, typed by the user and
 * checked against the repository when saved, so no branch list is ever loaded)
 * and an optional branch naming pattern (a regular expression). Each can be removed.
 * Hidden behind a "Branch rules" toggle: most people never change them, and agents read them
 * through the `kai_workflow_rules` MCP tool when they start a branch.
 *
 * The pattern is one logical line but can be long, so it is shown in a box that wraps
 * and grows with the text (up to a few lines, then scrolls), with a live character
 * count against the limit. Line breaks cannot be typed or pasted into it.
 */

export const WorkflowRulesSection: FC<WorkflowRulesSectionProps> = ({
  projectDir,
  rules,
  disabled,
  onSaved,
}) => {
  const id = useId();
  const [open, setOpen] = useState(false);
  const [mergeDraft, setMergeDraft] = useState(rules.mergeBranch);
  const [patternDraft, setPatternDraft] = useState(rules.branchPattern);
  // The pattern is judged live, but only once the user has edited or left the field,
  // so a stored value is never shown as an error just for opening the section.
  const [patternTouched, setPatternTouched] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<IntegrationErrorBody | null>(null);

  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  // A different project, or rules saved elsewhere, replace what is being edited.
  useEffect(() => {
    setMergeDraft(rules.mergeBranch);
    setError(null);
  }, [rules.mergeBranch]);
  useEffect(() => {
    setPatternDraft(rules.branchPattern);
    setPatternTouched(false);
    setError(null);
  }, [rules.branchPattern]);

  // The pattern box follows its text: wrap, grow to a few lines, then scroll.
  const patternBox = useRef<HTMLTextAreaElement>(null);
  useLayoutEffect(() => {
    const el = patternBox.current;
    if (!el) return;
    el.style.height = "auto";
    const wanted = el.scrollHeight;
    if (wanted > 0) el.style.height = `${Math.min(wanted, PATTERN_MAX_PX)}px`;
    el.style.overflowY = wanted > PATTERN_MAX_PX ? "auto" : "hidden";
  }, [patternDraft, open]);

  const check = checkBranchPattern(patternDraft);
  const patternError = patternTouched ? check.error : null;
  const patternWarning = patternTouched && !check.error ? check.warning : null;

  const dirty = mergeDraft !== rules.mergeBranch || patternDraft !== rules.branchPattern;
  const locked = disabled || saving;

  const edited = () => {
    setSaved(false);
    setError(null);
  };

  const save = async () => {
    if (!dirty || saving) return;
    if (check.error) {
      setPatternTouched(true);
      return;
    }
    setSaving(true);
    setError(null);
    const res = await setIntegrationRules(projectDir, {
      mergeBranch: mergeDraft,
      branchPattern: patternDraft,
    });
    if (!mounted.current) return;
    setSaving(false);
    if (!res.ok) {
      setError(res.error);
      return;
    }
    setSaved(true);
    onSaved();
  };

  const shown = error ? formatError(error) : null;
  const patternMsgId = `${id}-pattern-msg`;
  const countId = `${id}-pattern-count`;
  const fill = patternFill(patternDraft.length);

  return (
    <div className="integration-section">
      <button
        type="button"
        className="integration-toggle"
        aria-expanded={open}
        aria-controls={`${id}-rules`}
        onClick={() => setOpen((v) => !v)}
      >
        <ChevronRight size={12} aria-hidden="true" />
        <span>Branch rules</span>
      </button>

      {open && (
        <div
          id={`${id}-rules`}
          className="integration-rules"
          role="group"
          aria-label="Branch rules"
        >
          <div className="setting-field">
            <label htmlFor={`${id}-merge`}>Merge branch</label>
            <div className="integration-field-row">
              <input
                id={`${id}-merge`}
                type="text"
                className="text-input modal-input"
                value={mergeDraft}
                placeholder="Repository default"
                spellCheck={false}
                autoComplete="off"
                disabled={locked}
                onChange={(e) => {
                  setMergeDraft(e.target.value);
                  edited();
                }}
              />
              <button
                type="button"
                className="btn btn-ghost btn-small"
                disabled={locked || mergeDraft === ""}
                aria-label="Remove merge branch"
                onClick={() => {
                  setMergeDraft("");
                  edited();
                }}
              >
                Remove
              </button>
            </div>
          </div>

          <div className="setting-field">
            <label htmlFor={`${id}-pattern`}>Branch naming (regex)</label>
            <div className="integration-field-row integration-field-row-top">
              <textarea
                id={`${id}-pattern`}
                ref={patternBox}
                rows={1}
                wrap="soft"
                className="text-input modal-input integration-pattern"
                value={patternDraft}
                placeholder="^(feature|bugfix)/\d+-[a-z0-9-]+$"
                spellCheck={false}
                autoComplete="off"
                autoCapitalize="off"
                disabled={locked}
                aria-invalid={patternError ? true : undefined}
                aria-describedby={`${countId}${patternError || patternWarning ? ` ${patternMsgId}` : ""}`}
                onChange={(e) => {
                  setPatternDraft(oneLine(e.target.value));
                  setPatternTouched(true);
                  edited();
                }}
                onKeyDown={(e) => {
                  // Enter would add a line break; a pattern is a single line.
                  if (e.key === "Enter") e.preventDefault();
                }}
                onBlur={() => setPatternTouched(true)}
              />
              <button
                type="button"
                className="btn btn-ghost btn-small"
                disabled={locked || patternDraft === ""}
                aria-label="Remove branch naming"
                onClick={() => {
                  setPatternDraft("");
                  setPatternTouched(true);
                  edited();
                }}
              >
                Remove
              </button>
            </div>
            <span id={countId} className={`integration-count is-${fill}`}>
              {patternDraft.length} / {MAX_PATTERN}
            </span>
            <div id={patternMsgId} aria-live="polite" role="status">
              {patternError && <p className="error-text integration-detected">{patternError}</p>}
              {patternWarning && (
                <p className="muted-text integration-detected">{patternWarning}</p>
              )}
            </div>
          </div>

          <div className="integration-rules-foot">
            <div className="integration-actions">
              <button
                type="button"
                className="btn btn-primary btn-small"
                disabled={locked || !dirty || check.error !== null}
                onClick={() => void save()}
              >
                {saving ? "Saving…" : "Save"}
              </button>
              <div aria-live="polite" role="status">
                {saved && <p className="integration-saved">Saved.</p>}
              </div>
            </div>
            {shown && (
              <div role="alert" className="integration-alert">
                <span>{shown.message}</span>
                {shown.hint && <code>{shown.hint}</code>}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
};
