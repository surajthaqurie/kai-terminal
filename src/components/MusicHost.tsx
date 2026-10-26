import { Suspense, type ComponentProps } from "react";
import { Music } from "lucide-react";
import { MusicPanel } from "./lazyPanels";

type MusicPanelProps = ComponentProps<typeof MusicPanel>;

interface MusicHostProps extends MusicPanelProps {
  /** Keep the (lazy) player mounted so playback survives panel close. */
  mounted: boolean;
}

/** Mounts the lazy YouTube Music panel with a matching loading shell. */
export function MusicHost({ mounted, ...panelProps }: MusicHostProps) {
  if (!mounted) return null;
  return (
    <Suspense
      fallback={
        panelProps.open ? (
          <div
            className="music-modal-backdrop open"
            role="dialog"
            aria-label="Loading music player"
          >
            <div className="music-modal-dialog music-panel" role="document">
              <div className="modal-header music-head">
                <div className="music-head-title">
                  <span className="music-head-badge" aria-hidden="true">
                    <Music size={14} aria-hidden="true" />
                  </span>
                  <h3>YouTube Music</h3>
                </div>
              </div>
              <div className="music-video-empty">Loading player…</div>
            </div>
          </div>
        ) : null
      }
    >
      <MusicPanel {...panelProps} />
    </Suspense>
  );
}
