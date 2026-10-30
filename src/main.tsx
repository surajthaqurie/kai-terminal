import ReactDOM from "react-dom/client";
import App from "./App";
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

void preloadFonts().then(() => {
  ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(<App />);
});
