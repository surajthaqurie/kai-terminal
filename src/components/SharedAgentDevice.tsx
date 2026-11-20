import { FC, useEffect, useState } from "react";
import {
  GrantsError,
  MAX_RUN_MINUTES_LIMIT,
  MAX_TASKS_PER_DEVICE,
  SHARED_AGENT_NAMES,
  isSharedAgentId,
  parseGrants,
  type DeviceGrants,
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

/** What one PC may do: which agents, which model each uses, how long a run may take. */
export const DevicePermissions: FC<PermissionsProps> = ({ device, agents, apply, onClose }) => {
  const [allowed, setAllowed] = useState<DeviceGrants["agents"]>({ ...device.grants.agents });
  const [models, setModels] = useState<DeviceGrants["models"]>({ ...device.grants.models });
  const [minutes, setMinutes] = useState(String(device.grants.maxMinutes));
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const save = async () => {
    let grants: DeviceGrants;
    try {
      grants = parseGrants({ agents: allowed, models, maxMinutes: Number(minutes) });
    } catch (e) {
      setError(e instanceof GrantsError ? e.message : "Invalid permissions.");
      return;
    }
    setSaving(true);
    const ok = apply(await setDeviceGrants(device.id, grants));
    setSaving(false);
    if (ok) onClose();
  };

  const idBase = `sa-perm-${device.id}`;
  return (
    <div className="sa-detail" role="group" aria-label={`Permissions for ${device.name}`}>
      <div className="sa-detail-head">
        <strong>Permissions for {device.name}</strong>
        <span className="sa-muted">Applies to this PC only, from its next message.</span>
      </div>
      {agents.map((a) => (
        <div key={a.id} className="sa-perm-row">
          <label className="sa-perm-agent">
            <span className="sa-switch">
              <input
                type="checkbox"
                role="switch"
                aria-label={`Allow ${a.name}`}
                checked={allowed[a.id]}
                onChange={(e) => setAllowed((x) => ({ ...x, [a.id]: e.target.checked }))}
              />
              <span aria-hidden="true" />
            </span>
            <span>
              {a.name}
              {!a.enabled && <span className="sa-muted"> · off for every PC</span>}
            </span>
          </label>
          <input
            id={`${idBase}-${a.id}-model`}
            className="text-input sa-perm-model"
            aria-label={`${a.name} model`}
            placeholder="Agent's default model"
            maxLength={100}
            spellCheck={false}
            disabled={!allowed[a.id]}
            value={models[a.id] ?? ""}
            onChange={(e) => setModels((m) => ({ ...m, [a.id]: e.target.value }))}
          />
        </div>
      ))}
      <div className="sa-perm-row">
        <label htmlFor={`${idBase}-minutes`} className="sa-perm-agent">
          Stop a task after
        </label>
        <span className="sa-perm-minutes">
          <input
            id={`${idBase}-minutes`}
            className="text-input"
            type="number"
            min={1}
            max={MAX_RUN_MINUTES_LIMIT}
            step={1}
            value={minutes}
            onChange={(e) => setMinutes(e.target.value)}
          />
          <span className="sa-muted">minutes</span>
        </span>
      </div>
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
