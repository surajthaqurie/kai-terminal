import { FC, useEffect, useId, useState } from "react";
import { Lock, LoaderCircle } from "lucide-react";
import {
  isSharedAgentId,
  MODEL_RE,
  MODEL_SUGGESTIONS,
  type ShareAgentRow,
  type SharedAgentId,
  type ShareStatus,
} from "../core/sharedAgent/types";
import { getAiCliDetails, versionBadgeLabel, type AiCliDetails } from "../services/aiCliService";

interface Props {
  share: ShareStatus;
  /** Switches one agent on or off for sharing. */
  onToggle: (agent: SharedAgentId, enabled: boolean) => void;
  /** Sets the model every PC uses with one agent ("" = the agent's default). */
  onModel: (agent: SharedAgentId, model: string) => void;
}

/** Why an agent found by AI Providers can't be shared, when the sharing service did not say. */
const EDITOR_AGENTS = new Set(["cursor", "windsurf", "cline"]);
const reasonFor = (id: string): string =>
  id.startsWith("custom:")
    ? "Custom CLI: Kai has no verified read-only mode for it, so it can't be shared."
    : EDITOR_AGENTS.has(id)
      ? "Runs inside its editor: there is no command-line chat Kai can hold to read-only."
      : "Kai has no verified read-only mode for it yet, so it can't be shared.";

type Row =
  | { kind: "shareable"; key: string; name: string; agent: ShareAgentRow; detail: string }
  | { kind: "other"; key: string; name: string; reason: string; detail: string };

/**
 * The agents found on this PC, the same ones the AI Providers tab finds: the
 * ones that can be shared (with an on/off switch), then the rest, with the
 * reason they can't be. Agents that are not installed are not listed.
 */
export const SharedAgentProviders: FC<Props> = ({ share, onToggle, onModel }) => {
  const providers = useFoundProviders();
  const checking = share.agentsChecking === true;
  const found = new Map((providers ?? []).map((p) => [p.id, p]));

  const rows: Row[] = [];
  for (const a of share.agents) {
    const p = found.get(a.id);
    if (!a.available && !p) continue; // not on this PC: nothing to share
    const version = a.version || p?.version || "";
    rows.push({
      kind: "shareable",
      key: a.id,
      name: a.name,
      agent: a,
      detail: a.available
        ? version
          ? `Installed · ${versionBadgeLabel(version) ?? version}`
          : checking
            ? "Installed · checking version…"
            : "Installed"
        : "Found in AI Providers, but sharing can't start it. Restart Kai, then try again.",
    });
  }
  const seen = new Set(rows.map((r) => r.key));
  for (const o of share.otherClis ?? []) {
    if (seen.has(o.id)) continue;
    seen.add(o.id);
    const v = found.get(o.id)?.version;
    rows.push({
      kind: "other",
      key: o.id,
      name: o.name,
      reason: o.reason,
      detail: v ? (versionBadgeLabel(v) ?? "") : "",
    });
  }
  for (const p of providers ?? []) {
    if (seen.has(p.id) || isSharedAgentId(p.id)) continue;
    seen.add(p.id);
    rows.push({
      kind: "other",
      key: p.id,
      name: p.name,
      reason: reasonFor(p.id),
      detail: p.version ? (versionBadgeLabel(p.version) ?? "") : "",
    });
  }

  const shareable = rows.filter((r) => r.kind === "shareable");
  const others = rows.filter((r) => r.kind === "other");
  const sharedCount = shareable.filter(
    (r) => r.kind === "shareable" && r.agent.available && r.agent.enabled
  ).length;

  return (
    <section className="sa-card sa-providers" aria-labelledby="sa-agents-title">
      <div className="sa-card-head">
        <h4 id="sa-agents-title" className="sa-card-title">
          Agents on this PC
        </h4>
        <span className="sa-badge" title="Agents found on this PC, as in the AI Providers tab">
          {rows.length} found · {sharedCount} shared
        </span>
        {(checking || providers === null) && (
          <span className="sa-muted sa-checking" role="status">
            <LoaderCircle size={12} className="sa-spin" aria-hidden="true" />
            {providers === null ? "Detecting agents…" : "Checking versions…"}
          </span>
        )}
      </div>

      {rows.length === 0 && providers !== null && (
        <p className="sa-empty" role="status">
          No agents found on this PC. Install Claude Code or OpenCode (see the AI Providers tab),
          then reopen this tab.
        </p>
      )}

      {shareable.length > 0 && (
        <>
          <span className="sa-group-label">Can be shared</span>
          <span className="sa-muted">
            These switches and models apply to every PC. Switch an agent off here and no PC can use
            it, whatever its own settings say. A PC given its own model in its Agent settings keeps
            that one.
          </span>
          {shareable.map(
            (r) =>
              r.kind === "shareable" && (
                <div
                  key={r.key}
                  className={`sa-agent${r.agent.available ? "" : " is-missing"}`}
                  title={r.agent.available ? undefined : r.agent.error}
                >
                  <span className={`sa-agent-logo sa-agent-${r.key}`} aria-hidden="true">
                    {r.name.charAt(0)}
                  </span>
                  <span className="sa-grow">
                    {r.name}
                    <span className="sa-muted sa-block">{r.detail}</span>
                  </span>
                  {r.agent.available && (
                    <AgentModelField
                      agent={r.agent}
                      onSave={(model) => onModel(r.agent.id, model)}
                    />
                  )}
                  <span
                    className={`sa-badge ${r.agent.available && r.agent.enabled ? "sa-badge-ok" : ""}`}
                  >
                    {!r.agent.available ? "Unavailable" : r.agent.enabled ? "Shared" : "Off"}
                  </span>
                  <label className="sa-switch">
                    <input
                      type="checkbox"
                      role="switch"
                      aria-label={`Share ${r.name}`}
                      checked={r.agent.enabled && r.agent.available}
                      disabled={!r.agent.available}
                      onChange={(e) => onToggle(r.agent.id, e.target.checked)}
                    />
                    <span aria-hidden="true" />
                  </label>
                </div>
              )
          )}
        </>
      )}

      {others.length > 0 && (
        <>
          <span className="sa-group-label">Found · can&apos;t be shared yet</span>
          {others.map(
            (r) =>
              r.kind === "other" && (
                <div key={r.key} className="sa-agent is-unshareable" title={r.reason}>
                  <span
                    className={`sa-agent-logo sa-agent-${r.key.replace(/[^a-z0-9-]/gi, "-")}`}
                    aria-hidden="true"
                  >
                    {r.name.charAt(0)}
                  </span>
                  <span className="sa-grow">
                    {r.name}
                    {r.detail && <span className="sa-muted"> · {r.detail}</span>}
                    <span className="sa-muted sa-block">{r.reason}</span>
                  </span>
                  <span className="sa-badge">Not shareable</span>
                </div>
              )
          )}
        </>
      )}

      <span className="sa-muted sa-note">
        <Lock size={11} aria-hidden="true" />
        Read-only: PCs chat in an empty folder and can&apos;t read your files, run commands or use
        MCP tools.
      </span>
    </section>
  );
};

/**
 * The model shared PCs use with one agent. Saved on Enter or when the box loses
 * focus; Escape puts back the saved one. Empty = the agent's own default.
 */
const AgentModelField: FC<{ agent: ShareAgentRow; onSave: (model: string) => void }> = ({
  agent,
  onSave,
}) => {
  const saved = agent.model ?? "";
  const [text, setText] = useState(saved);
  const listId = useId();
  // Follow the saved value when it changes elsewhere (another save, a refresh).
  useEffect(() => setText(saved), [saved]);
  const value = text.trim();
  const invalid = value !== "" && !MODEL_RE.test(value);
  const commit = () => {
    if (!invalid && value !== saved) onSave(value);
  };
  const suggestions = MODEL_SUGGESTIONS[agent.id];
  return (
    <span className="sa-agent-model">
      <input
        className="text-input sa-mono"
        aria-label={`${agent.name} model for shared PCs`}
        aria-invalid={invalid}
        title={
          invalid
            ? "Use letters, digits and . _ : / # @ - [ ], starting with a letter or digit."
            : `The model PCs use with ${agent.name}. Leave empty for its default.`
        }
        list={suggestions ? listId : undefined}
        placeholder="Default model"
        maxLength={100}
        spellCheck={false}
        value={text}
        onChange={(e) => setText(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === "Enter") commit();
          else if (e.key === "Escape") setText(saved);
        }}
      />
      {suggestions && (
        <datalist id={listId}>
          {suggestions.map((m) => (
            <option key={m} value={m} />
          ))}
        </datalist>
      )}
    </span>
  );
};

/** The agents the AI Providers tab finds on this PC (installed only); null while detecting. */
function useFoundProviders(): AiCliDetails[] | null {
  const [found, setFound] = useState<AiCliDetails[] | null>(null);
  useEffect(() => {
    let live = true;
    getAiCliDetails()
      .then((all) => live && setFound(all.filter((p) => p.available)))
      .catch(() => live && setFound([]));
    return () => {
      live = false;
    };
  }, []);
  return found;
}
