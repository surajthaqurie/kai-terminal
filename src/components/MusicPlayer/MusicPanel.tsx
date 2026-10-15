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
  MusicTrack,
  YOUTUBE_EMBED_ORIGIN,
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
  const lastPercentRef = useRef(0);
  const mutedRef = useRef(muted);
  mutedRef.current = muted;

  // Mute is applied at load through the URL and afterwards through commands,
  // so toggling it never reloads (restarts) the video.
  const src = useMemo(
    () => (track && online ? embedSrcForTrack(track, mutedRef.current) : null),
    // Only the track's identity reloads the embed; a title update must not.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [track?.videoId, track?.playlistId, track?.query, online]
  );

  const sendCommand = useCallback((func: YouTubeCommand) => {
    frameRef.current?.contentWindow?.postMessage(youtubeCommand(func), YOUTUBE_EMBED_ORIGIN);
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
  // handshake. Only messages from our own iframe window at the YouTube origin
  // are trusted.
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
      frameRef.current?.contentWindow?.postMessage(
        YOUTUBE_LISTENING_HANDSHAKE,
        YOUTUBE_EMBED_ORIGIN
      );
    };
    const onMessage = (e: MessageEvent) => {
      if (e.origin !== YOUTUBE_EMBED_ORIGIN) return;
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

  const submit = () => {
    const resolved = resolveInputToTrack(query);
    if (!resolved) {
      setNotice("Type a song name or paste a YouTube link.");
      return;
    }
    setNotice(null);
    setTrack(resolved);
    setPlaying(true);
    setQuery("");
  };

  return (
    <div
      className="music-panel"
      role="complementary"
      aria-label="Music Time player"
      onKeyDown={onPanelKeyDown}
    >
      <div className="music-head">
        <b>Music Time</b>
        <button className="btn btn-icon" onClick={onClose} aria-label="Close Music Time">
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
          placeholder="Song name or YouTube link"
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
            onLoad={() =>
              frameRef.current?.contentWindow?.postMessage(
                YOUTUBE_LISTENING_HANDSHAKE,
                YOUTUBE_EMBED_ORIGIN
              )
            }
            className="music-video"
            src={src}
            title={track?.title ?? "YouTube player"}
            allow="autoplay; encrypted-media; picture-in-picture"
            allowFullScreen
          />
        ) : track && !online ? (
          <div className="music-video-empty music-offline" role="status">
            <WifiOff size={16} aria-hidden="true" />
            <span>No internet connection</span>
            <small>Music comes back when you do.</small>
          </div>
        ) : (
          <div className="music-video-empty">Search a song to start</div>
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
  );
};
