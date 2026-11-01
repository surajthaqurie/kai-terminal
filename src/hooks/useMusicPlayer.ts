import { useCallback, useState } from "react";
import { SettingsService } from "../services/settingsService";

const PINNED_KEY = "kai_music_pinned";

/** Transport events that do nothing until a song is loaded. */
const NEEDS_A_SONG: ReadonlySet<string> = new Set([
  "kai-music-toggle-play",
  "kai-music-next",
  "kai-music-previous",
]);

interface MusicTrackInfo {
  title?: string | null;
  videoId?: string | null;
  thumbnail?: string | null;
}

/**
 * Music Time state shared by the footer mini-player and the (always-mounted
 * while enabled) MusicPanel. Footer + shortcuts dispatch window events the
 * panel listens to, so playback survives panel close and the footer works
 * while the drawer is hidden.
 */
export function useMusicPlayer({ showMusicPlayer }: { showMusicPlayer: boolean | undefined }) {
  const [isOpen, setIsOpen] = useState<boolean>(() => {
    try {
      return localStorage.getItem(PINNED_KEY) === "true";
    } catch {
      return false;
    }
  });
  const [title, setTitle] = useState<string | null>(null);
  const [videoId, setVideoId] = useState<string | null>(null);
  const [thumbnail, setThumbnail] = useState<string | null>(null);
  const [playing, setPlaying] = useState<boolean>(false);
  const [progress, setProgress] = useState<number>(0);
  const [muted, setMuted] = useState<boolean>(() =>
    Boolean(SettingsService.loadSettings().musicStartMuted)
  );

  const dispatchEvent = useCallback((name: string) => {
    try {
      window.dispatchEvent(new CustomEvent(name));
    } catch {
      // ignore
    }
  }, []);

  const togglePanel = useCallback(() => setIsOpen((prev) => !prev), []);

  const closePanel = useCallback(() => setIsOpen(false), []);

  const openPanel = useCallback(() => setIsOpen(true), []);

  /**
   * Transport command from the footer buttons or a global shortcut. Play, next
   * and previous need a song: with nothing loaded the panel ignores them, so
   * (when the player is enabled) open the drawer to let the user pick one
   * instead of leaving a button or shortcut that silently does nothing.
   */
  const transport = useCallback(
    (name: string) => {
      if (showMusicPlayer && !title && NEEDS_A_SONG.has(name)) setIsOpen(true);
      dispatchEvent(name);
    },
    [showMusicPlayer, title, dispatchEvent]
  );

  const playPause = useCallback(() => transport("kai-music-toggle-play"), [transport]);

  const handleTrackChange = useCallback((track: MusicTrackInfo | null, isPlaying: boolean) => {
    setTitle(track?.title ?? null);
    setVideoId(track?.videoId ?? null);
    setThumbnail(
      track?.thumbnail ??
        (track?.videoId
          ? `https://i.ytimg.com/vi/${encodeURIComponent(track.videoId)}/mqdefault.jpg`
          : null)
    );
    setPlaying(isPlaying);
  }, []);

  /** Footer mini-player model; null hides it when the player is disabled. */
  const footerState = showMusicPlayer
    ? { title, videoId, thumbnail, playing, muted, progress }
    : null;

  return {
    isOpen,
    muted,
    setMuted,
    footerState,
    dispatchEvent,
    togglePanel,
    closePanel,
    openPanel,
    transport,
    playPause,
    handleTrackChange,
    setProgress,
  };
}
