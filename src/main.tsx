import ReactDOM from "react-dom/client";
import { isMusicPipWindow } from "./services/musicPip";
import { isSharedChatWindow } from "./services/sharedChatWindow";
import { initMusicRelay } from "./services/musicService";
import { isSecondaryTerminalWindow, takeWindowSeed } from "./services/terminalWindows";
import "./fonts.css";
import "./styles/index.css";

/**
 * xterm measures its character cell when it opens, so the bundled fonts must be
 * ready before the first terminal mounts or the grid is sized for a fallback
 * font. They are local files, so this is a few milliseconds; the timeout only
 * guards against a stuck font load blocking the whole window.
 */
async function preloadFonts(): Promise<void> {
  if (typeof document === "undefined" || !document.fonts) return;
  const loads = Promise.all([
    document.fonts.load('13px "JetBrains Mono Variable"'),
    document.fonts.load('13px "Inter Variable"'),
  ]).catch(() => undefined);
  await Promise.race([loads, new Promise((resolve) => setTimeout(resolve, 1500))]);
}

const root = ReactDOM.createRoot(document.getElementById("root") as HTMLElement);
if (isMusicPipWindow()) {
  // The detached music window loads this same page with `?pip=music` and
  // renders only the small player: it never loads the terminal app's code nor
  // waits for the terminal fonts, so the video starts as soon as possible.
  // (It takes the music relay, if any, from the src the main window sends.)
  void import("./components/MusicPlayer/MusicPipWindow").then(({ MusicPipWindow }) =>
    root.render(<MusicPipWindow />)
  );
} else if (isSharedChatWindow()) {
  // The popped-out Shared Agent chat: only the chat, none of the terminal app.
  void import("./components/SharedChatWindow").then(({ SharedChatWindow }) =>
    root.render(<SharedChatWindow />)
  );
} else {
  // On macOS / Linux the music player hosts YouTube in the app's local relay
  // page (see `setMusicRelay`); checked in the background, never delaying the
  // window.
  void initMusicRelay();
  // Fetch the app's code while the fonts load.
  const app = import("./App");
  // A window opened by dragging a tab out starts with that tab (its shells are
  // already running), so the seed is read BEFORE the app renders: otherwise a
  // starter tab would spawn a shell nobody asked for.
  const seed = isSecondaryTerminalWindow() ? takeWindowSeed() : Promise.resolve(null);
  void Promise.all([app, preloadFonts(), seed]).then(([{ default: App }, , initialSeed]) =>
    root.render(<App initialSeed={initialSeed} />)
  );
}
