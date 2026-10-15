import {
  FC,
  KeyboardEvent as ReactKeyboardEvent,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  ExternalLink,
  Maximize2,
  Minimize2,
  Pause,
  Play,
  Search,
  SkipForward,
  Volume2,
  VolumeX,
  WifiOff,
  X,
} from "lucide-react";
import { isTypingTarget } from "../../services/shortcuts";
import { openExternalUrl } from "../../services/updateService";
import {
  CURATED_PRESETS,
  MusicPreset,
  MusicTrack,
  isYouTubeEmbedOrigin,
  getRandomPreset,
  YOUTUBE_LISTENING_HANDSHAKE,
  YouTubeCommand,
  clearLegacyQueue,
  embedSrcForTrack,
  hasNextItem,
  parseYouTubePlayerMessage,
  progressPercent,
  resolveInputToTrack,
  watchUrlForTrack,
  youtubeCommand,
} from "../../services/musicService";

interface MusicPanelProps {
  startMuted: boolean;
  onClose: () => void;
  /** True while the drawer is open — focuses the search box on open. */
  open?: boolean;
  onTrackChange?: (track: MusicTrack | null, playing: boolean) => void;
  onMutedChange?: (muted: boolean) => void;
  /** Whole-number playback percentage (0-100), reported only when it changes. */
  onProgressChange?: (percent: number) => void;
}

function isOnline(): boolean {
  return typeof navigator === "undefined" || navigator.onLine !== false;
}

/**
 * Music Time drawer (272px): one search box, the YouTube video, and four
 * buttons (play/pause, next, mute, open in browser). YouTube owns search,
 * playlists and "next"; nothing is stored locally. The panel stays mounted
 * while enabled so audio survives closing the drawer.
 */
export const MusicPanel: FC<MusicPanelProps> = ({
  startMuted,
  onClose,
  open = true,
  onTrackChange,
  onMutedChange,
  onProgressChange,
}) => {
  const [query, setQuery] = useState("");
  const [track, setTrack] = useState<MusicTrack | null>(null);
  const [playing, setPlaying] = useState(false);
  const [muted, setMuted] = useState(startMuted);
  const [online, setOnline] = useState(isOnline);
  const [notice, setNotice] = useState<string | null>(null);
  const frameRef = useRef<HTMLIFrameElement | null>(null);
  const searchRef = useRef<HTMLInputElement | null>(null);
  const lastPercentRef = useRef(0);
  const mutedRef = useRef(muted);
  mutedRef.current = muted;

  // Focus the search box whenever the drawer opens so the footer toggle
  // feels like opening a real panel (and keyboard users land in context).
  useEffect(() => {
    if (open) {
      // Let the drawer finish displaying before focusing.
      const t = window.setTimeout(() => searchRef.current?.focus({ preventScroll: true }), 60);
      return () => window.clearTimeout(t);
    }
    return undefined;
  }, [open]);

  // Global Escape key dismisses the modal dialog
  useEffect(() => {
    if (!open) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        onClose();
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [open, onClose]);

  // Mute is applied at load through the URL and afterwards through commands,
  // so toggling it never reloads (restarts) the video.
  const src = useMemo(
    () => (track && online ? embedSrcForTrack(track, mutedRef.current) : null),
    // Only the track's identity reloads the embed; a title update must not.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [track?.videoId, track?.playlistId, track?.query, online]
  );

  const sendCommand = useCallback((func: YouTubeCommand) => {
    frameRef.current?.contentWindow?.postMessage(youtubeCommand(func), "*");
  }, []);

  // Older versions saved a queue locally; this version keeps nothing.
  useEffect(() => {
    clearLegacyQueue();
  }, []);

  useEffect(() => {
    const goOnline = () => setOnline(true);
    const goOffline = () => {
      setOnline(false);
      setPlaying(false);
    };
    window.addEventListener("online", goOnline);
    window.addEventListener("offline", goOffline);
    return () => {
      window.removeEventListener("online", goOnline);
      window.removeEventListener("offline", goOffline);
    };
  }, []);

  useEffect(() => {
    onTrackChange?.(track, playing);
  }, [track, playing, onTrackChange]);

  useEffect(() => {
    onMutedChange?.(muted);
  }, [muted, onMutedChange]);

  // Real playback state: the embed (enablejsapi=1) posts currentTime /
  // duration / playerState / title once it receives the "listening"
  // handshake. Only messages from our own iframe window at trusted YouTube origins
  // are accepted.
  useEffect(() => {
    const report = (percent: number) => {
      if (percent === lastPercentRef.current) return;
      lastPercentRef.current = percent;
      onProgressChange?.(percent);
    };
    if (!src) {
      report(0);
      return;
    }
    let received = false;
    let tries = 0;
    const handshake = () => {
      frameRef.current?.contentWindow?.postMessage(YOUTUBE_LISTENING_HANDSHAKE, "*");
    };
    const onMessage = (e: MessageEvent) => {
      if (!isYouTubeEmbedOrigin(e.origin)) return;
      if (!frameRef.current || e.source !== frameRef.current.contentWindow) return;
      const t = parseYouTubePlayerMessage(e.data);
      if (!t) return;
      received = true;
      if (t.playerState === 1) setPlaying(true);
      else if (t.playerState === 2 || t.playerState === 0) setPlaying(false);
      if (t.title) {
        const title = t.title;
        setTrack((prev) => (prev && prev.title !== title ? { ...prev, title } : prev));
      }
      if (t.playerState === 0) {
        report(100);
      } else if (t.currentTime !== undefined && t.duration !== undefined) {
        report(progressPercent(t.currentTime, t.duration));
      }
    };
    window.addEventListener("message", onMessage);
    // The embed may not be listening yet at iframe load; retry briefly.
    const timer = window.setInterval(() => {
      if (received || ++tries > 20) {
        window.clearInterval(timer);
        return;
      }
      handshake();
    }, 500);
    return () => {
      window.removeEventListener("message", onMessage);
      window.clearInterval(timer);
      report(0);
    };
  }, [src, onProgressChange]);

  const togglePlay = () => {
    if (!src) return;
    sendCommand(playing ? "pauseVideo" : "playVideo");
    setPlaying((v) => !v);
  };

  const next = () => {
    if (!src || !hasNextItem(track)) return;
    sendCommand("nextVideo");
    setPlaying(true);
  };

  const toggleMute = () => {
    const nextMuted = !muted;
    setMuted(nextMuted);
    sendCommand(nextMuted ? "mute" : "unMute");
  };

  const openInBrowser = () => {
    if (track) void openExternalUrl(watchUrlForTrack(track));
  };

  // Footer + global shortcuts drive the panel via window events so the
  // footer works while the drawer is closed (panel stays mounted).
  const actionsRef = useRef({ togglePlay, next, toggleMute });
  actionsRef.current = { togglePlay, next, toggleMute };
  useEffect(() => {
    const onTogglePlay = () => actionsRef.current.togglePlay();
    const onNext = () => actionsRef.current.next();
    const onMute = () => actionsRef.current.toggleMute();
    window.addEventListener("kai-music-toggle-play", onTogglePlay);
    window.addEventListener("kai-music-next", onNext);
    window.addEventListener("kai-music-mute", onMute);
    return () => {
      window.removeEventListener("kai-music-toggle-play", onTogglePlay);
      window.removeEventListener("kai-music-next", onNext);
      window.removeEventListener("kai-music-mute", onMute);
    };
  }, []);

  // Panel-scoped keys: Space play / pause, N next, M mute, Esc closes the
  // drawer. Only plain keys, never while typing in the search box, and Space
  // is left to a focused button so it doesn't toggle twice.
  const onPanelKeyDown = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    if (e.ctrlKey || e.metaKey || e.altKey || e.nativeEvent.isComposing) return;
    if (isTypingTarget(e.target)) return;
    switch (e.key) {
      case " ":
        if ((e.target as HTMLElement).closest("button")) return;
        togglePlay();
        break;
      case "n":
      case "N":
        next();
        break;
      case "m":
      case "M":
        toggleMute();
        break;
      case "Escape":
        onClose();
        break;
      default:
        return;
    }
    e.preventDefault();
  };

  const [isExpanded, setIsExpanded] = useState(() => {
    try {
      return localStorage.getItem("kai_music_expanded") === "true";
    } catch {
      return false;
    }
  });

  const [panelWidth, setPanelWidth] = useState<number>(() => {
    try {
      const saved = localStorage.getItem("kai_music_panel_width");
      if (saved) return parseInt(saved, 10);
    } catch {}
    return isExpanded ? 520 : 360;
  });

  const resizingRef = useRef<{ startX: number; startWidth: number } | null>(null);

  const onResizeStart = (e: React.PointerEvent) => {
    e.preventDefault();
    resizingRef.current = { startX: e.clientX, startWidth: panelWidth };
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
  };

  const onResizeMove = (e: React.PointerEvent) => {
    if (!resizingRef.current) return;
    const delta = resizingRef.current.startX - e.clientX;
    const newWidth = Math.max(300, Math.min(720, resizingRef.current.startWidth + delta));
    setPanelWidth(newWidth);
    setIsExpanded(newWidth >= 460);
  };

  const onResizeEnd = (e: React.PointerEvent) => {
    if (!resizingRef.current) return;
    resizingRef.current = null;
    try {
      (e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId);
      localStorage.setItem("kai_music_panel_width", String(panelWidth));
      localStorage.setItem("kai_music_expanded", String(panelWidth >= 460));
    } catch {}
  };

  const toggleExpand = () => {
    setIsExpanded((prev) => {
      const next = !prev;
      const targetWidth = next ? 540 : 360;
      setPanelWidth(targetWidth);
      try {
        localStorage.setItem("kai_music_expanded", String(next));
        localStorage.setItem("kai_music_panel_width", String(targetWidth));
      } catch {}
      return next;
    });
  };

  const submit = () => {
    const raw = query.trim();
    if (!raw) return;
    const resolved = resolveInputToTrack(raw);
    if (!resolved) {
      setNotice("That link isn't playable here. Paste a video, playlist, or plain song name.");
      return;
    }
    setNotice(null);
    // Plain song names have no videoId/playlistId and cannot be embedded
    // (YouTube retired search embeds); they stay a browser-search action
    // instead of guessing a random video.
    if (!resolved.videoId && !resolved.playlistId) {
      setTrack(resolved);
      setPlaying(false);
      setQuery("");
      return;
    }
    setTrack(resolved);
    setPlaying(true);
    setQuery("");
  };

  const playPreset = (preset: MusicPreset) => {
    setNotice(null);
    setTrack({
      title: preset.title,
      videoId: preset.videoId,
      playlistId: null,
      query: preset.videoId,
    });
    setPlaying(true);
    setQuery("");
  };

  const playRandom = () => {
    setNotice(null);
    setTrack(getRandomPreset());
    setPlaying(true);
    setQuery("");
  };

  return (
    <div
      id="kai-music-modal"
      className={`modal-backdrop music-modal-backdrop ${open ? "open" : "closed"}`}
      onClick={onClose}
      role="dialog"
      aria-modal={open}
      aria-label="YouTube Music player"
      aria-hidden={!open}
    >
      <div
        className={`settings-modal music-modal-dialog music-panel ${isExpanded ? "expanded" : ""}`}
        style={{ width: `${panelWidth}px` }}
        onClick={(e) => e.stopPropagation()}
        role="document"
        onKeyDown={onPanelKeyDown}
      >
        <div
          className="music-resize-handle"
          onPointerDown={onResizeStart}
          onPointerMove={onResizeMove}
          onPointerUp={onResizeEnd}
          onPointerCancel={onResizeEnd}
          title="Drag corner to expand or resize player"
          aria-label="Resize music player"
        />
        <div className="modal-header music-head">
          <div className="music-head-title">
            <span className="music-head-badge" aria-hidden="true">
              ♪
            </span>
            <h3>YouTube Music</h3>
          </div>
          <div className="music-head-actions">
            <button
              type="button"
              className="btn btn-icon"
              onClick={toggleExpand}
              title={isExpanded ? "Collapse player" : "Expand player"}
              aria-label={isExpanded ? "Collapse player" : "Expand player"}
            >
              {isExpanded ? <Minimize2 size={13} /> : <Maximize2 size={13} />}
            </button>
            <button
              type="button"
              className="btn-close"
              onClick={onClose}
              title="Close player"
              aria-label="Close YouTube Music"
            >
              <X size={15} />
            </button>
          </div>
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
            ref={searchRef}
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Paste a YouTube link, or type a song to search"
            aria-label="Song name or YouTube link"
          />
          <button type="submit" className="music-search-go" title="Play" aria-label="Search">
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
              ref={frameRef}
              referrerPolicy="strict-origin-when-cross-origin"
              onLoad={() =>
                frameRef.current?.contentWindow?.postMessage(YOUTUBE_LISTENING_HANDSHAKE, "*")
              }
              className="music-video"
              src={src}
              title={track?.title ?? "YouTube player"}
              allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share"
              allowFullScreen
            />
          ) : track && !online ? (
            <div className="music-video-empty music-offline" role="status">
              <WifiOff size={16} aria-hidden="true" />
              <span>No internet connection</span>
              <small>Music comes back when you do.</small>
            </div>
          ) : track && !track.videoId && !track.playlistId && online ? (
            <div className="music-video-empty music-search-only" role="status">
              <span>YouTube search can't play inside Kai — open the results in your browser.</span>
              <button
                type="button"
                className="btn btn-secondary btn-small"
                onClick={openInBrowser}
                title="Open YouTube search in browser"
              >
                <ExternalLink size={13} aria-hidden="true" />
                <span>Search YouTube for “{track.title}”</span>
              </button>
              <small>Paste a video or playlist link to play it here.</small>
            </div>
          ) : (
            <div className="music-video-empty">
              <span className="music-empty-title">Paste a YouTube link or play:</span>
              <div className="music-presets">
                <button
                  type="button"
                  className="music-preset-btn"
                  onClick={playRandom}
                  title="Play a random curated video"
                  aria-label="Play random video"
                >
                  🎲 Play Random Video
                </button>
                <div className="music-preset-chips">
                  {CURATED_PRESETS.map((p) => (
                    <button
                      key={p.id}
                      type="button"
                      className="music-chip"
                      onClick={() => playPreset(p)}
                      title={`Play ${p.title}`}
                    >
                      {p.title.replace(" Radio", "").replace(" Beats", "")}
                    </button>
                  ))}
                </div>
              </div>
            </div>
          )}
          <h3 title={track?.title}>{track?.title ?? "Nothing playing"}</h3>
          <div className="music-controls">
            <button
              type="button"
              className="music-play"
              onClick={togglePlay}
              disabled={!src}
              title="Play / pause (Space)"
              aria-label={playing ? "Pause" : "Play"}
            >
              {playing ? <Pause size={14} /> : <Play size={14} />}
            </button>
            <button
              type="button"
              className="btn btn-icon"
              onClick={next}
              disabled={!src || !hasNextItem(track)}
              title="Next song (N)"
              aria-label="Next song"
            >
              <SkipForward size={14} />
            </button>
            <button
              type="button"
              className="btn btn-icon"
              onClick={toggleMute}
              title="Mute (M)"
              aria-label={muted ? "Unmute" : "Mute"}
              aria-pressed={muted}
            >
              {muted ? <VolumeX size={14} /> : <Volume2 size={14} />}
            </button>
            <button
              type="button"
              className="btn btn-icon"
              onClick={openInBrowser}
              disabled={!track}
              title="Open in browser"
              aria-label="Open in browser"
            >
              <ExternalLink size={14} />
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};
