import { FC } from "react";

interface AppIconProps {
  size?: number;
  className?: string;
}

/**
 * The Kai app icon (same artwork as src-tauri/icons and kai-website/public/icon.svg),
 * drawn inline so it needs no extra request. Flat charcoal tile, off-white
 * prompt and a single cyan block cursor. Decorative: the name next to it
 * carries the accessible label.
 */
export const AppIcon: FC<AppIconProps> = ({ size = 18, className }) => (
  <svg
    className={className}
    viewBox="0 0 1024 1024"
    width={size}
    height={size}
    aria-hidden="true"
    focusable="false"
  >
    <rect width="1024" height="1024" rx="228" fill="#111317" />
    <rect
      x="6"
      y="6"
      width="1012"
      height="1012"
      rx="222"
      fill="none"
      stroke="#ffffff"
      strokeOpacity="0.12"
      strokeWidth="12"
    />
    <path
      d="M300 344 L480 512 L300 680"
      fill="none"
      stroke="#f4f4f5"
      strokeWidth="96"
      strokeLinecap="round"
      strokeLinejoin="round"
    />
    <rect x="548" y="600" width="184" height="96" rx="14" fill="#22d3ee" />
  </svg>
);
