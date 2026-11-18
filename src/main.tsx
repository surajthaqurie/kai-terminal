import ReactDOM from "react-dom/client";
import App from "./App";
import { isMusicPipWindow } from "./services/musicPip";
import "./fonts.css";
import "./App.css";

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

void preloadFonts().then(async () => {
  const root = ReactDOM.createRoot(document.getElementById("root") as HTMLElement);
  // The detached music window loads this same bundle with `?pip=music` and
  // renders only the small player, never the terminal app.
  if (isMusicPipWindow()) {
    const { MusicPipWindow } = await import("./components/MusicPlayer/MusicPipWindow");
    root.render(<MusicPipWindow />);
    return;
  }
  root.render(<App />);
});
