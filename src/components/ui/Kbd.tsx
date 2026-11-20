import type { ReactNode } from "react";

interface KbdProps {
  children: ReactNode;
  /** Extra class for a context-specific variant (e.g. `palette-shortcut`). */
  className?: string;
}

/** A keyboard shortcut label, e.g. <Kbd>Ctrl+Shift+P</Kbd>. */
export function Kbd({ children, className }: KbdProps) {
  return <kbd className={className ? `kbd ${className}` : "kbd"}>{children}</kbd>;
}
