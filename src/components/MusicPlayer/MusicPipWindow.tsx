import { FC, useEffect, useRef, useState } from "react";
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
  type PipAction,
  type PipState,
} from "../../services/musicPip";
import {
  YOUTUBE_LISTENING_HANDSHAKE,
  isYouTubeEmbedOrigin,
  progressPercent,
  youtubeCommand,
} from "../../services/musicService";

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

  // Wire up the main window, then announce we are ready for its first state.
  useEffect(() => {
    let cancelled = false;
    const unlisteners: Array<() => void> = [];
    const keep = (p: Promise<() => void>) =>
      p.then((u) => {
        if (cancelled) u();
        else unlisteners.push(u);
      });
    const stateReady = keep(listenPip<PipState>(PIP_EVENTS.state, (s) => setState(s)));
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

  const percent = state.duration > 0 ? progressPercent(state.currentTime, state.duration) : 0;
  const title = state.title ?? "Nothing playing";

  return (
    <div
      className={`music-pip${src ? "" : " music-pip-idle"}`}
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

      <div className="music-pip-head" data-tauri-drag-region>
        <Music size={12} aria-hidden="true" className="music-pip-head-icon" />
        <span className="music-pip-title" data-tauri-drag-region title={title}>
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
          <span className="music-time-label">{formatTime(state.currentTime)}</span>
          <input
            type="range"
            min={0}
            max={100}
            value={percent}
            onChange={(e) => act({ name: "seek", value: Number(e.target.value) })}
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
