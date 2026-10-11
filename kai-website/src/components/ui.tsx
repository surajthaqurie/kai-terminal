import React, { useEffect, useRef } from 'react';
import { Link } from '../router';

/* Simple reveal: visible by default, animates in once via IO.
   No timers, no probes, no global fallbacks. */

function useReveal<T extends HTMLElement>() {
  const ref = useRef<T | null>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el || typeof IntersectionObserver === 'undefined') return;
    el.classList.add('is-visible');
    const io = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          if (e.isIntersecting) {
            (e.target as HTMLElement).classList.add('is-visible');
            io.disconnect();
          }
        }
      },
      { threshold: 0.1 },
    );
    io.observe(el);
    return () => io.disconnect();
  }, []);
  return ref;
}

export function Reveal({ children, className = '' }: { children: React.ReactNode; className?: string }) {
  const ref = useReveal<HTMLDivElement>();
  // is-visible by default so content never sticks at opacity 0
  return <div ref={ref} className={`t-reveal is-visible${className ? ` ${className}` : ''}`}>{children}</div>;
}

export function Container({ children, narrow }: { children: React.ReactNode; narrow?: boolean }) {
  return <div className={narrow ? 't-container-narrow' : 't-container'}>{children}</div>;
}

type Tone = 'cyan' | 'purple' | 'green' | 'neutral';

export function Badge({ children, tone = 'cyan' }: { children: React.ReactNode; tone?: Tone }) {
  return <div className={tone === 'cyan' ? 't-badge' : `t-badge t-badge--${tone}`}>{children}</div>;
}

export function Button({ children, variant = 'primary', href, onClick, ...rest }: {
  children: React.ReactNode; variant?: 'primary' | 'secondary'; href?: string;
} & React.AnchorHTMLAttributes<HTMLAnchorElement>) {
  if (href && href.startsWith('/') && !href.startsWith('//')) {
    return (
      <Link to={href} className={`t-btn t-btn--${variant}`} onClick={onClick} {...rest}>
        {children}
      </Link>
    );
  }
  return <a href={href} className={`t-btn t-btn--${variant}`} onClick={onClick} {...rest}>{children}</a>;
}

export function Section({ id, alt, children }: { id?: string; alt?: boolean; children: React.ReactNode }) {
  return (
    <section id={id} className={alt ? 't-section t-section-alt' : 't-section'}>
      <Container><Reveal>{children}</Reveal></Container>
    </section>
  );
}

export function SectionHead({ title, sub }: { title: string; sub?: string }) {
  return (
    <div className="t-section-head">
      <h2 className="t-section-title">{title}</h2>
      {sub ? <p className="t-section-sub">{sub}</p> : null}
    </div>
  );
}

export function Card({ children, hover }: { children: React.ReactNode; hover?: boolean }) {
  return <div className={`t-card${hover ? ' t-card--hover' : ''} t-reveal is-visible`}>{children}</div>;
}
