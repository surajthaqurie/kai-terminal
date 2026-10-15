import { FC, useEffect, useMemo, useState } from "react";
import {
  Search,
  Shuffle,
  SkipBack,
  SkipForward,
  Repeat,
  Volume2,
  VolumeX,
  List,
  X,
} from "lucide-react";
import {
  MusicTrack,
  embedSrcForTrack,
  loadQueue,
  resolveInputToTrack,
  saveQueue,
} from "../../services/musicService";

interface MusicPanelProps {
  startMuted: boolean;
  onClose: () => void;
  onTrackChange?: (track: MusicTrack | null, playing: boolean) => void;
  onMutedChange?: (muted: boolean) => void;
}

/**
 * Compact YouTube drawer (272px): icon-only smart search, always-video
 * embed, full controls in panel. Queue is a slide-over covering the
 * player, hidden by default, opened via the queue button only.
 */
export const MusicPanel: FC<MusicPanelProps> = ({
  startMuted,
  onClose,
  onTrackChange,
  onMutedChange,
}) => {
  const [query, setQuery] = useState("");
  const [queue, setQueue] = useState<MusicTrack[]>(() => loadQueue());
  const [activeId, setActiveId] = useState<string | null>(() => loadQueue()[0]?.id ?? null);
  const [playing, setPlaying] = useState(false);
  const [muted, setMuted] = useState(startMuted);
  const [loop, setLoop] = useState(false);
  const [shuffle, setShuffle] = useState(false);
  const [queueOpen, setQueueOpen] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  const active = useMemo(() => queue.find((t) => t.id === activeId) ?? null, [queue, activeId]);
  const src = useMemo(() => {
    if (!active || !playing) return null;
    const base = embedSrcForTrack(active);
    return `${base}${loop ? "&loop=1" : ""}${muted ? "&mute=1" : ""}`;
  }, [active, playing, loop, muted]);

  useEffect(() => {
    saveQueue(queue);
  }, [queue]);

  useEffect(() => {
    onTrackChange?.(active, playing);
  }, [active, playing, onTrackChange]);

  useEffect(() => {
    onMutedChange?.(muted);
  }, [muted, onMutedChange]);

  // Footer + global shortcuts drive the panel via window events so the
  // footer works while the drawer is closed (panel stays mounted).
  useEffect(() => {
    const onTogglePlay = () => {
      if (activeId) setPlaying((v) => !v);
    };
    const onNext = () => {
      setQueue((prev) => {
        if (prev.length === 0) return prev;
        const idx = prev.findIndex((t) => t.id === activeId);
        const at = idx < 0 ? 0 : (idx + 1) % prev.length;
        const next = prev[at];
        if (next) {
          setActiveId(next.id);
          setPlaying(true);
        }
        return prev;
      });
    };
    const onMute = () => setMuted((v) => !v);
    window.addEventListener("kai-music-toggle-play", onTogglePlay);
    window.addEventListener("kai-music-next", onNext);
    window.addEventListener("kai-music-mute", onMute);
    return () => {
      window.removeEventListener("kai-music-toggle-play", onTogglePlay);
      window.removeEventListener("kai-music-next", onNext);
      window.removeEventListener("kai-music-mute", onMute);
    };
  }, [activeId]);

  const submit = () => {
    const track = resolveInputToTrack(query);
    if (!track) {
      setNotice("Paste a YouTube link or type a song name.");
      return;
    }
    setNotice(null);
    setQueue((prev) => [track, ...prev].slice(0, 50));
    setActiveId(track.id);
    setPlaying(true);
    setQuery("");
  };

  const step = (dir: 1 | -1) => {
    if (queue.length === 0) return;
    const idx = queue.findIndex((t) => t.id === activeId);
    let next: MusicTrack | undefined;
    if (shuffle) {
      next = queue[Math.floor(Math.random() * queue.length)];
    } else {
      const at = idx < 0 ? 0 : (idx + dir + queue.length) % queue.length;
      next = queue[at];
    }
    if (next) {
      setActiveId(next.id);
      setPlaying(true);
    }
  };

  return (
    <div className="music-panel" role="complementary" aria-label="YouTube music player">
      <div className="music-head">
        <div>
          <b>YouTube</b>
          <span>smart search • video</span>
        </div>
        <button className="btn btn-icon" onClick={onClose} aria-label="Close music player">
          <X size={14} />
        </button>
      </div>

      <form
        className="music-search"
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
      >
        <Search size={14} aria-hidden="true" />
        <input
          type="text"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search or paste YouTube URL…"
          aria-label="Search songs or paste YouTube URL"
        />
        <button type="submit" className="music-search-go" title="Search / load" aria-label="Search">
          <Search size={13} />
        </button>
      </form>
      {notice && (
        <div className="music-notice" role="status">
          {notice}
        </div>
      )}

      <div className="music-now">
        {src ? (
          <iframe
            key={src}
            className="music-video"
            src={src}
            title={active?.title ?? "YouTube player"}
            allow="autoplay; encrypted-media; picture-in-picture"
            allowFullScreen
          />
        ) : (
          <div className="music-video-empty">Search above to play video</div>
        )}
        <h3>{active?.title ?? "Nothing queued"}</h3>
        <div className="music-controls">
          <button
            type="button"
            className={`btn btn-icon${shuffle ? " is-on" : ""}`}
            onClick={() => setShuffle((v) => !v)}
            title="Shuffle (panel only)"
            aria-label="Toggle shuffle"
            aria-pressed={shuffle}
          >
            <Shuffle size={14} />
          </button>
          <button
            type="button"
            className="btn btn-icon"
            onClick={() => step(-1)}
            title="Previous (P)"
            aria-label="Previous track"
          >
            <SkipBack size={14} />
          </button>
          <button
            type="button"
            className="music-play"
            onClick={() => active && setPlaying((v) => !v)}
            title="Play / pause (Space)"
            aria-label={playing ? "Pause" : "Play"}
          >
            {playing ? "⏸" : "▶"}
          </button>
          <button
            type="button"
            className="btn btn-icon"
            onClick={() => step(1)}
            title="Next song (N)"
            aria-label="Next track"
          >
            <SkipForward size={14} />
          </button>
          <button
            type="button"
            className={`btn btn-icon${loop ? " is-on" : ""}`}
            onClick={() => setLoop((v) => !v)}
            title="Loop (L)"
            aria-label="Toggle loop"
            aria-pressed={loop}
          >
            <Repeat size={14} />
          </button>
        </div>
        <div className="music-volrow">
          <button
            type="button"
            className="btn btn-icon"
            onClick={() => setMuted((v) => !v)}
            title="Mute (M)"
            aria-label={muted ? "Unmute" : "Mute"}
            aria-pressed={muted}
          >
            {muted ? <VolumeX size={14} /> : <Volume2 size={14} />}
          </button>
          <span className="music-muted-label">{muted ? "Muted" : "Sound on"}</span>
          <button
            type="button"
            className="btn btn-icon"
            onClick={() => setQueueOpen(true)}
            title="Queue (Q)"
            aria-label="Open queue"
          >
            <List size={14} />
          </button>
        </div>
      </div>

      {queueOpen && (
        <div className="music-queue-slide" role="dialog" aria-label="Music queue">
          <div className="music-queue-head">
            <span>Queue ({queue.length})</span>
            <button
              type="button"
              className="btn btn-icon"
              onClick={() => setQueueOpen(false)}
              aria-label="Close queue"
            >
              <X size={14} />
            </button>
          </div>
          <div className="music-queue-list">
            {queue.length === 0 && <div className="music-queue-empty">Queue is empty.</div>}
            {queue.map((t) => (
              <button
                key={t.id}
                type="button"
                className={`music-queue-item${t.id === activeId ? " active" : ""}`}
                onClick={() => {
                  setActiveId(t.id);
                  setPlaying(true);
                  setQueueOpen(false);
                }}
                title={t.query}
              >
                <span className="music-queue-dot">{t.id === activeId ? "▶" : "♪"}</span>
                <span className="music-queue-title">{t.title}</span>
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
};
