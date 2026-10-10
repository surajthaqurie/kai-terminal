import React from 'react';

/* ——— Professional UI primitives built on design tokens ——— */

export function Container({ children, narrow }: { children: React.ReactNode; narrow?: boolean }) {
  return <div className={narrow ? 't-container-narrow' : 't-container'}>{children}</div>;
}

type BadgeTone = 'cyan' | 'purple' | 'green' | 'neutral';

export function Badge({
  children,
  tone = 'cyan',
}: {
  children: React.ReactNode;
  tone?: BadgeTone;
}) {
  const cls = tone === 'cyan' ? 't-badge' : `t-badge t-badge--${tone}`;
  return <div className={cls}>{children}</div>;
}

type ButtonVariant = 'primary' | 'secondary';
type ButtonSize = 'md' | 'sm';

export function Button({
  children,
  variant = 'primary',
  size = 'md',
  href,
  onClick,
  ...rest
}: {
  children: React.ReactNode;
  variant?: ButtonVariant;
  size?: ButtonSize;
  href?: string;
} & React.AnchorHTMLAttributes<HTMLAnchorElement> &
  React.ButtonHTMLAttributes<HTMLButtonElement>) {
  const cls = `t-btn t-btn--${variant}${size === 'sm' ? ' t-btn--sm' : ''}`;
  if (href !== undefined) {
    return (
      <a href={href} className={cls} onClick={onClick as never} {...(rest as object)}>
        {children}
      </a>
    );
  }
  return (
    <button type="button" className={cls} onClick={onClick as never} {...(rest as object)}>
      {children}
    </button>
  );
}

export function Section({
  id,
  alt,
  children,
}: {
  id?: string;
  alt?: boolean;
  children: React.ReactNode;
}) {
  return (
    <section id={id} className={alt ? 't-section t-section-alt' : 't-section'}>
      <Container>{children}</Container>
    </section>
  );
}

export function SectionHead({
  badge,
  title,
  sub,
}: {
  badge?: React.ReactNode;
  title: string;
  sub?: string;
}) {
  return (
    <div className="t-section-head">
      {badge}
      <h2 className="t-section-title">{title}</h2>
      {sub ? <p className="t-section-sub">{sub}</p> : null}
    </div>
  );
}

export function Card({
  children,
  hover,
  solid,
  style,
}: {
  children: React.ReactNode;
  hover?: boolean;
  solid?: boolean;
  style?: React.CSSProperties;
}) {
  const cls = `t-card${hover ? ' t-card--hover' : ''}${solid ? ' t-card--solid' : ''}`;
  return (
    <div className={cls} style={style}>
      {children}
    </div>
  );
}
