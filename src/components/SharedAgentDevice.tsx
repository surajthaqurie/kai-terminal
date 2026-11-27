import { FC, useEffect, useState } from "react";
import {
  GrantsError,
  MAX_DAILY_TOKENS,
  MAX_REQUESTS_PER_HOUR,
  MAX_RUN_MINUTES_LIMIT,
  MAX_TASKS_PER_DEVICE,
  MIN_DAILY_TOKENS,
  MODEL_RE,
  SHARED_AGENT_IDS,
  SHARED_AGENT_NAMES,
  defaultGrants,
  isSharedAgentId,
  limitsFor,
  parseGrants,
  type DeviceGrants,
  type SharedAgentId,
  type DeviceHistory,
  type ShareAgentRow,
  type ShareDevice,
  type ShareStatus,
} from "../core/sharedAgent/types";
import {
  getDeviceHistory,
  setDeviceGrants,
  type SharedResult,
} from "../services/sharedAgentService";
import {
  TASK_STATUS_LABELS,
  formatAgo,
  formatCompact,
  formatCost,
  formatDuration,
  tokenBreakdown,
  tokensUsed,
} from "./sharedAgentViewModel";

interface PermissionsProps {
  device: ShareDevice;
  agents: ShareAgentRow[];
  /** Applies the new status; false when the service refused. */
  apply: (res: SharedResult<ShareStatus>) => boolean;
  onClose: () => void;
}

/** One agent's settings as typed (numbers stay text until Save checks them). */
interface AgentDraft {
  allowed: boolean;
  model: string;
  minutes: string;
  dailyTokens: string;
  perHour: string;
}

/** Model names offered while typing; any valid name may be entered. */
const MODEL_SUGGESTIONS: Partial<Record<SharedAgentId, string[]>> = {
  claude: ["sonnet", "opus", "haiku"],
};

const draftFrom = (grants: DeviceGrants): Record<SharedAgentId, AgentDraft> =>
  Object.fromEntries(
    SHARED_AGENT_IDS.map((id) => {
      const l = limitsFor(grants, id);
      return [
        id,
        {
          allowed: grants.agents[id],
          model: grants.models[id] ?? "",
          minutes: String(l.maxMinutes),
          dailyTokens: l.dailyTokens === null ? "" : String(l.dailyTokens),
          perHour: l.perHour === null ? "" : String(l.perHour),
        },
      ];
    })
  ) as Record<SharedAgentId, AgentDraft>;

const optionalNumber = (text: string): number | null => (text.trim() === "" ? null : Number(text));

/** Checks one agent's typed settings: null when fine, otherwise what to fix. */
function draftProblem(d: AgentDraft): string | null {
  const minutes = Number(d.minutes);
  if (!Number.isInteger(minutes) || minutes < 1 || minutes > MAX_RUN_MINUTES_LIMIT) {
    return `Use a whole number of minutes from 1 to ${MAX_RUN_MINUTES_LIMIT}.`;
  }
  const daily = optionalNumber(d.dailyTokens);
  if (
    daily !== null &&
    (!Number.isInteger(daily) || daily < MIN_DAILY_TOKENS || daily > MAX_DAILY_TOKENS)
  ) {
    return `Use at least ${MIN_DAILY_TOKENS.toLocaleString("en-US")} tokens a day, or leave it empty for no limit.`;
  }
  const perHour = optionalNumber(d.perHour);
  if (
    perHour !== null &&
    (!Number.isInteger(perHour) || perHour < 1 || perHour > MAX_REQUESTS_PER_HOUR)
  ) {
    return `Use 1 to ${MAX_REQUESTS_PER_HOUR} requests an hour, or leave it empty for no limit.`;
  }
  if (d.model.trim() && !MODEL_RE.test(d.model.trim())) {
    return "The model name has invalid characters.";
  }
  return null;
}

function draftSummary(d: AgentDraft): string {
  if (!d.allowed) return "Not allowed for this PC";
  const daily = optionalNumber(d.dailyTokens);
  const perHour = optionalNumber(d.perHour);
  return [
    d.model.trim() || "default model",
    `${d.minutes || "?"} min per task`,
    daily ? `${formatCompact(daily)} tokens/day` : "no daily limit",
    perHour ? `${perHour} requests/hour` : null,
  ]
    .filter(Boolean)
    .join(" · ");
}

/**
 * Each agent CLI's own settings for one PC: allowed or not, the model, how long a
 * task may run, and daily / hourly limits. "Agent CLIs on this PC" is the parent:
 * an agent switched off there is off for every PC, and its settings here wait.
 */
export const DevicePermissions: FC<PermissionsProps> = ({ device, agents, apply, onClose }) => {
  const [draft, setDraft] = useState(() => draftFrom(device.grants));
  const [open, setOpen] = useState<Set<SharedAgentId>>(() => new Set());
  const [problems, setProblems] = useState<Partial<Record<SharedAgentId, string>>>({});
  const [error, setError] = useState<string | null>(null);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);

  const edit = (id: SharedAgentId, patch: Partial<AgentDraft>) => {
    setDraft((d) => ({ ...d, [id]: { ...d[id], ...patch } }));
    setProblems((p) => ({ ...p, [id]: undefined }));
    setDirty(true);
  };
  const toggleOpen = (id: SharedAgentId) =>
    setOpen((s) => {
      const next = new Set(s);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const reset = () => {
    setDraft(draftFrom(defaultGrants()));
    setProblems({});
    setError(null);
    setDirty(true);
  };

  const save = async () => {
    // Only agents this PC may use are checked: a switched-off agent's leftovers never block Save.
    const found: Partial<Record<SharedAgentId, string>> = {};
    for (const a of agents) {
      if (!draft[a.id].allowed) continue;
      const problem = draftProblem(draft[a.id]);
      if (problem) found[a.id] = problem;
    }
    const bad = Object.keys(found) as SharedAgentId[];
    if (bad.length) {
      setProblems(found);
      setOpen((s) => new Set([...s, ...bad]));
      return;
    }
    let grants: DeviceGrants;
    try {
      grants = parseGrants({
        agents: Object.fromEntries(SHARED_AGENT_IDS.map((id) => [id, draft[id].allowed])),
        models: Object.fromEntries(SHARED_AGENT_IDS.map((id) => [id, draft[id].model])),
        maxMinutes: device.grants.maxMinutes,
        // A not-allowed agent with leftover bad numbers keeps its earlier limits.
        limits: Object.fromEntries(
          SHARED_AGENT_IDS.map((id) =>
            draftProblem(draft[id]) === null
              ? [
                  id,
                  {
                    maxMinutes: Number(draft[id].minutes),
                    dailyTokens: optionalNumber(draft[id].dailyTokens),
                    perHour: optionalNumber(draft[id].perHour),
                  },
                ]
              : [id, limitsFor(device.grants, id)]
          )
        ),
      });
    } catch (e) {
      setError(e instanceof GrantsError ? e.message : "Invalid settings.");
      return;
    }
    setSaving(true);
    const ok = apply(await setDeviceGrants(device.id, grants));
    setSaving(false);
    if (ok) onClose();
  };

  const idBase = `sa-perm-${device.id}`;
  return (
    <div className="sa-detail" role="group" aria-label={`Agent settings for ${device.name}`}>
      <div className="sa-detail-head">
        <strong>Agent settings for {device.name}</strong>
        <span className="sa-muted">
          Each agent CLI has its own settings for this PC. Changes apply from its next message.
        </span>
      </div>
      <div className="sa-row sa-acfg-tools">
        <button type="button" className="btn btn-secondary btn-small" onClick={reset}>
          Reset to defaults
        </button>
      </div>

      {agents.map((a) => {
        const d = draft[a.id];
        const parentOff = !a.enabled || !a.available;
        const on = d.allowed && !parentOff;
        const expanded = open.has(a.id);
        const use = device.today?.[a.id];
        const daily = optionalNumber(d.dailyTokens);
        const perHour = optionalNumber(d.perHour);
        const pct = daily && use ? Math.min(100, (use.tokens / daily) * 100) : 0;
        const fid = `${idBase}-${a.id}`;
        return (
          <div
            key={a.id}
            className={`sa-acfg${on ? "" : " is-off"}${parentOff ? " is-parent-off" : ""}`}
          >
            <div className="sa-acfg-head">
              <span className={`sa-agent-logo sa-agent-${a.id}`} aria-hidden="true">
                {a.name.charAt(0)}
              </span>
              <button
                type="button"
                className="sa-acfg-toggle"
                aria-expanded={expanded}
                aria-controls={`${fid}-body`}
                onClick={() => toggleOpen(a.id)}
              >
                <strong>{a.name}</strong>
                {parentOff && (
                  <span className="sa-badge sa-badge-warn">
                    {a.available ? "off for every PC" : "not installed"}
                  </span>
                )}
                <span className="sa-muted sa-block">
                  {parentOff
                    ? a.available
                      ? "Off for every PC · switch it on in Agent CLIs on this PC"
                      : "Not installed on this PC"
                    : draftSummary(d)}
                </span>
              </button>
              <label className="sa-switch">
                <input
                  type="checkbox"
                  role="switch"
                  aria-label={`Allow ${a.name}`}
                  checked={on}
                  disabled={parentOff}
                  onChange={(e) => edit(a.id, { allowed: e.target.checked })}
                />
                <span aria-hidden="true" />
              </label>
            </div>
            {expanded && (
              <div className="sa-acfg-body" id={`${fid}-body`}>
                <div className="sa-acfg-grid">
                  <label className="sa-fld" htmlFor={`${fid}-model`}>
                    <span className="sa-field-label">Model</span>
                    <input
                      id={`${fid}-model`}
                      className="text-input sa-mono"
                      aria-label={`${a.name} model`}
                      list={MODEL_SUGGESTIONS[a.id] ? `${fid}-models` : undefined}
                      placeholder="Agent's default model"
                      maxLength={100}
                      spellCheck={false}
                      disabled={!on}
                      value={d.model}
                      onChange={(e) => edit(a.id, { model: e.target.value })}
                    />
                    {MODEL_SUGGESTIONS[a.id] && (
                      <datalist id={`${fid}-models`}>
                        {MODEL_SUGGESTIONS[a.id]!.map((m) => (
                          <option key={m} value={m} />
                        ))}
                      </datalist>
                    )}
                  </label>
                  <label className="sa-fld" htmlFor={`${fid}-minutes`}>
                    <span className="sa-field-label">Stop a task after</span>
                    <span className="sa-row">
                      <input
                        id={`${fid}-minutes`}
                        className="text-input sa-num"
                        type="number"
                        aria-label={`${a.name} time limit in minutes`}
                        min={1}
                        max={MAX_RUN_MINUTES_LIMIT}
                        step={1}
                        disabled={!on}
                        value={d.minutes}
                        onChange={(e) => edit(a.id, { minutes: e.target.value })}
                      />
                      <span className="sa-muted">minutes</span>
                    </span>
                  </label>
                  <label className="sa-fld" htmlFor={`${fid}-daily`}>
                    <span className="sa-field-label">Daily token limit</span>
                    <span className="sa-row">
                      <input
                        id={`${fid}-daily`}
                        className="text-input sa-num sa-num-wide"
                        type="number"
                        aria-label={`${a.name} daily token limit`}
                        min={MIN_DAILY_TOKENS}
                        max={MAX_DAILY_TOKENS}
                        step={1000}
                        placeholder="No limit"
                        disabled={!on}
                        value={d.dailyTokens}
                        onChange={(e) => edit(a.id, { dailyTokens: e.target.value })}
                      />
                      <span className="sa-muted">tokens</span>
                    </span>
                  </label>
                  <label className="sa-fld" htmlFor={`${fid}-hour`}>
                    <span className="sa-field-label">Requests per hour</span>
                    <span className="sa-row">
                      <input
                        id={`${fid}-hour`}
                        className="text-input sa-num"
                        type="number"
                        aria-label={`${a.name} requests per hour`}
                        min={1}
                        max={MAX_REQUESTS_PER_HOUR}
                        step={1}
                        placeholder="No limit"
                        disabled={!on}
                        value={d.perHour}
                        onChange={(e) => edit(a.id, { perHour: e.target.value })}
                      />
                      <span className="sa-muted">max</span>
                    </span>
                  </label>
                </div>
                {use && (
                  <div className="sa-acfg-use">
                    <span className="sa-muted">
                      Today: <b>{formatCompact(use.tokens)}</b>
                      {daily ? ` of ${formatCompact(daily)}` : ""} tokens · {use.lastHour} request
                      {use.lastHour === 1 ? "" : "s"} in the last hour
                      {perHour ? ` of ${perHour}` : ""}
                    </span>
                    {daily ? (
                      <span className="sa-meter" aria-hidden="true">
                        <i className={pct >= 90 ? "is-hot" : ""} style={{ width: `${pct}%` }} />
                      </span>
                    ) : null}
                  </div>
                )}
                {parentOff && (
                  <p className="sa-muted sa-line">
                    {a.available
                      ? `${a.name} is switched off in Agent CLIs on this PC, so no PC can use it. This PC's settings are kept for when you switch it back on.`
                      : `${a.name} is not installed on this PC. Install it, then reopen this tab.`}
                  </p>
                )}
                {problems[a.id] && (
                  <p className="error-text sa-line" role="alert">
                    {problems[a.id]}
                  </p>
                )}
              </div>
            )}
          </div>
        );
      })}

      {error && (
        <p className="error-text sa-line" role="alert">
          {error}
        </p>
      )}
      <div className="sa-actions">
        <button
          type="button"
          className="btn btn-primary btn-small"
          onClick={() => void save()}
          disabled={saving}
        >
          Save
        </button>
        <button type="button" className="btn btn-secondary btn-small" onClick={onClose}>
          Cancel
        </button>
        {dirty && <span className="sa-badge sa-badge-warn">Unsaved changes</span>}
        <span className="sa-muted">Always read-only, in an empty folder.</span>
      </div>
    </div>
  );
};

interface UsageProps {
  device: ShareDevice;
  now: number;
}

/** One PC's usage per agent and its recent tasks. Refetches when it finishes another task. */
export const DeviceUsage: FC<UsageProps> = ({ device, now }) => {
  const [history, setHistory] = useState<DeviceHistory | null>(null);
  const [error, setError] = useState<string | null>(null);
  const runs = device.usage.runs;

  useEffect(() => {
    let cancelled = false;
    void getDeviceHistory(device.id).then((res) => {
      if (cancelled) return;
      if (res.ok) {
        setHistory(res.value);
        setError(null);
      } else {
        setError(res.error.message);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [device.id, runs]);

  const agentRows = history
    ? Object.entries(history.byAgent).flatMap(([id, u]) =>
        isSharedAgentId(id) && u ? [{ id, name: SHARED_AGENT_NAMES[id], u }] : []
      )
    : [];

  return (
    <div className="sa-detail" role="group" aria-label={`Usage of ${device.name}`}>
      <div className="sa-detail-head">
        <strong>Usage of {device.name}</strong>
        {history && (
          <span className="sa-muted">
            {history.usage.runs} request{history.usage.runs === 1 ? "" : "s"} ·{" "}
            {tokensUsed(history.usage)} tokens · {formatCost(history.usage.costUsd)}
            {history.lastUsedAt ? ` · last used ${formatAgo(history.lastUsedAt, now)}` : ""}
          </span>
        )}
      </div>
      {error && (
        <p className="error-text sa-line" role="alert">
          {error}
        </p>
      )}
      {!history && !error && <p className="sa-muted sa-line">Loading…</p>}
      {history && history.tasks.length === 0 && (
        <p className="sa-empty">This PC hasn't asked anything yet.</p>
      )}
      {agentRows.length > 0 && (
        <table className="sa-table sa-table-compact">
          <thead>
            <tr>
              <th>Agent</th>
              <th>Requests</th>
              <th>Tokens</th>
              <th>Cost</th>
            </tr>
          </thead>
          <tbody>
            {agentRows.map(({ id, name, u }) => (
              <tr key={id}>
                <td>{name}</td>
                <td>{u.runs}</td>
                <td title={tokenBreakdown(u)}>{tokensUsed(u)}</td>
                <td>{formatCost(u.costUsd)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {history && history.tasks.length > 0 && (
        <>
          <div className="sa-task-list" aria-label="Recent tasks">
            <table className="sa-table sa-table-compact">
              <thead>
                <tr>
                  <th>When</th>
                  <th>Task</th>
                  <th>Status</th>
                  <th>Tokens</th>
                  <th>Cost</th>
                </tr>
              </thead>
              <tbody>
                {history.tasks.map((t) => {
                  const s = TASK_STATUS_LABELS[t.status] ?? { label: t.status, cls: "" };
                  return (
                    <tr key={t.id}>
                      <td className="sa-nowrap" title={new Date(t.startedAt).toLocaleString()}>
                        {formatAgo(t.startedAt, now)}
                      </td>
                      <td className="sa-task-title" title={t.title}>
                        <span className="sa-muted">
                          {SHARED_AGENT_NAMES[t.agent]}
                          {t.model ? ` · ${t.model}` : ""}
                        </span>
                        <br />
                        {t.title}
                      </td>
                      <td title={t.error || undefined}>
                        <span className={`sa-badge ${s.cls}`}>{s.label}</span>
                        <br />
                        <span className="sa-muted">{formatDuration(t.durationS)}</span>
                      </td>
                      <td title={tokenBreakdown(t.tokens)}>{tokensUsed(t.tokens)}</td>
                      <td>{formatCost(t.costUsd)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <span className="sa-muted">
            The last {MAX_TASKS_PER_DEVICE} tasks are kept (only their first words); the totals keep
            counting. Removing the PC deletes its history.
          </span>
        </>
      )}
    </div>
  );
};
