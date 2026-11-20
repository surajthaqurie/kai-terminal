import { FC, useState } from "react";
import { SharedAgentReceive } from "./SharedAgentReceive";
import { SharedAgentShare } from "./SharedAgentShare";

type Mode = "receive" | "share";

interface Props {
  /** True while the Shared Agent tab is the one showing. */
  active: boolean;
}

/**
 * The "Shared Agent" tab of AI CLI Providers: use another PC's Claude, or share
 * this PC's. Both halves stay mounted once opened (hidden when not showing), so a
 * chat in progress is not lost by looking at the other half.
 */
export const SharedAgentPanel: FC<Props> = ({ active }) => {
  const [mode, setMode] = useState<Mode>("receive");
  return (
    <div
      className="modal-body sa-panel"
      role="tabpanel"
      aria-labelledby="ai-cli-tab-shared"
      hidden={!active}
      style={{ display: active ? "flex" : "none" }}
    >
      <div className="sa-seg" role="tablist" aria-label="Shared agent mode">
        <button
          type="button"
          role="tab"
          aria-selected={mode === "receive"}
          className={mode === "receive" ? "active" : ""}
          onClick={() => setMode("receive")}
        >
          Use a shared agent
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={mode === "share"}
          className={mode === "share" ? "active" : ""}
          onClick={() => setMode("share")}
        >
          Share my agent
        </button>
      </div>
      <p className="sa-notice sa-notice-warn" role="note">
        Traffic is plain HTTP. Use only on a network you trust, and never port-forward.
      </p>
      <div hidden={mode !== "receive"}>
        <SharedAgentReceive active={active && mode === "receive"} />
      </div>
      <div hidden={mode !== "share"}>
        <SharedAgentShare active={active && mode === "share"} />
      </div>
    </div>
  );
};
