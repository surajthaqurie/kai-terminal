import React, { useEffect, useRef } from 'react';

/* ——— Professional UI primitives built on design tokens ——— */

/* Scroll-reveal wrapper: fades content up the first time it enters view.
   Falls back to visible when IntersectionObserver is unavailable *or*
   when it never fires (jsdom, background tab, buggy driver). In-viewport
   elements are shown immediately so above-the-fold content never sticks
   at opacity:0. */
function isInViewport(el: HTMLElement): boolean {
  try {
    const r = el.getBoundingClientRect();
    const vh = window.innerHeight || document.documentElement.clientHeight || 800;
    return r.top < vh - 48 && r.bottom > 0;
  } catch {
    return true;
  }
}

function useReveal<T extends HTMLElement>() {
  const ref = useRef<T | null>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (typeof IntersectionObserver === 'undefined') {
      el.classList.add('is-visible');
      return;
    }
    // Already on screen (e.g. hero / first sections): show without waiting.
    if (isInViewport(el)) {
      el.classList.add('is-visible');
      return;
    }
    const io = new IntersectionObserver(
      (entries) => {
        entries.forEach((e) => {
          if (e.isIntersecting) {
            e.target.classList.add('is-visible');
            io.unobserve(e.target);
          }
        });
      },
      { threshold: 0.1, rootMargin: '0px 0px -48px 0px' }
    );
    io.observe(el);
    // Safety net: if IO never callbacks but the element scrolls into view,
    // the rAF-throttled check below (and App's global fallback) reveals it.
    const t = setTimeout(() => {
      if (isInViewport(el)) {
        el.classList.add('is-visible');
        io.disconnect();
      }
    }, 1200);
    return () => {
      clearTimeout(t);
      io.disconnect();
    };
  }, []);
  return ref;
}

export function Reveal({
  children,
  className = '',
  delay = 0,
}: {
  children: React.ReactNode;
  className?: string;
  delay?: number;
}) {
  const ref = useReveal<HTMLDivElement>();
  return (
    <div
      ref={ref}
      className={`t-reveal${className ? ` ${className}` : ''}`}
      style={delay ? { transitionDelay: `${delay}ms` } : undefined}
    >
      {children}
    </div>
  );
}

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
      <Container>
        <Reveal>{children}</Reveal>
      </Container>
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
  const ref = useReveal<HTMLDivElement>();
  const cls = `t-reveal t-card${hover ? ' t-card--hover' : ''}${solid ? ' t-card--solid' : ''}`;
  return (
    <div ref={ref} className={cls} style={style}>
      {children}
    </div>
  );
}
