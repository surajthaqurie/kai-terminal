import type { ButtonHTMLAttributes, ReactNode } from "react";

export type ButtonVariant = "primary" | "secondary" | "danger" | "ghost";

interface ButtonProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, "type"> {
  /** `danger` is for irreversible actions only (discard, delete). */
  variant?: ButtonVariant;
  size?: "sm" | "md";
  /** Form submit buttons must opt in; everything else is `type="button"`. */
  type?: "button" | "submit";
  children: ReactNode;
}

/** Text button over the `.btn` classes. Disabled state is styled by `.btn:disabled`. */
export function Button({
  variant = "secondary",
  size = "md",
  type = "button",
  className,
  children,
  ...rest
}: ButtonProps) {
  const classes = ["btn", `btn-${variant}`, size === "sm" ? "btn-small" : "", className ?? ""]
    .filter(Boolean)
    .join(" ");
  return (
    <button type={type} className={classes} {...rest}>
      {children}
    </button>
  );
}
