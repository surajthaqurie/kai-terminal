import { Hero } from '../sections/Hero';
import { Workflow } from '../sections/Workflow';
import { Features } from '../sections/Features';
import { AiCli } from '../sections/AiCli';
import { Compare } from '../sections/Compare';
import { CtaBanner } from '../components/CtaBanner';
import type { LatestRelease } from '../hooks/useRepo';

/* Landing page: focused product narrative, live terminal preview, feature architecture,
   and comparison. Dedicated pages handle Downloads (/download), Setup Guide (/guide),
   User Manual (/manual), Changelog (/changelog), and FAQ (/faq). */
export function HomePage({ rel }: { rel: LatestRelease }) {
  return (
    <>
      <Hero tag={rel.tag} short={rel.short} version={rel.tag} rel={rel} />
      <Workflow />
      <Features />
      <AiCli />
      <Compare />
      <CtaBanner />
    </>
  );
}
