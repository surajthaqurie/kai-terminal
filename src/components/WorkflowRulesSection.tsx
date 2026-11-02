import { FC, useEffect, useId, useRef, useState } from "react";
import type { IntegrationErrorBody } from "../core/integrations/rpcTypes";
import { checkBranchPattern, type WorkflowRules } from "../core/integrations/workflowRules";
import { listIntegrationBranches, setIntegrationRules } from "../services/integrationService";
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

/**
 * The git rules of the connected project: the merge branch (where agents start new
 * branches and which branch their pull requests target, picked from the
 * repository's real branches) and an optional branch naming pattern (a regular
 * expression). Each can be removed. Hidden behind a "More" link: most people never
 * change them, and agents read them through the `kai_workflow_rules` MCP tool when
 * they start a branch.
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
  const [branches, setBranches] = useState<string[] | null>(null);
  const [loading, setLoading] = useState(false);
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

  // The branch list belongs to one repository: forget it when the folder changes.
  useEffect(() => {
    setBranches(null);
  }, [projectDir]);

  // Fetch the branches the first time the section is opened.
  useEffect(() => {
    if (!open || branches !== null) return;
    let cancelled = false;
    setLoading(true);
    void listIntegrationBranches(projectDir).then((res) => {
      if (cancelled || !mounted.current) return;
      setLoading(false);
      if (res.ok) setBranches(res.value);
      else setError(res.error);
    });
    return () => {
      cancelled = true;
    };
  }, [open, branches, projectDir]);

  const check = checkBranchPattern(patternDraft);
  const patternError = patternTouched ? check.error : null;
  const patternWarning = patternTouched && !check.error ? check.warning : null;

  const dirty = mergeDraft !== rules.mergeBranch || patternDraft !== rules.branchPattern;
  const locked = disabled || saving;

  // The saved branch stays selectable even when the list does not (or cannot) show it.
  const options = [...(branches ?? [])];
  if (mergeDraft && !options.includes(mergeDraft)) options.unshift(mergeDraft);

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

  return (
    <div className="integration-more">
      <button
        type="button"
        className="link-button"
        aria-expanded={open}
        aria-controls={`${id}-rules`}
        onClick={() => setOpen((v) => !v)}
      >
        {open ? "Less" : "More"}
      </button>

      {open && (
        <div
          id={`${id}-rules`}
          className="integration-switch"
          role="group"
          aria-label="Branch rules"
        >
          <div className="setting-field">
            <label htmlFor={`${id}-merge`}>Merge branch</label>
            <div className="integration-field-row">
              <select
                id={`${id}-merge`}
                className="text-input modal-input"
                value={mergeDraft}
                disabled={locked || loading}
                onChange={(e) => {
                  setMergeDraft(e.target.value);
                  edited();
                }}
              >
                <option value="">Repository default</option>
                {options.map((name) => (
                  <option key={name} value={name}>
                    {name}
                  </option>
                ))}
              </select>
              <button
                type="button"
                className="btn btn-secondary btn-small"
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
            <div className="integration-field-row">
              <input
                id={`${id}-pattern`}
                type="text"
                className="text-input modal-input"
                value={patternDraft}
                placeholder="^(feature|bugfix)/\d+-[a-z0-9-]+$"
                spellCheck={false}
                autoComplete="off"
                disabled={locked}
                aria-invalid={patternError ? true : undefined}
                aria-describedby={patternError || patternWarning ? patternMsgId : undefined}
                onChange={(e) => {
                  setPatternDraft(e.target.value);
                  setPatternTouched(true);
                  edited();
                }}
                onBlur={() => setPatternTouched(true)}
              />
              <button
                type="button"
                className="btn btn-secondary btn-small"
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
            <div id={patternMsgId} aria-live="polite" role="status">
              {patternError && <p className="error-text integration-detected">{patternError}</p>}
              {patternWarning && (
                <p className="muted-text integration-detected">{patternWarning}</p>
              )}
            </div>
          </div>

          <div className="ai-provider-actions">
            <button
              type="button"
              className="btn btn-primary btn-small"
              disabled={locked || loading || !dirty || check.error !== null}
              onClick={() => void save()}
            >
              {saving ? "Saving…" : "Save"}
            </button>
          </div>

          <div aria-live="polite" role="status">
            {loading && <p className="muted-text integration-detected">Loading branches…</p>}
            {saved && <p className="integration-ok">Saved.</p>}
          </div>
          {shown && (
            <div role="alert" className="error-text integration-error">
              <span>{shown.message}</span>
              {shown.hint && <code>{shown.hint}</code>}
            </div>
          )}
        </div>
      )}
    </div>
  );
};
