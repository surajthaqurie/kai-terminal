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
  ChevronLeft,
  Contrast,
  ListMusic,
  Maximize2,
  Minimize2,
  Minus,
  Music,
  Pause,
  Pin,
  PinOff,
  Play,
  Repeat,
  Repeat1,
  Search,
  SkipBack,
  SkipForward,
  Volume1,
  Volume2,
  VolumeX,
  WifiOff,
  X,
} from "lucide-react";
import { useCallPause } from "../../hooks/useCallPause";
import { isTypingTarget } from "../../services/shortcuts";
import {
  MusicTrack,
  isYouTubeEmbedOrigin,
  YOUTUBE_LISTENING_HANDSHAKE,
  YouTubeCommand,
  clearLegacyQueue,
  embedSrcForTrack,
  fetchPlaylistVideos,
  hasNextItem,
  parseYouTubePlayerMessage,
  progressPercent,
  resolveInputToTrack,
  searchYouTubeVideos,
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

/** Songs shown per page in the playlist drawer before "Load more". */
const PLAYLIST_PAGE_SIZE = 12;

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
  const [searchResults, setSearchResults] = useState<MusicTrack[]>([]);
  const [queue, setQueue] = useState<MusicTrack[]>([]);
  // Fetched YouTube playlist songs (drawer in playlist mode), paginated in
  // windows of PLAYLIST_PAGE_SIZE via the "Load more" control.
  const [playlistItems, setPlaylistItems] = useState<MusicTrack[]>([]);
  const [playlistLoading, setPlaylistLoading] = useState(false);
  const [playlistVisible, setPlaylistVisible] = useState(PLAYLIST_PAGE_SIZE);
  const [suggestLoading, setSuggestLoading] = useState(false);
  const [showNextList, setShowNextList] = useState<boolean>(false);
  const [drawerOpen, setDrawerOpen] = useState<boolean>(false);
  const [drawerMode, setDrawerMode] = useState<"queue" | "search">("queue");
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
  // Previous-button history: every track switch snapshots the song that was
  // playing, so Previous walks back through it. A ref (no re-render needed —
  // the button stays enabled whenever something is playing).
  const historyRef = useRef<MusicTrack[]>([]);
  const trackRef = useRef(track);
  trackRef.current = track;
  // Auto-advance rate guard: an "ended" state can arrive twice (state event +
  // envelope); ignore repeats within 1.5 s so the queue never skips two songs.
  const lastAutoNextRef = useRef(0);

  /** Snapshot the currently playing song onto the Previous-history stack.
   *  Called at switch time — before `setTrack` changes the current track. */
  const pushHistory = useCallback(() => {
    const cur = trackRef.current;
    if (!cur || (!cur.videoId && !cur.playlistId) || cur.playlistId) return;
    const last = historyRef.current[historyRef.current.length - 1];
    if (last && last.videoId === cur.videoId) return;
    // Bounded stack: keep the 50 most recent songs.
    historyRef.current = [...historyRef.current.slice(-49), cur];
  }, []);

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

  // Global Escape key dismisses the modal dialog when NOT pinned.
  // When pinned, the player stays pinned open while other modals/dialogs (Settings, Git, etc.)
  // can consume Escape to close themselves without dismissing the music player.
  useEffect(() => {
    if (!open || isPinned) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        onClose();
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [open, isPinned, onClose]);

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
        } else if (trackRef.current && !trackRef.current.playlistId) {
          // Song finished: auto-advance exactly like the Next button (queue ->
          // related-song search). Native playlist embeds advance themselves,
          // so they must not additionally consume our queue here.
          const now = Date.now();
          if (now - lastAutoNextRef.current > 1500) {
            lastAutoNextRef.current = now;
            void actionsRef.current.next();
          }
        }
      }
      if (t.title) {
        const title = t.title;
        setTrack((prev) => (prev && prev.title !== title ? { ...prev, title } : prev));
        // Keep the Previous-button history snapshots in sync with the real
        // title so a Previous replay doesn't display "YouTube video".
        if (historyRef.current.length > 0) {
          historyRef.current = historyRef.current.map((h) =>
            h.videoId && h.videoId === trackRef.current?.videoId && h.title !== title
              ? { ...h, title }
              : h
          );
        }
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

  useCallPause({
    playing,
    pause: () => {
      sendCommand("pauseVideo");
      setPlaying(false);
    },
    resume: () => {
      sendCommand("playVideo");
      setPlaying(true);
    },
  });

  const togglePlay = () => {
    if (!src) return;
    sendCommand(playing ? "pauseVideo" : "playVideo");
    setPlaying((v) => !v);
  };

  const next = async () => {
    // Native playlist embeds own the Next action: let YouTube advance within
    // the list instead of consuming the suggestion queue.
    if (track?.playlistId) {
      sendCommand("nextVideo");
      setPlaying(true);
      return;
    }
    if (queueRef.current.length > 0) {
      pushHistory();
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
          pushHistory();
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

  /** Previous button: pops the last played song off the history stack. With
   *  an empty history it restarts the current song (standard player
   *  behavior). Native playlist embeds own their own position, so Previous
   *  simply restarts the current list video. */
  const previous = () => {
    if (trackRef.current?.playlistId) {
      replayCurrent();
      return;
    }
    const prevTrack = historyRef.current.pop();
    if (prevTrack) {
      setTrack(prevTrack);
      setPlaying(true);
      setCurrentTime(0);
      setDuration(0);
      return;
    }
    replayCurrent();
  };

  // Playlist drawer browsing is session-scoped: items stay visible while the
  // drawer is open (even if a song from the list takes over playback as a
  // standalone video), and reset when the drawer closes via closeDrawer.
  const playlistIdRef = useRef<string | null>(null);
  const playlistItemsRef = useRef<MusicTrack[]>(playlistItems);

  const loadPlaylistItems = async (playlistId: string, force = false) => {
    if (!force && playlistIdRef.current === playlistId && playlistItemsRef.current.length > 0) {
      return;
    }
    setPlaylistLoading(true);
    try {
      const results = await fetchPlaylistVideos(playlistId, 200);
      const items: MusicTrack[] = results.map((r) => ({
        title: r.title,
        videoId: r.videoId,
        playlistId: null,
        query: r.title,
        thumbnail: r.videoId
          ? `https://i.ytimg.com/vi/${encodeURIComponent(r.videoId)}/mqdefault.jpg`
          : null,
      }));
      playlistIdRef.current = playlistId;
      playlistItemsRef.current = items;
      setPlaylistItems(items);
      setPlaylistVisible(PLAYLIST_PAGE_SIZE);
    } catch {
      playlistIdRef.current = playlistId;
      playlistItemsRef.current = [];
      setPlaylistItems([]);
    } finally {
      setPlaylistLoading(false);
    }
  };

  // Closing the drawer always returns it to a clean queue-session state.
  const closeDrawer = () => {
    setDrawerOpen(false);
    setShowNextList(false);
    setDrawerMode("queue");
    setPlaylistItems([]);
    setPlaylistVisible(PLAYLIST_PAGE_SIZE);
    playlistIdRef.current = null;
    playlistItemsRef.current = [];
  };

  /** Plays a fetched playlist item as a standalone video (predictable, and
   * it cannot restart the whole playlist like `listType=playlist` would). */
  const playPlaylistItem = (item: MusicTrack) => {
    if (item.videoId && item.videoId === track?.videoId) {
      replayCurrent();
      return;
    }
    pushHistory();
    setTrack(item);
    setPlaying(true);
    setCurrentTime(0);
    setNotice(null);
  };

  /** Pagination for the suggestions queue: fetches a wider related-videos
   * page for the current song and appends only the not-yet-queued ones. */
  const loadMoreSuggestions = async () => {
    if (suggestLoading) return;
    const seed = track?.query || track?.title;
    if (!seed || seed === "YouTube video") return;
    setSuggestLoading(true);
    try {
      const results = await searchYouTubeVideos(seed, 20);
      const known = new Set<string>([track?.videoId ?? ""]);
      for (const item of queueRef.current) {
        if (item.videoId) known.add(item.videoId);
      }
      const fresh = results
        .filter((r) => !known.has(r.videoId))
        .map((r) => ({
          title: r.title,
          videoId: r.videoId,
          playlistId: null,
          query: r.title,
          thumbnail: r.videoId
            ? `https://i.ytimg.com/vi/${encodeURIComponent(r.videoId)}/mqdefault.jpg`
            : null,
        }));
      if (fresh.length > 0) {
        setQueue((prev) => [...prev, ...fresh]);
      } else {
        setNotice("No more suggestions available for this song.");
      }
    } catch {
      setNotice("Could not load more suggestions.");
    } finally {
      setSuggestLoading(false);
    }
  };

  const replayCurrent = () => {
    if (!src) return;
    sendCommand("seekTo", [0, true]);
    sendCommand("playVideo");
    setPlaying(true);
    setCurrentTime(0);
  };

  const playQueueIndex = (index: number) => {
    if (index < 0 || index >= queue.length) return;
    const selected = queue[index];
    // The currently playing song lives in the list too: clicking it simply
    // restarts playback instead of lifting it out of the queue.
    if (selected.videoId && selected.videoId === track?.videoId) {
      replayCurrent();
      return;
    }
    const remaining = queue.filter((_, i) => i !== index);
    pushHistory();
    setTrack(selected);
    setQueue(remaining);
    setPlaying(true);
    setCurrentTime(0);
    closeDrawer();
  };

  const toggleLoop = () => {
    setLoop((v) => !v);
  };

  const toggleNextList = async () => {
    if (!drawerOpen || drawerMode !== "queue") {
      setDrawerMode("queue");
      setDrawerOpen(true);
      setShowNextList(true);
      if (track?.playlistId) {
        // Real playlist: show its actual ordered song list (paginated).
        void loadPlaylistItems(track.playlistId);
      } else if (queue.length === 0 && track) {
        // Non-playlist: seed the suggestions queue from the song context.
        const seed = track.query || track.title;
        if (seed && seed !== "YouTube video") {
          try {
            const results = await searchYouTubeVideos(seed, 8);
            const filtered = results.filter((r) => r.videoId !== track.videoId);
            if (filtered.length > 0) {
              setQueue(
                filtered.map((r) => ({
                  title: r.title,
                  videoId: r.videoId,
                  playlistId: null,
                  query: r.title,
                  thumbnail: r.videoId
                    ? `https://i.ytimg.com/vi/${encodeURIComponent(r.videoId)}/mqdefault.jpg`
                    : null,
                }))
              );
            }
          } catch {
            // ignore
          }
        }
      }
    } else {
      closeDrawer();
    }
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

  // Footer + global shortcuts drive the panel via window events so the
  // footer works while the drawer is closed (panel stays mounted).
  const actionsRef = useRef({ togglePlay, next, previous, toggleMute, toggleLoop });
  actionsRef.current = { togglePlay, next, previous, toggleMute, toggleLoop };
  useEffect(() => {
    const onTogglePlay = () => actionsRef.current.togglePlay();
    const onNext = () => actionsRef.current.next();
    const onPrevious = () => actionsRef.current.previous();
    const onMute = () => actionsRef.current.toggleMute();
    const onLoop = () => actionsRef.current.toggleLoop();
    window.addEventListener("kai-music-toggle-play", onTogglePlay);
    window.addEventListener("kai-music-next", onNext);
    window.addEventListener("kai-music-previous", onPrevious);
    window.addEventListener("kai-music-mute", onMute);
    window.addEventListener("kai-music-toggle-loop", onLoop);
    return () => {
      window.removeEventListener("kai-music-toggle-play", onTogglePlay);
      window.removeEventListener("kai-music-next", onNext);
      window.removeEventListener("kai-music-previous", onPrevious);
      window.removeEventListener("kai-music-mute", onMute);
      window.removeEventListener("kai-music-toggle-loop", onLoop);
    };
  }, []);

  // Panel-scoped keys: Space play / pause, N next, P previous, M mute, L loop,
  // Esc closes the drawer. Only plain keys, never while typing in the search
  // box, and Space is left to a focused button so it doesn't toggle twice.
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
      case "p":
      case "P":
        previous();
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
        if (drawerOpen) {
          setDrawerOpen(false);
          setShowNextList(false);
        } else {
          onClose();
        }
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

  const DEFAULT_PANEL_WIDTH = 360;
  const DEFAULT_PANEL_HEIGHT = 540;
  const MIN_PANEL_WIDTH = 300;
  const MIN_PANEL_HEIGHT = 320;

  const [dimPercent, setDimPercent] = useState<number>(() => {
    try {
      const saved = localStorage.getItem("kai_music_dim_percent");
      if (saved) {
        const parsed = parseInt(saved, 10);
        if (Number.isFinite(parsed) && parsed >= 15 && parsed <= 100) return parsed;
      }
    } catch {}
    return 40;
  });

  const [isDimmed, setIsDimmed] = useState<boolean>(() => {
    try {
      return localStorage.getItem("kai_music_dimmed") === "true";
    } catch {
      return false;
    }
  });

  const [showDimPopover, setShowDimPopover] = useState(false);
  const dimPopoverRef = useRef<HTMLDivElement | null>(null);

  const enableDim = (percent?: number) => {
    if (typeof percent === "number") {
      const clamped = Math.max(15, Math.min(100, percent));
      setDimPercent(clamped);
      try {
        localStorage.setItem("kai_music_dim_percent", String(clamped));
      } catch {}
    }
    setIsDimmed(true);
    try {
      localStorage.setItem("kai_music_dimmed", "true");
    } catch {}
  };

  const disableDim = () => {
    setIsDimmed(false);
    try {
      localStorage.setItem("kai_music_dimmed", "false");
    } catch {}
  };

  const handleDimPercentChange = (val: number) => {
    enableDim(val);
  };

  useEffect(() => {
    if (!showDimPopover) return;
    const handleOutsideClick = (e: MouseEvent) => {
      if (dimPopoverRef.current && !dimPopoverRef.current.contains(e.target as Node)) {
        setShowDimPopover(false);
      }
    };
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setShowDimPopover(false);
      }
    };
    window.addEventListener("mousedown", handleOutsideClick);
    window.addEventListener("keydown", handleKeyDown);
    return () => {
      window.removeEventListener("mousedown", handleOutsideClick);
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [showDimPopover]);

  const drawerRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!drawerOpen) return;
    const handleOutsideClick = (e: MouseEvent) => {
      if ((e.target as HTMLElement).closest("button[aria-label='Next playing list']")) {
        return;
      }
      if (drawerRef.current && !drawerRef.current.contains(e.target as Node)) {
        closeDrawer();
      }
    };
    window.addEventListener("mousedown", handleOutsideClick);
    return () => {
      window.removeEventListener("mousedown", handleOutsideClick);
    };
  }, [drawerOpen]);

  const [panelWidth, setPanelWidth] = useState<number>(() => {
    try {
      const saved = localStorage.getItem("kai_music_panel_width");
      if (saved) {
        const parsed = parseInt(saved, 10);
        if (Number.isFinite(parsed) && parsed >= MIN_PANEL_WIDTH) return parsed;
      }
    } catch {}
    return isExpanded ? 520 : DEFAULT_PANEL_WIDTH;
  });

  const [panelHeight, setPanelHeight] = useState<number>(() => {
    try {
      const saved = localStorage.getItem("kai_music_panel_height");
      if (saved) {
        const parsed = parseInt(saved, 10);
        if (Number.isFinite(parsed) && parsed >= MIN_PANEL_HEIGHT) return parsed;
      }
    } catch {}
    return DEFAULT_PANEL_HEIGHT;
  });

  const EXPANDED_PANEL_WIDTH = 520;
  const EXPANDED_PANEL_HEIGHT = 680;

  const handleToggleExpand = () => {
    if (isExpanded || panelWidth >= 460) {
      setPanelWidth(DEFAULT_PANEL_WIDTH);
      setPanelHeight(DEFAULT_PANEL_HEIGHT);
      setIsExpanded(false);
      panelDimensionsRef.current = { width: DEFAULT_PANEL_WIDTH, height: DEFAULT_PANEL_HEIGHT };
      try {
        localStorage.setItem("kai_music_panel_width", String(DEFAULT_PANEL_WIDTH));
        localStorage.setItem("kai_music_panel_height", String(DEFAULT_PANEL_HEIGHT));
        localStorage.setItem("kai_music_expanded", "false");
      } catch {}
    } else {
      setPanelWidth(EXPANDED_PANEL_WIDTH);
      setPanelHeight(EXPANDED_PANEL_HEIGHT);
      setIsExpanded(true);
      panelDimensionsRef.current = { width: EXPANDED_PANEL_WIDTH, height: EXPANDED_PANEL_HEIGHT };
      try {
        localStorage.setItem("kai_music_panel_width", String(EXPANDED_PANEL_WIDTH));
        localStorage.setItem("kai_music_panel_height", String(EXPANDED_PANEL_HEIGHT));
        localStorage.setItem("kai_music_expanded", "true");
      } catch {}
    }
  };

  const [activeResizeEdge, setActiveResizeEdge] = useState<"left" | "top" | "corner" | null>(null);

  const panelDimensionsRef = useRef({ width: panelWidth, height: panelHeight });
  panelDimensionsRef.current = { width: panelWidth, height: panelHeight };

  const resizingRef = useRef<{
    edge: "left" | "top" | "corner";
    startX: number;
    startY: number;
    startWidth: number;
    startHeight: number;
  } | null>(null);

  const onResizeStart = (edge: "left" | "top" | "corner") => (e: React.PointerEvent) => {
    e.preventDefault();
    e.stopPropagation();
    const startX = e.clientX;
    const startY = e.clientY;
    const startWidth = panelDimensionsRef.current.width;
    const startHeight = panelDimensionsRef.current.height;
    const targetEl = e.currentTarget as HTMLElement | null;
    resizingRef.current = { edge, startX, startY, startWidth, startHeight };
    setActiveResizeEdge(edge);

    if (targetEl && typeof targetEl.setPointerCapture === "function") {
      try {
        targetEl.setPointerCapture(e.pointerId);
      } catch {}
    }

    const handleMove = (ev: PointerEvent) => {
      const current = resizingRef.current;
      if (!current) return;
      ev.preventDefault();

      if (current.edge === "left" || current.edge === "corner") {
        const deltaX = current.startX - ev.clientX;
        const maxW = Math.min(840, typeof window !== "undefined" ? window.innerWidth - 20 : 800);
        const newWidth = Math.max(MIN_PANEL_WIDTH, Math.min(maxW, current.startWidth + deltaX));
        setPanelWidth(newWidth);
        setIsExpanded(newWidth >= 460);
        panelDimensionsRef.current.width = newWidth;
      }

      if (current.edge === "top" || current.edge === "corner") {
        const deltaY = current.startY - ev.clientY;
        const maxH = Math.min(960, typeof window !== "undefined" ? window.innerHeight - 46 : 800);
        const newHeight = Math.max(MIN_PANEL_HEIGHT, Math.min(maxH, current.startHeight + deltaY));
        setPanelHeight(newHeight);
        panelDimensionsRef.current.height = newHeight;
      }
    };

    const handleUp = (ev: PointerEvent) => {
      resizingRef.current = null;
      setActiveResizeEdge(null);
      if (targetEl && typeof targetEl.releasePointerCapture === "function") {
        try {
          targetEl.releasePointerCapture(ev.pointerId);
        } catch {}
      }
      window.removeEventListener("pointermove", handleMove);
      window.removeEventListener("pointerup", handleUp);
      window.removeEventListener("pointercancel", handleUp);
      try {
        localStorage.setItem("kai_music_panel_width", String(panelDimensionsRef.current.width));
        localStorage.setItem("kai_music_panel_height", String(panelDimensionsRef.current.height));
        localStorage.setItem("kai_music_expanded", String(panelDimensionsRef.current.width >= 460));
      } catch {}
    };

    window.addEventListener("pointermove", handleMove);
    window.addEventListener("pointerup", handleUp);
    window.addEventListener("pointercancel", handleUp);
  };

  const [searching, setSearching] = useState(false);

  const handleFullCloseAndReset = () => {
    sendCommand("pauseVideo");
    setTrack(null);
    setQueue([]);
    setSearchResults([]);
    setDrawerOpen(false);
    setShowNextList(false);
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

    // Direct YouTube link or playlist
    if (resolved.videoId || resolved.playlistId) {
      pushHistory();
      setTrack(resolved);
      setPlaying(true);
      setSearchResults([]);
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
              thumbnail: r.videoId
                ? `https://i.ytimg.com/vi/${encodeURIComponent(r.videoId)}/mqdefault.jpg`
                : null,
            }))
          );
        }
      });
      return;
    }

    // Plain song name: do NOT auto-play. Fetch search results and list them so user can select
    setSearching(true);
    setNotice(`Searching for “${raw}”…`);
    try {
      const results = await searchYouTubeVideos(raw, 10);
      if (results.length > 0) {
        setNotice(null);
        const items: MusicTrack[] = results.map((r) => ({
          title: r.title,
          videoId: r.videoId,
          playlistId: null,
          query: r.title,
          thumbnail: r.videoId
            ? `https://i.ytimg.com/vi/${encodeURIComponent(r.videoId)}/mqdefault.jpg`
            : null,
        }));
        setSearchResults(items);
        setDrawerMode("search");
        setDrawerOpen(true);
        setShowNextList(false);
        setNotice(`Found ${results.length} results for “${raw}”. Click a song to play:`);
        setQuery("");
        return;
      } else {
        setSearchResults([]);
        setNotice(`No songs found for “${raw}”.`);
      }
    } catch {
      setSearchResults([]);
      setNotice(`Could not complete search for “${raw}”.`);
    } finally {
      setSearching(false);
    }
  };

  const playSearchResult = (item: MusicTrack, index: number) => {
    // Clicking the song that is already playing simply restarts it.
    if (item.videoId && item.videoId === track?.videoId) {
      replayCurrent();
      return;
    }
    pushHistory();
    setTrack(item);
    setPlaying(true);
    setCurrentTime(0);
    setDuration(0);
    setNotice(null);
    // Remaining search results become the queue for next song playback
    const remaining = searchResults.filter((_, i) => i !== index);
    setQueue(remaining);
    // Clear search results now that the user selected and played a song
    setSearchResults([]);
    setDrawerMode("queue");
    setDrawerOpen(false);
    setShowNextList(false);
    setPlaylistItems([]);
    setPlaylistVisible(PLAYLIST_PAGE_SIZE);
    playlistIdRef.current = null;
    playlistItemsRef.current = [];
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
        className={`music-modal-dialog music-panel ${isExpanded ? "expanded" : ""} ${
          activeResizeEdge ? `resizing-${activeResizeEdge} is-resizing` : ""
        } ${isDimmed ? "is-dimmed" : ""} ${showDimPopover ? "popover-open" : ""}`}
        style={{
          width: `${panelWidth}px`,
          height: `${panelHeight}px`,
          ...(isDimmed
            ? ({ "--music-custom-opacity": String(dimPercent / 100) } as React.CSSProperties)
            : {}),
        }}
        onClick={(e) => e.stopPropagation()}
        role="document"
        onKeyDown={onPanelKeyDown}
      >
        <div
          className="music-resize-handle music-resize-left"
          onPointerDown={onResizeStart("left")}
          title="Drag border to resize width"
          aria-label="Resize music player width"
        />
        <div
          className="music-resize-top"
          onPointerDown={onResizeStart("top")}
          title="Drag border to resize height"
          aria-label="Resize music player height"
        />
        <div
          className="music-resize-corner"
          onPointerDown={onResizeStart("corner")}
          title="Drag corner to resize player"
          aria-label="Resize music player"
        />
        <div className="modal-header music-head">
          <div className="music-head-title">
            <span className="music-head-badge" aria-hidden="true">
              <Music size={14} aria-hidden="true" />
            </span>
            <h3>YouTube Music</h3>
          </div>
          <div className="music-head-actions">
            <div className="music-dim-group">
              <button
                type="button"
                className={`btn btn-icon ${isDimmed ? "music-control-active" : ""}`}
                onClick={() => {
                  setShowDimPopover((prev) => !prev);
                }}
                title={`Dim opacity (${dimPercent}%)${isDimmed ? " — On" : " — Off"}`}
                aria-label={`Dim player opacity (${dimPercent}%)`}
                aria-pressed={isDimmed}
              >
                <Contrast size={13} />
              </button>
              {showDimPopover && (
                <div
                  ref={dimPopoverRef}
                  className="music-dim-popover"
                  role="dialog"
                  aria-label="Adjust dim opacity"
                  onClick={(e) => e.stopPropagation()}
                >
                  <div className="music-dim-header">
                    <div className="music-dim-title">
                      <Contrast size={13} aria-hidden="true" />
                      <span>Dim Opacity</span>
                    </div>
                    <div
                      className="music-dim-toggle-switch"
                      role="group"
                      aria-label="Toggle dim opacity"
                    >
                      <button
                        type="button"
                        className={`music-dim-toggle-btn ${!isDimmed ? "active" : ""}`}
                        onClick={disableDim}
                        aria-pressed={!isDimmed}
                        aria-label="Turn off dimming"
                      >
                        Off
                      </button>
                      <button
                        type="button"
                        className={`music-dim-toggle-btn ${isDimmed ? "active active-on" : ""}`}
                        onClick={() => enableDim()}
                        aria-pressed={isDimmed}
                        aria-label="Turn on dimming"
                      >
                        On
                      </button>
                    </div>
                  </div>
                  <div className="music-dim-body">
                    <div className="music-dim-level-row">
                      <span className="music-dim-level-label">Level</span>
                      <span className="music-dim-val">{dimPercent}%</span>
                    </div>
                    <div className="music-dim-slider-row">
                      <input
                        type="range"
                        min={15}
                        max={100}
                        step={5}
                        value={dimPercent}
                        onChange={(e) => handleDimPercentChange(Number(e.target.value))}
                        className="music-dim-slider"
                        aria-label="Dim opacity percentage slider"
                      />
                    </div>
                    <div className="music-dim-range-labels" aria-hidden="true">
                      <span>15%</span>
                      <span>100%</span>
                    </div>
                    <div className="music-dim-presets">
                      {[25, 40, 60, 80, 100].map((pct) => (
                        <button
                          key={pct}
                          type="button"
                          className={`music-dim-preset-chip ${dimPercent === pct && isDimmed ? "active" : ""}`}
                          onClick={() => enableDim(pct)}
                        >
                          {pct}%
                        </button>
                      ))}
                    </div>
                  </div>
                </div>
              )}
            </div>
            <button
              type="button"
              className={`btn btn-icon ${isExpanded || panelWidth >= 460 ? "music-control-active" : ""}`}
              onClick={handleToggleExpand}
              title={
                isExpanded || panelWidth >= 460
                  ? "Restore compact size (360×540)"
                  : "Expand player screen (520×680)"
              }
              aria-label={
                isExpanded || panelWidth >= 460
                  ? "Reset player to default size"
                  : "Expand player screen"
              }
            >
              {isExpanded || panelWidth >= 460 ? <Minimize2 size={13} /> : <Maximize2 size={13} />}
            </button>
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
            title="Search songs"
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

        <div className="music-body">
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
            ) : (
              <div className="music-video-empty">
                <span className="music-empty-badge" aria-hidden="true">
                  <Music size={28} aria-hidden="true" />
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
                className="btn btn-icon music-ctrl-btn"
                onClick={previous}
                disabled={!src}
                title="Previous song (P)"
                aria-label="Previous song"
              >
                <SkipBack size={14} />
              </button>
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
                title={
                  queue.length > 0 ? `Play next: ${queue[0].title} (N)` : "Next song / replay (N)"
                }
                aria-label="Next song"
              >
                <SkipForward size={14} />
              </button>
              <button
                type="button"
                className={`btn btn-icon music-ctrl-btn ${showNextList && queue.length > 0 ? "music-control-active" : ""}`}
                onClick={toggleNextList}
                title={showNextList ? "Hide next playing list" : "Show next playing list"}
                aria-label="Next playing list"
                aria-pressed={showNextList}
              >
                <ListMusic size={14} />
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
            </div>
          </div>
        </div>

        {/* Backdrop overlay: clicking outside the bottom slider drawer closes it */}
        {drawerOpen && (
          <div className="music-drawer-backdrop" onClick={closeDrawer} aria-hidden="true" />
        )}

        {/* Bottom-side slider drawer for Next Playing and Search Results */}
        <div
          ref={drawerRef}
          className={`music-queue-drawer ${drawerMode === "search" ? "music-search-results" : "music-next-section music-queue-section"} ${drawerOpen ? "open" : ""}`}
          aria-hidden={!drawerOpen}
        >
          <div className="music-drawer-header">
            <button
              type="button"
              className="music-drawer-back"
              onClick={closeDrawer}
              title="Back"
              aria-label="Back to player"
            >
              <ChevronLeft size={16} />
            </button>
            <span className="music-drawer-title">
              {drawerMode === "search"
                ? `Search Results (${searchResults.length})`
                : `Next Playing (${queue.length})`}
            </span>
          </div>

          <div className="music-drawer-list music-track-list">
            {drawerMode === "search" ? (
              searchResults.map((item, idx) => {
                const isCurrent = Boolean(item.videoId && item.videoId === track?.videoId);
                return (
                  <button
                    key={`${item.videoId || idx}-${idx}`}
                    type="button"
                    className={`music-track-item music-search-item${isCurrent ? " music-item-playing" : ""}`}
                    onClick={() => playSearchResult(item, idx)}
                    title={isCurrent ? "Restart this song" : `Play ${item.title}`}
                  >
                    <span className="music-item-index">{idx + 1}</span>
                    {item.videoId ? (
                      <img
                        src={`https://i.ytimg.com/vi/${encodeURIComponent(item.videoId)}/mqdefault.jpg`}
                        alt=""
                        loading="lazy"
                        className="music-item-thumb"
                        onError={(e) => {
                          (e.currentTarget as HTMLImageElement).style.display = "none";
                        }}
                      />
                    ) : (
                      <div className="music-item-thumb-placeholder" aria-hidden="true">
                        <Play size={10} />
                      </div>
                    )}
                    <span className="music-item-name">{item.title}</span>
                    {isCurrent ? (
                      <span className="music-eq" aria-label="Now playing">
                        <i />
                        <i />
                        <i />
                      </span>
                    ) : (
                      <Play size={10} className="music-item-play-ico" />
                    )}
                  </button>
                );
              })
            ) : queue.length === 0 && !track ? (
              <div className="music-drawer-empty">
                <span>No upcoming songs in list</span>
                <small className="muted-text">
                  Search for a song or click Next to add suggestions
                </small>
              </div>
            ) : (
              <>
                {/* Pinned row: what's playing now, always visible in the list. */}
                {track && (
                  <button
                    type="button"
                    className="music-track-item music-queue-now music-item-playing"
                    onClick={replayCurrent}
                    title="Restart this song"
                    aria-label={`Now playing: ${track.title}`}
                  >
                    <span className="music-eq" aria-hidden="true">
                      <i />
                      <i />
                      <i />
                    </span>
                    {track.videoId ? (
                      <img
                        src={`https://i.ytimg.com/vi/${encodeURIComponent(track.videoId)}/mqdefault.jpg`}
                        alt=""
                        loading="lazy"
                        className="music-item-thumb"
                        onError={(e) => {
                          (e.currentTarget as HTMLImageElement).style.display = "none";
                        }}
                      />
                    ) : (
                      <div className="music-item-thumb-placeholder" aria-hidden="true">
                        <Pause size={10} />
                      </div>
                    )}
                    <span className="music-item-name">{track.title}</span>
                    <span className="music-now-tag">Now</span>
                  </button>
                )}
                {track?.playlistId && queue.length === 0 ? (
                  playlistLoading ? (
                    <div className="music-drawer-empty">
                      <span>Loading playlist…</span>
                    </div>
                  ) : playlistItems.length > 0 ? (
                    <>
                      {playlistItems.slice(0, playlistVisible).map((item, idx) => {
                        const isCurrent = Boolean(item.videoId && item.videoId === track?.videoId);
                        return (
                          <button
                            key={`${item.videoId || idx}-${idx}`}
                            type="button"
                            className={`music-track-item music-queue-item${isCurrent ? " music-item-playing" : ""}`}
                            onClick={() => playPlaylistItem(item)}
                            title={isCurrent ? "Restart this song" : `Play ${item.title}`}
                          >
                            <span className="music-item-index">{idx + 1}</span>
                            {item.videoId ? (
                              <img
                                src={`https://i.ytimg.com/vi/${encodeURIComponent(item.videoId)}/mqdefault.jpg`}
                                alt=""
                                loading="lazy"
                                className="music-item-thumb"
                                onError={(e) => {
                                  (e.currentTarget as HTMLImageElement).style.display = "none";
                                }}
                              />
                            ) : (
                              <div className="music-item-thumb-placeholder" aria-hidden="true">
                                <Play size={10} />
                              </div>
                            )}
                            <span className="music-item-name music-queue-name">{item.title}</span>
                            {isCurrent ? (
                              <span className="music-eq" aria-label="Now playing">
                                <i />
                                <i />
                                <i />
                              </span>
                            ) : (
                              <Play
                                size={10}
                                className="music-item-play-ico music-queue-play-ico"
                              />
                            )}
                          </button>
                        );
                      })}
                      {playlistVisible < playlistItems.length && (
                        <button
                          type="button"
                          className="music-list-clear"
                          style={{ margin: "8px auto", display: "block" }}
                          onClick={() => setPlaylistVisible((v) => v + PLAYLIST_PAGE_SIZE)}
                        >
                          Load more
                        </button>
                      )}
                    </>
                  ) : (
                    <div className="music-drawer-empty">
                      <span>Playing a YouTube playlist</span>
                      <small className="muted-text">
                        Next advances inside the playlist itself.
                      </small>
                    </div>
                  )
                ) : (
                  <>
                    {queue.map((item, idx) => {
                      const isCurrent = Boolean(item.videoId && item.videoId === track?.videoId);
                      return (
                        <button
                          key={`${item.videoId || idx}-${idx}`}
                          type="button"
                          className={`music-track-item music-queue-item${isCurrent ? " music-item-playing" : ""}`}
                          onClick={() => playQueueIndex(idx)}
                          title={isCurrent ? "Restart this song" : `Play ${item.title}`}
                        >
                          <span className="music-item-index">{idx + 1}</span>
                          {item.videoId ? (
                            <img
                              src={`https://i.ytimg.com/vi/${encodeURIComponent(item.videoId)}/mqdefault.jpg`}
                              alt=""
                              loading="lazy"
                              className="music-item-thumb"
                              onError={(e) => {
                                (e.currentTarget as HTMLImageElement).style.display = "none";
                              }}
                            />
                          ) : (
                            <div className="music-item-thumb-placeholder" aria-hidden="true">
                              <Play size={10} />
                            </div>
                          )}
                          <span className="music-item-name music-queue-name">{item.title}</span>
                          {isCurrent ? (
                            <span className="music-eq" aria-label="Now playing">
                              <i />
                              <i />
                              <i />
                            </span>
                          ) : (
                            <Play size={10} className="music-item-play-ico music-queue-play-ico" />
                          )}
                        </button>
                      );
                    })}
                    {queue.length > 0 && !track?.playlistId && (
                      <button
                        type="button"
                        className="music-list-clear"
                        style={{ margin: "8px auto", display: "block" }}
                        disabled={suggestLoading}
                        onClick={loadMoreSuggestions}
                      >
                        {suggestLoading ? "Loading…" : "Load more suggestions"}
                      </button>
                    )}
                  </>
                )}
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  );
};
