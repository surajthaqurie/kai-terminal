import type { ReactNode } from "react";

/** The one severity vocabulary shared by Badge, Banner and toasts. */
export type Tone = "neutral" | "info" | "success" | "warning" | "danger";

interface BadgeProps {
  tone?: Tone;
  children: ReactNode;
  title?: string;
}

/** Small status label. Pair colour with words: the text must carry the meaning. */
export function Badge({ tone = "neutral", children, title }: BadgeProps) {
  return (
    <span className={`badge badge-${tone}`} title={title}>
      {children}
    </span>
  );
}
