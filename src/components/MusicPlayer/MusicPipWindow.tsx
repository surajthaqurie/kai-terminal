import {
  FC,
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type PointerEvent as ReactPointerEvent,
} from "react";
import {
  Maximize2,
  Music,
  Pause,
  Play,
  SkipBack,
  SkipForward,
  Volume2,
  VolumeX,
  X,
} from "lucide-react";
import {
  EMPTY_PIP_STATE,
  PIP_EVENTS,
  closeMusicPip,
  emitPip,
  listenPip,
  savePipPosition,
  savePipSize,
  type PipAction,
  type PipState,
} from "../../services/musicPip";
import {
  YOUTUBE_LISTENING_HANDSHAKE,
  adoptMusicRelayFrom,
  isYouTubeEmbedOrigin,
  progressPercent,
  youtubeCommand,
} from "../../services/musicService";

/** How long the controls stay after the pointer stops moving over the video. */
const CHROME_IDLE_MS = 2500;

function formatTime(sec: number): string {
  if (!Number.isFinite(sec) || sec <= 0) return "0:00";
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${s < 10 ? "0" : ""}${s}`;
}

/**
 * The detached always-on-top music window. It owns nothing but the YouTube
 * iframe: the main window sends what to show and executes every button press
 * (see `services/musicPip.ts` for the protocol), so queue, history and
 * shortcuts behave exactly as they do in the docked player.
 */
export const MusicPipWindow: FC = () => {
  const [state, setState] = useState<PipState>(EMPTY_PIP_STATE);
  const stateRef = useRef(state);
  stateRef.current = state;
  const frameRef = useRef<HTMLIFrameElement | null>(null);
  const receivedRef = useRef(false);

  const act = (action: PipAction) => void emitPip(PIP_EVENTS.action, action);

  // The window is transparent so Dim Opacity can show the desktop through it;
  // the page itself must not paint the app's canvas color behind the player.
  useEffect(() => {
    document.documentElement.classList.add("music-pip-window");
    return () => document.documentElement.classList.remove("music-pip-window");
  }, []);

  // Remember the window's position and size for next time.
  useEffect(() => {
    const unlisteners: Array<() => void> = [];
    let cancelled = false;
    let moveTimer = 0;
    let sizeTimer = 0;
    void (async () => {
      try {
        const { getCurrentWindow } = await import("@tauri-apps/api/window");
        const win = getCurrentWindow();
        const keep = (u: () => void) => {
          if (cancelled) u();
          else unlisteners.push(u);
        };
        keep(
          await win.onMoved(({ payload }) => {
            // A drag fires many moves; store only where it settles.
            window.clearTimeout(moveTimer);
            moveTimer = window.setTimeout(() => savePipPosition(payload.x, payload.y), 250);
          })
        );
        keep(
          await win.onResized(({ payload }) => {
            window.clearTimeout(sizeTimer);
            sizeTimer = window.setTimeout(() => {
              // Reported in physical pixels; the window is created in logical ones.
              void win
                .scaleFactor()
                .then((scale) => {
                  const s = scale > 0 ? scale : 1;
                  savePipSize(payload.width / s, payload.height / s);
                })
                .catch(() => {});
            }, 250);
          })
        );
      } catch {
        // Not in the desktop app: nothing to remember.
      }
    })();
    return () => {
      cancelled = true;
      window.clearTimeout(moveTimer);
      window.clearTimeout(sizeTimer);
      unlisteners.forEach((u) => u());
    };
  }, []);

  // The title strip and controls show while the pointer moves over the window
  // and fade out after a short rest while a song plays (just the video), or as
  // soon as the pointer leaves. They stay while it rests on the controls.
  const [chrome, setChrome] = useState(false);
  const chromeTimerRef = useRef(0);
  const scheduleHide = (overControls: boolean) => {
    window.clearTimeout(chromeTimerRef.current);
    if (overControls || !stateRef.current.playing) return;
    chromeTimerRef.current = window.setTimeout(() => setChrome(false), CHROME_IDLE_MS);
  };
  const showChrome = (e: ReactPointerEvent<HTMLDivElement>) => {
    setChrome(true);
    const overControls = Boolean(
      (e.target as HTMLElement).closest(".music-pip-head, .music-pip-bar")
    );
    scheduleHide(overControls || draggingRef.current);
  };
  const hideChrome = () => {
    window.clearTimeout(chromeTimerRef.current);
    if (!draggingRef.current) setChrome(false);
  };
  // A song starting while the pointer rests on the video hides them too.
  useEffect(() => {
    if (state.playing) scheduleHide(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.playing]);
  useEffect(() => {
    // The pointer can leave the window without a pointerleave (window hidden,
    // another window raised over it); losing focus covers that.
    const onBlur = () => hideChrome();
    window.addEventListener("blur", onBlur);
    return () => {
      window.removeEventListener("blur", onBlur);
      window.clearTimeout(chromeTimerRef.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /** Drag the window from anywhere on it except its buttons and slider. */
  const onPointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    showChrome(e);
    if (e.button !== 0) return;
    if ((e.target as HTMLElement).closest("button, input, a")) return;
    e.preventDefault();
    void import("@tauri-apps/api/window")
      .then(({ getCurrentWindow }) => getCurrentWindow().startDragging())
      .catch(() => {});
  };

  // YouTube reports the time only every so often (and it crosses two windows
  // to get back here), so between reports the time and the progress bar are
  // advanced locally every frame while playing: no stepping, no stalls.
  const [smoothTime, setSmoothTime] = useState(0);
  const anchorRef = useRef({ time: 0, at: 0 });
  useEffect(() => {
    anchorRef.current = { time: state.currentTime, at: performance.now() };
    setSmoothTime(state.currentTime);
  }, [state.currentTime]);
  const advancing = state.playing && !state.buffering && Boolean(state.src);
  useEffect(() => {
    if (!advancing) {
      setSmoothTime(anchorRef.current.time);
      return;
    }
    let raf = 0;
    const tick = () => {
      const { time, at } = anchorRef.current;
      const elapsed = (performance.now() - at) / 1000;
      // Never run more than a couple of seconds ahead of the last report
      // (a report that is late), nor past the end.
      const next = time + Math.min(elapsed, 2);
      setSmoothTime(state.duration > 0 ? Math.min(next, state.duration) : next);
      raf = window.requestAnimationFrame(tick);
    };
    anchorRef.current = { ...anchorRef.current, at: performance.now() };
    raf = window.requestAnimationFrame(tick);
    return () => window.cancelAnimationFrame(raf);
  }, [advancing, state.duration]);

  // Wire up the main window, then announce we are ready for its first state.
  useEffect(() => {
    let cancelled = false;
    const unlisteners: Array<() => void> = [];
    const keep = (p: Promise<() => void>) =>
      p.then((u) => {
        if (cancelled) u();
        else unlisteners.push(u);
      });
    const stateReady = keep(
      listenPip<PipState>(PIP_EVENTS.state, (s) => {
        // A src through the main window's music relay: its reports come from there.
        adoptMusicRelayFrom(s?.src ?? null);
        setState(s);
      })
    );
    void keep(
      listenPip<string>(PIP_EVENTS.command, (msg) => {
        if (typeof msg === "string") frameRef.current?.contentWindow?.postMessage(msg, "*");
      })
    );
    void stateReady.then(() => {
      if (!cancelled) void emitPip(PIP_EVENTS.ready);
    });
    return () => {
      cancelled = true;
      unlisteners.forEach((u) => u());
    };
  }, []);

  // The embed posts its telemetry (time, state, title) to THIS window; hand it
  // to the main window, which owns the player state. Only our own iframe at a
  // YouTube origin is trusted.
  useEffect(() => {
    const onMessage = (e: MessageEvent) => {
      if (!isYouTubeEmbedOrigin(e.origin)) return;
      if (!frameRef.current || e.source !== frameRef.current.contentWindow) return;
      if (typeof e.data !== "string") return;
      receivedRef.current = true;
      void emitPip(PIP_EVENTS.message, e.data);
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, []);

  // The embed may not be listening yet when it loads; retry the handshake briefly.
  const { src } = state;
  useEffect(() => {
    if (!src) return;
    receivedRef.current = false;
    let tries = 0;
    const timer = window.setInterval(() => {
      if (receivedRef.current || ++tries > 20) {
        window.clearInterval(timer);
        return;
      }
      frameRef.current?.contentWindow?.postMessage(YOUTUBE_LISTENING_HANDSHAKE, "*");
    }, 500);
    return () => window.clearInterval(timer);
  }, [src]);

  const onFrameLoad = () => {
    const post = (msg: string) => frameRef.current?.contentWindow?.postMessage(msg, "*");
    post(YOUTUBE_LISTENING_HANDSHAKE);
    post(youtubeCommand("setVolume", [stateRef.current.volume]));
    post(youtubeCommand(stateRef.current.muted ? "mute" : "unMute"));
  };

  // While the seek slider is dragged it shows the drag position, not the
  // advancing playback time, and seeks once on release: no fighting the bar,
  // and no burst of seek commands to YouTube.
  const [scrub, setScrub] = useState<number | null>(null);
  const draggingRef = useRef(false);
  const seekTo = (value: number) => {
    act({ name: "seek", value });
    // Show the new spot at once; YouTube's next report confirms it.
    if (state.duration > 0) {
      const time = (value / 100) * state.duration;
      anchorRef.current = { time, at: performance.now() };
      setSmoothTime(time);
    }
  };
  const endScrub = () => {
    if (!draggingRef.current) return;
    draggingRef.current = false;
    if (scrub !== null) seekTo(scrub);
    setScrub(null);
  };
  const endScrubRef = useRef(endScrub);
  endScrubRef.current = endScrub;

  const playedPercent = state.duration > 0 ? progressPercent(smoothTime, state.duration) : 0;
  const percent = scrub ?? playedPercent;
  const shownTime =
    scrub !== null && state.duration > 0 ? (scrub / 100) * state.duration : smoothTime;
  const title = state.title ?? "Nothing playing";

  return (
    <div
      className={`music-pip${src ? "" : " music-pip-idle"}${chrome ? " music-pip-chrome" : ""}`}
      style={{ "--music-pip-opacity": String(state.opacity ?? 1) } as CSSProperties}
      onPointerDown={onPointerDown}
      onPointerMove={showChrome}
      onPointerEnter={showChrome}
      onPointerLeave={hideChrome}
      role="application"
      aria-label="YouTube Music mini player"
    >
      <div className="music-pip-video">
        {src ? (
          <iframe
            key={src}
            ref={frameRef}
            referrerPolicy="no-referrer-when-downgrade"
            onLoad={onFrameLoad}
            className="music-pip-frame"
            src={src}
            title={state.title ?? "YouTube player"}
            allow="autoplay; encrypted-media; picture-in-picture"
          />
        ) : (
          <div className="music-pip-empty">
            <Music size={22} aria-hidden="true" />
            <span>Nothing playing</span>
          </div>
        )}
      </div>

      <div className="music-pip-head">
        <Music size={12} aria-hidden="true" className="music-pip-head-icon" />
        <span className="music-pip-title" title={title}>
          {title}
        </span>
        <button
          type="button"
          className="music-pip-icon-btn"
          onClick={() => act({ name: "restore" })}
          title="Back to the player"
          aria-label="Back to the player"
        >
          <Maximize2 size={12} />
        </button>
        <button
          type="button"
          className="music-pip-icon-btn"
          onClick={() => void closeMusicPip(false)}
          title="Close (music keeps playing in the player)"
          aria-label="Close mini player"
        >
          <X size={13} />
        </button>
      </div>

      <div className="music-pip-bar">
        <div className="music-pip-progress">
          <span className="music-time-label">{formatTime(shownTime)}</span>
          <input
            type="range"
            min={0}
            max={100}
            step="any"
            value={percent}
            onPointerDown={() => {
              draggingRef.current = true;
              // Released anywhere (even off the slider) ends the drag.
              window.addEventListener("pointerup", () => endScrubRef.current(), { once: true });
            }}
            onChange={(e) => {
              const value = Number(e.target.value);
              // Pointer drags commit on release; keyboard steps seek at once.
              if (draggingRef.current) setScrub(value);
              else seekTo(value);
            }}
            className="music-progress-slider"
            disabled={!src}
            aria-label="Seek track position"
          />
          <span className="music-time-label">{formatTime(state.duration)}</span>
        </div>
        <div className="music-pip-controls">
          <button
            type="button"
            className="btn btn-icon music-ctrl-btn"
            onClick={() => act({ name: "previous" })}
            disabled={!src}
            title="Previous song"
            aria-label="Previous song"
          >
            <SkipBack size={14} />
          </button>
          <button
            type="button"
            className="music-play"
            onClick={() => act({ name: "toggle-play" })}
            disabled={!src}
            title="Play / pause"
            aria-label={state.playing ? "Pause" : "Play"}
          >
            {state.playing ? <Pause size={14} /> : <Play size={14} />}
          </button>
          <button
            type="button"
            className="btn btn-icon music-ctrl-btn"
            onClick={() => act({ name: "next" })}
            disabled={!src}
            title="Next song"
            aria-label="Next song"
          >
            <SkipForward size={14} />
          </button>
          <button
            type="button"
            className="btn btn-icon music-ctrl-btn"
            onClick={() => act({ name: "mute" })}
            disabled={!src}
            title={state.muted ? "Unmute" : "Mute"}
            aria-label={state.muted ? "Unmute" : "Mute"}
            aria-pressed={state.muted}
          >
            {state.muted || state.volume === 0 ? <VolumeX size={14} /> : <Volume2 size={14} />}
          </button>
        </div>
      </div>
    </div>
  );
};
