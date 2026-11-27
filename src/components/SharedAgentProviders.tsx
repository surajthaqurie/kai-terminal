import { FC } from "react";
import { Lock, LoaderCircle } from "lucide-react";
import type { SharedAgentId, ShareStatus } from "../core/sharedAgent/types";

interface Props {
  share: ShareStatus;
  /** Switches one agent on or off for sharing. */
  onToggle: (agent: SharedAgentId, enabled: boolean) => void;
}

/**
 * Every coding-agent CLI Kai knows about on this PC: the ones that can be shared
 * (with an on/off switch, installed or not), then the installed ones that can't,
 * with the reason. Shown whether sharing is on or off, so the person can pick
 * agents before starting.
 */
export const SharedAgentProviders: FC<Props> = ({ share, onToggle }) => {
  const others = share.otherClis ?? [];
  const installed = share.agents.filter((a) => a.available).length + others.length;
  const total = share.agents.length + others.length;
  const checking = share.agentsChecking === true;

  return (
    <section className="sa-card sa-providers" aria-labelledby="sa-agents-title">
      <div className="sa-card-head">
        <h4 id="sa-agents-title" className="sa-card-title">
          Agent CLIs on this PC
        </h4>
        <span className="sa-badge" title="Installed agent CLIs">
          {installed} of {total} installed
        </span>
        {checking && (
          <span className="sa-muted sa-checking" role="status">
            <LoaderCircle size={12} className="sa-spin" aria-hidden="true" />
            Checking versions…
          </span>
        )}
      </div>

      <span className="sa-group-label">Can be shared</span>
      <span className="sa-muted">
        These switches apply to every PC. Switch an agent off here and no PC can use it, whatever
        its own settings say.
      </span>
      {share.agents.map((a) => (
        <div
          key={a.id}
          className={`sa-agent${a.available ? "" : " is-missing"}`}
          title={a.available ? undefined : a.error}
        >
          <span className={`sa-agent-logo sa-agent-${a.id}`} aria-hidden="true">
            {a.name.charAt(0)}
          </span>
          <span className="sa-grow">
            {a.name}
            <span className="sa-muted sa-block">
              {a.available
                ? a.version
                  ? `Installed · ${a.version}`
                  : checking
                    ? "Installed · checking version…"
                    : "Installed"
                : "Not installed · install it, then reopen this tab"}
            </span>
          </span>
          <span className={`sa-badge ${a.available ? "sa-badge-ok" : ""}`}>
            {a.available ? "Installed" : "Missing"}
          </span>
          <label className="sa-switch">
            <input
              type="checkbox"
              role="switch"
              aria-label={`Share ${a.name}`}
              checked={a.enabled && a.available}
              disabled={!a.available}
              onChange={(e) => onToggle(a.id, e.target.checked)}
            />
            <span aria-hidden="true" />
          </label>
        </div>
      ))}

      {others.length > 0 && (
        <>
          <span className="sa-group-label">Installed · can&apos;t be shared yet</span>
          {others.map((o) => (
            <div key={o.id} className="sa-agent is-unshareable" title={o.reason}>
              <span className={`sa-agent-logo sa-agent-${o.id}`} aria-hidden="true">
                {o.name.charAt(0)}
              </span>
              <span className="sa-grow">
                {o.name}
                <span className="sa-muted sa-block">{o.reason}</span>
              </span>
              <span className="sa-badge sa-badge-ok">Installed</span>
              <label className="sa-switch">
                <input
                  type="checkbox"
                  role="switch"
                  aria-label={`Share ${o.name} (not available)`}
                  checked={false}
                  disabled
                  readOnly
                />
                <span aria-hidden="true" />
              </label>
            </div>
          ))}
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
