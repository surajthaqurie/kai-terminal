import { FC, useEffect, useId, useRef, useState } from "react";
import type { IntegrationErrorBody } from "../core/integrations/rpcTypes";
import type { WorkflowRules } from "../core/integrations/workflowRules";
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
 * The merge branch of the connected project: where agents start new branches
 * and which branch their pull requests target. Picked from the repository's real
 * branches. Hidden behind a "More" link: most people never change it, and agents
 * read it through the `kai_workflow_rules` MCP tool when they start a branch.
 */
export const WorkflowRulesSection: FC<WorkflowRulesSectionProps> = ({
  projectDir,
  rules,
  disabled,
  onSaved,
}) => {
  const id = useId();
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState(rules.mergeBranch);
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

  // A different project, or a merge branch saved elsewhere (CLI), replaces what is being edited.
  useEffect(() => {
    setDraft(rules.mergeBranch);
    setError(null);
  }, [rules.mergeBranch]);

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

  const dirty = draft !== rules.mergeBranch;
  const locked = disabled || saving;

  // The saved branch stays selectable even when the list does not (or cannot) show it.
  const options = [...(branches ?? [])];
  if (draft && !options.includes(draft)) options.unshift(draft);

  const save = async () => {
    if (!dirty || saving) return;
    setSaving(true);
    setError(null);
    const res = await setIntegrationRules(projectDir, { mergeBranch: draft });
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
          aria-label="Merge branch"
        >
          <div className="setting-field">
            <label htmlFor={`${id}-merge`}>Merge branch</label>
            <select
              id={`${id}-merge`}
              className="text-input modal-input"
              value={draft}
              disabled={locked || loading}
              onChange={(e) => {
                setDraft(e.target.value);
                setSaved(false);
                setError(null);
              }}
            >
              <option value="">Repository default</option>
              {options.map((name) => (
                <option key={name} value={name}>
                  {name}
                </option>
              ))}
            </select>
          </div>

          <div className="ai-provider-actions">
            <button
              type="button"
              className="btn btn-primary btn-small"
              disabled={locked || loading || !dirty}
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
