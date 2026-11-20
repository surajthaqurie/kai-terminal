import type { ButtonHTMLAttributes, ReactNode } from "react";

interface IconButtonProps extends Omit<
  ButtonHTMLAttributes<HTMLButtonElement>,
  "type" | "aria-label" | "children"
> {
  /** Required: an icon-only button has no other accessible name. Also the tooltip. */
  label: string;
  /** The icon (lucide, `aria-hidden` is applied by the wrapper span). */
  icon: ReactNode;
  /** Red hover for destructive icon actions (remove, delete). */
  danger?: boolean;
}

/** Icon-only button over `.btn .btn-icon`: one size, one hover, a required label. */
export function IconButton({ label, icon, danger, className, title, ...rest }: IconButtonProps) {
  const classes = ["btn", "btn-icon", danger ? "danger-hover" : "", className ?? ""]
    .filter(Boolean)
    .join(" ");
  return (
    <button type="button" className={classes} aria-label={label} title={title ?? label} {...rest}>
      <span className="btn-icon-glyph" aria-hidden="true">
        {icon}
      </span>
    </button>
  );
}
