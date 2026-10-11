import React from 'react';
import { Badge } from './ui';

/* Consistent sub-page header: badge + title + subtitle + optional actions.
   Uses .t-enter (hero entrance) so it animates without depending on reveals. */
export function PageHero({
  badge,
  title,
  sub,
  children,
}: {
  badge: React.ReactNode;
  title: string;
  sub?: string;
  children?: React.ReactNode;
}) {
  return (
    <section className="t-page-hero">
      <div className="t-hero-glow" aria-hidden="true" />
      <div className="t-page-hero-inner">
        <div className="t-enter" style={{ animationDelay: '0ms' }}>
          <Badge>{badge}</Badge>
        </div>
        <h1 className="t-page-title t-enter" style={{ animationDelay: '80ms' }}>{title}</h1>
        {sub ? <p className="t-page-sub t-enter" style={{ animationDelay: '160ms' }}>{sub}</p> : null}
        {children ? <div className="t-enter" style={{ animationDelay: '240ms' }}>{children}</div> : null}
      </div>
    </section>
  );
}
