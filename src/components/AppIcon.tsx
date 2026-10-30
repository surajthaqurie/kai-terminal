import { FC } from "react";

interface AppIconProps {
  size?: number;
  className?: string;
}

/**
 * The Kai app icon (same artwork as src-tauri/icons and the website), drawn
 * inline so it follows the window chrome with no extra request. Decorative:
 * the name next to it carries the accessible label.
 */
export const AppIcon: FC<AppIconProps> = ({ size = 18, className }) => (
  <svg
    className={className}
    viewBox="0 0 64 64"
    width={size}
    height={size}
    aria-hidden="true"
    focusable="false"
  >
    <defs>
      <linearGradient id="kai-app-icon-edge" x1="0" y1="0" x2="1" y2="1">
        <stop offset="0" stopColor="#10b981" />
        <stop offset="1" stopColor="#06b6d4" />
      </linearGradient>
    </defs>
    <rect x="2" y="2" width="60" height="60" rx="15" fill="#0a0e17" />
    <rect
      x="8"
      y="8"
      width="48"
      height="48"
      rx="10"
      fill="#0d131f"
      stroke="url(#kai-app-icon-edge)"
      strokeWidth="3"
    />
    <circle cx="16" cy="16" r="2.2" fill="#10b981" />
    <circle cx="23" cy="16" r="2.2" fill="#06b6d4" />
    <circle cx="30" cy="16" r="2.2" fill="#3b82f6" opacity="0.8" />
    <path
      d="M17 30l9 7-9 7"
      fill="none"
      stroke="#22d3ee"
      strokeWidth="4"
      strokeLinecap="round"
      strokeLinejoin="round"
    />
    <path d="M32 46h14" stroke="#22d3ee" strokeWidth="4" strokeLinecap="round" />
  </svg>
);
