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
  Minus,
  Pause,
  Pin,
  PinOff,
  Play,
  Repeat,
  Repeat1,
  Search,
  SkipForward,
  Volume1,
  Volume2,
  VolumeX,
  WifiOff,
  X,
  ExternalLink,
} from "lucide-react";
import { isTypingTarget } from "../../services/shortcuts";
import {
  MusicTrack,
  isYouTubeEmbedOrigin,
  YOUTUBE_LISTENING_HANDSHAKE,
  YouTubeCommand,
  clearLegacyQueue,
  embedSrcForTrack,
  hasNextItem,
  parseYouTubePlayerMessage,
  progressPercent,
  resolveInputToTrack,
  searchYouTubeVideos,
  watchUrlForTrack,
  youtubeCommand,
} from "../../services/musicService";
import { openExternalUrl } from "../../services/updateService";

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
  const [queue, setQueue] = useState<MusicTrack[]>([]);
  const [playing, setPlaying] = useState(false);
  const [muted, setMuted] = useState(startMuted);
  const [isPinned, setIsPinned] = useState<boolean>(() => {
    try {
      return localStorage.getItem("kai_music_pinned") === "true";
    } catch {
      return false;
    }
  });
  const [volume, setVolume] = useState<number>(() => {
    try {
      const v = localStorage.getItem("kai_music_volume");
      if (v !== null) return Math.max(0, Math.min(100, parseInt(v, 10)));
    } catch {}
    return 75;
  });
  const [loop, setLoop] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [online, setOnline] = useState(isOnline);
  const [notice, setNotice] = useState<string | null>(null);
  const frameRef = useRef<HTMLIFrameElement | null>(null);
  const searchRef = useRef<HTMLInputElement | null>(null);
  const lastPercentRef = useRef(0);
  const mutedRef = useRef(muted);
  mutedRef.current = muted;
  const loopRef = useRef(loop);
  loopRef.current = loop;
  const queueRef = useRef(queue);
  queueRef.current = queue;

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
    () => (track && online ? embedSrcForTrack(track, mutedRef.current, loop) : null),
    // Only the track's identity and loop reloads the embed; a title update must not.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [track?.videoId, track?.playlistId, track?.query, online, loop]
  );

  const sendCommand = useCallback((func: YouTubeCommand | string, args: unknown = "") => {
    frameRef.current?.contentWindow?.postMessage(youtubeCommand(func, args), "*");
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
      if (t.currentTime !== undefined) setCurrentTime(t.currentTime);
      if (t.duration !== undefined) setDuration(t.duration);
      if (t.playerState === 1) setPlaying(true);
      else if (t.playerState === 2) setPlaying(false);
      else if (t.playerState === 0) {
        setPlaying(false);
        report(100);
        if (loopRef.current) {
          sendCommand("seekTo", [0, true]);
          sendCommand("playVideo");
          setPlaying(true);
        }
      }
      if (t.title) {
        const title = t.title;
        setTrack((prev) => (prev && prev.title !== title ? { ...prev, title } : prev));
      }
      if (t.currentTime !== undefined && t.duration !== undefined) {
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
  }, [src, onProgressChange, sendCommand]);

  const togglePlay = () => {
    if (!src) return;
    sendCommand(playing ? "pauseVideo" : "playVideo");
    setPlaying((v) => !v);
  };

  const next = async () => {
    if (queueRef.current.length > 0) {
      const [nextItem, ...remaining] = queueRef.current;
      setTrack(nextItem);
      setQueue(remaining);
      setPlaying(true);
      setCurrentTime(0);
      return;
    }
    if (!src) return;
    if (hasNextItem(track)) {
      sendCommand("nextVideo");
      setPlaying(true);
      return;
    }
    // No more queued songs: search for next songs related to the current track
    const searchSeed = track?.query || track?.title;
    if (searchSeed && searchSeed !== "YouTube video") {
      try {
        const results = await searchYouTubeVideos(searchSeed, 6);
        const filtered = results.filter((r) => r.videoId !== track?.videoId);
        if (filtered.length > 0) {
          const [nextItem, ...remaining] = filtered.map((r) => ({
            title: r.title,
            videoId: r.videoId,
            playlistId: null,
            query: r.title,
          }));
          setTrack(nextItem);
          setQueue(remaining);
          setPlaying(true);
          setCurrentTime(0);
          return;
        }
      } catch {
        // ignore
      }
    }
    // Fallback: replay current video from start
    sendCommand("seekTo", [0, true]);
    sendCommand("playVideo");
    setPlaying(true);
  };

  const playQueueIndex = (index: number) => {
    if (index < 0 || index >= queue.length) return;
    const selected = queue[index];
    const remaining = queue.filter((_, i) => i !== index);
    setTrack(selected);
    setQueue(remaining);
    setPlaying(true);
    setCurrentTime(0);
  };

  const toggleLoop = () => {
    setLoop((v) => !v);
  };

  const handleSeek = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (!src || duration <= 0) return;
    const pct = Number(e.target.value);
    const targetSec = (pct / 100) * duration;
    setCurrentTime(targetSec);
    sendCommand("seekTo", [targetSec, true]);
  };

  const handleVolumeChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const val = Math.max(0, Math.min(100, Number(e.target.value)));
    setVolume(val);
    try {
      localStorage.setItem("kai_music_volume", String(val));
    } catch {}
    if (val === 0) {
      setMuted(true);
      onMutedChange?.(true);
      sendCommand("mute");
    } else {
      if (muted) {
        setMuted(false);
        onMutedChange?.(false);
        sendCommand("unMute");
      }
      sendCommand("setVolume", [val]);
    }
  };

  const formatTime = (sec: number): string => {
    if (!Number.isFinite(sec) || sec <= 0) return "0:00";
    const m = Math.floor(sec / 60);
    const s = Math.floor(sec % 60);
    return `${m}:${s < 10 ? "0" : ""}${s}`;
  };

  const toggleMute = () => {
    const nextMuted = !muted;
    setMuted(nextMuted);
    onMutedChange?.(nextMuted);
    sendCommand(nextMuted ? "mute" : "unMute");
    if (!nextMuted && volume > 0) {
      sendCommand("setVolume", [volume]);
    }
  };

  const openInBrowser = () => {
    if (track) void openExternalUrl(watchUrlForTrack(track));
  };

  // Footer + global shortcuts drive the panel via window events so the
  // footer works while the drawer is closed (panel stays mounted).
  const actionsRef = useRef({ togglePlay, next, toggleMute, toggleLoop });
  actionsRef.current = { togglePlay, next, toggleMute, toggleLoop };
  useEffect(() => {
    const onTogglePlay = () => actionsRef.current.togglePlay();
    const onNext = () => actionsRef.current.next();
    const onMute = () => actionsRef.current.toggleMute();
    const onLoop = () => actionsRef.current.toggleLoop();
    window.addEventListener("kai-music-toggle-play", onTogglePlay);
    window.addEventListener("kai-music-next", onNext);
    window.addEventListener("kai-music-mute", onMute);
    window.addEventListener("kai-music-toggle-loop", onLoop);
    return () => {
      window.removeEventListener("kai-music-toggle-play", onTogglePlay);
      window.removeEventListener("kai-music-next", onNext);
      window.removeEventListener("kai-music-mute", onMute);
      window.removeEventListener("kai-music-toggle-loop", onLoop);
    };
  }, []);

  // Panel-scoped keys: Space play / pause, N next, M mute, L loop, Esc closes the
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
      case "l":
      case "L":
        toggleLoop();
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

  const [searching, setSearching] = useState(false);

  const handleFullCloseAndReset = () => {
    sendCommand("pauseVideo");
    setTrack(null);
    setQueue([]);
    setPlaying(false);
    setCurrentTime(0);
    setDuration(0);
    setNotice(null);
    setQuery("");
    onTrackChange?.(null, false);
    onProgressChange?.(0);
    onClose();
  };

  const handleMinimize = () => {
    setIsPinned(false);
    try {
      localStorage.setItem("kai_music_pinned", "false");
    } catch {}
    onClose();
  };

  const togglePin = () => {
    setIsPinned((prev) => {
      const next = !prev;
      try {
        localStorage.setItem("kai_music_pinned", String(next));
      } catch {}
      return next;
    });
  };

  const submit = async () => {
    const raw = query.trim();
    if (!raw) return;
    const resolved = resolveInputToTrack(raw);
    if (!resolved) {
      setNotice("That link isn't playable here. Paste a video, playlist, or plain song name.");
      return;
    }
    setNotice(null);
    if (resolved.videoId || resolved.playlistId) {
      setTrack(resolved);
      setPlaying(true);
      setQuery("");
      // In background, fetch related songs for queue and real title
      void searchYouTubeVideos(resolved.videoId || raw, 6).then((results) => {
        const matchingCurrent = results.find((r) => r.videoId === resolved.videoId);
        if (matchingCurrent && matchingCurrent.title) {
          setTrack((prev) =>
            prev && prev.videoId === resolved.videoId
              ? { ...prev, title: matchingCurrent.title }
              : prev
          );
        }
        const filtered = results.filter((r) => r.videoId !== resolved.videoId);
        if (filtered.length > 0) {
          setQueue(
            filtered.map((r) => ({
              title: r.title,
              videoId: r.videoId,
              playlistId: null,
              query: r.title,
            }))
          );
        }
      });
      return;
    }

    // Plain song names: try resolving to YouTube videos via backend search
    setSearching(true);
    setNotice(`Searching for “${raw}”…`);
    try {
      const results = await searchYouTubeVideos(raw, 8);
      if (results.length > 0) {
        setNotice(null);
        const [first, ...rest] = results;
        setTrack({
          title: first.title,
          videoId: first.videoId,
          playlistId: null,
          query: raw,
        });
        setQueue(
          rest.map((r) => ({
            title: r.title,
            videoId: r.videoId,
            playlistId: null,
            query: r.title,
          }))
        );
        setPlaying(true);
        setQuery("");
        return;
      }
    } catch {
      // ignore
    } finally {
      setSearching(false);
    }

    // Fallback if search could not find a video or in browser/mock environment
    setNotice(null);
    setTrack(resolved);
    setPlaying(false);
    setQuery("");
  };

  return (
    <div
      id="kai-music-modal"
      className={`music-modal-backdrop ${open ? "open" : "closed"} ${isPinned ? "pinned" : ""}`}
      onClick={(e) => {
        if (e.target === e.currentTarget && !isPinned) onClose();
      }}
      role="dialog"
      aria-modal="true"
      aria-label="YouTube Music player"
      aria-hidden={!open}
    >
      <div
        className={`music-modal-dialog music-panel ${isExpanded ? "expanded" : ""}`}
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
          title="Drag border to resize player"
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
              className={`btn btn-icon ${isPinned ? "music-control-active" : ""}`}
              onClick={togglePin}
              title={isPinned ? "Unpin player" : "Pin player (stay open)"}
              aria-label={isPinned ? "Unpin player" : "Pin player"}
              aria-pressed={isPinned}
            >
              {isPinned ? <PinOff size={13} /> : <Pin size={13} />}
            </button>
            <button
              type="button"
              className="btn btn-icon"
              onClick={handleMinimize}
              title="Minimize to status bar"
              aria-label="Minimize player"
            >
              <Minus size={13} />
            </button>
            <button
              type="button"
              className="btn-close"
              onClick={handleFullCloseAndReset}
              title="Close and reset player"
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
          <button
            type="submit"
            className="music-search-go"
            title="Play"
            aria-label="Search"
            disabled={searching}
          >
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
              onLoad={() => {
                frameRef.current?.contentWindow?.postMessage(YOUTUBE_LISTENING_HANDSHAKE, "*");
                sendCommand("setVolume", [volume]);
                if (mutedRef.current) {
                  sendCommand("mute");
                } else {
                  sendCommand("unMute");
                }
              }}
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
              <span className="music-empty-badge" aria-hidden="true">
                ♪
              </span>
              <span className="music-empty-title">Ready to play</span>
              <small className="muted-text">Paste a YouTube link or type a song to search</small>
            </div>
          )}
          <div className="music-track-title-bar">
            <h3 className="music-track-title" title={track?.title ?? "Nothing playing"}>
              {track?.title ?? "Nothing playing"}
            </h3>
          </div>

          <div className="music-progress-wrap">
            <span className="music-time-label">{formatTime(currentTime)}</span>
            <input
              type="range"
              min={0}
              max={100}
              value={duration > 0 ? progressPercent(currentTime, duration) : 0}
              onChange={handleSeek}
              className="music-progress-slider"
              disabled={!src}
              aria-label="Seek track position"
            />
            <span className="music-time-label">{formatTime(duration)}</span>
          </div>

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
              className="btn btn-icon music-ctrl-btn"
              onClick={next}
              disabled={!src && queue.length === 0}
              title={queue.length > 0 ? `Next: ${queue[0].title} (N)` : "Next song / replay (N)"}
              aria-label="Next song"
            >
              <SkipForward size={14} />
            </button>
            <button
              type="button"
              className={`btn btn-icon music-ctrl-btn ${loop ? "music-control-active" : ""}`}
              onClick={toggleLoop}
              title={loop ? "Disable loop (L)" : "Enable loop (L)"}
              aria-label={loop ? "Disable loop" : "Enable loop"}
              aria-pressed={loop}
            >
              {loop ? <Repeat1 size={14} /> : <Repeat size={14} />}
            </button>

            <div className="music-volume-group" title={`Volume: ${muted ? 0 : volume}%`}>
              <button
                type="button"
                className="btn btn-icon music-ctrl-btn"
                onClick={toggleMute}
                title={muted ? "Unmute (M)" : "Mute (M)"}
                aria-label={muted ? "Unmute" : "Mute"}
                aria-pressed={muted}
              >
                {muted || volume === 0 ? (
                  <VolumeX size={14} />
                ) : volume < 50 ? (
                  <Volume1 size={14} />
                ) : (
                  <Volume2 size={14} />
                )}
              </button>
              <input
                type="range"
                min={0}
                max={100}
                value={muted ? 0 : volume}
                onChange={handleVolumeChange}
                className="music-volume-slider"
                aria-label="Volume slider"
              />
            </div>

            <button
              type="button"
              className="btn btn-icon music-ctrl-btn"
              onClick={openInBrowser}
              disabled={!track}
              title="Open in browser"
              aria-label="Open in browser"
            >
              <ExternalLink size={14} />
            </button>
          </div>

          {queue.length > 0 && (
            <div className="music-queue-section">
              <div className="music-queue-header">
                <span className="music-queue-title">Song List ({queue.length})</span>
                <button
                  type="button"
                  className="music-queue-clear"
                  onClick={() => setQueue([])}
                  title="Clear song list"
                >
                  Clear
                </button>
              </div>
              <div className="music-queue-list">
                {queue.map((item, idx) => (
                  <button
                    key={`${item.videoId}-${idx}`}
                    type="button"
                    className="music-queue-item"
                    onClick={() => playQueueIndex(idx)}
                    title={`Play ${item.title}`}
                  >
                    <Play size={10} className="music-queue-play-ico" />
                    <span className="music-queue-name">{item.title}</span>
                  </button>
                ))}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
};
