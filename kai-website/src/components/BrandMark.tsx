/**
 * The Kai mark, inline. Same geometry as public/icon.svg, the desktop app
 * icon (src-tauri/icons) and the app's own AppIcon component.
 * Decorative: the "kai" wordmark next to it carries the name.
 */
export function BrandMark({ size = 36, className }: { size?: number; className?: string }) {
  return (
    <svg
      className={className}
      viewBox="0 0 1024 1024"
      width={size}
      height={size}
      aria-hidden="true"
      focusable="false"
    >
      <rect width="1024" height="1024" rx="228" fill="#111317" />
      <rect x="6" y="6" width="1012" height="1012" rx="222" fill="none" stroke="#ffffff" strokeOpacity="0.12" strokeWidth="12" />
      <path d="M300 344 L480 512 L300 680" fill="none" stroke="#f4f4f5" strokeWidth="88" strokeLinecap="round" strokeLinejoin="round" />
      <rect x="548" y="604" width="184" height="88" rx="14" fill="#22d3ee" />
    </svg>
  );
}
