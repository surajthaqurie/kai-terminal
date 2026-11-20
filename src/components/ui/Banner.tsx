import type { ReactNode } from "react";
import type { Tone } from "./Badge";

interface BannerProps {
  /** Severity; `danger` and `warning` are announced assertively (role="alert"). */
  tone?: Exclude<Tone, "neutral">;
  /** Accessible name of the banner region. */
  label: string;
  /** The message. */
  children: ReactNode;
  /** Action buttons, right-aligned. */
  actions?: ReactNode;
}

/**
 * Full-width app-level notice above the terminals (session restore, split
 * refused, shell keeps exiting). Severity is shown by a left stripe and icon
 * colour, and announced via the role, so it never relies on colour alone.
 */
export function Banner({ tone = "info", label, children, actions }: BannerProps) {
  const assertive = tone === "danger" || tone === "warning";
  return (
    <div
      className={`banner banner-${tone}`}
      role={assertive ? "alert" : "status"}
      aria-label={label}
    >
      <span className="banner-text">{children}</span>
      {actions && <div className="banner-actions">{actions}</div>}
    </div>
  );
}
