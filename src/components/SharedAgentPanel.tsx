import { FC, useState } from "react";
import { MessagesSquare, Share2, ShieldAlert } from "lucide-react";
import { SharedAgentReceive } from "./SharedAgentReceive";
import { SharedAgentShare } from "./SharedAgentShare";

type Mode = "receive" | "share";

interface Props {
  /** True while the Shared Agent tab is the one showing. */
  active: boolean;
}

/**
 * The "Shared Agent" tab of AI CLI Providers: share this PC's agents (shown
 * first), or use another PC's. Both halves stay mounted once opened (hidden when not showing), so a
 * chat in progress is not lost by looking at the other half.
 */
export const SharedAgentPanel: FC<Props> = ({ active }) => {
  const [mode, setMode] = useState<Mode>("share");
  return (
    <div
      className="modal-body sa-panel"
      role="tabpanel"
      aria-labelledby="ai-cli-tab-shared"
      hidden={!active}
      style={{ display: active ? "flex" : "none" }}
    >
      <div className="sa-top">
        <div className="sa-seg" role="tablist" aria-label="Shared agent mode">
          <button
            type="button"
            role="tab"
            aria-selected={mode === "share"}
            className={mode === "share" ? "active" : ""}
            onClick={() => setMode("share")}
          >
            <Share2 size={13} aria-hidden="true" />
            Share my agent
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={mode === "receive"}
            className={mode === "receive" ? "active" : ""}
            onClick={() => setMode("receive")}
          >
            <MessagesSquare size={13} aria-hidden="true" />
            Use a shared agent
          </button>
        </div>
        <p
          className="sa-trust"
          role="note"
          title="Traffic is plain HTTP. Use only on a network you trust, and never port-forward."
        >
          <ShieldAlert size={12} aria-hidden="true" />
          Plain HTTP · trusted networks only · never port-forward
        </p>
      </div>
      <div className="sa-mode sa-scroll" hidden={mode !== "share"}>
        <SharedAgentShare active={active && mode === "share"} />
      </div>
      <div className="sa-mode" hidden={mode !== "receive"}>
        <SharedAgentReceive active={active && mode === "receive"} />
      </div>
    </div>
  );
};
