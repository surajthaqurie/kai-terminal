import { Hero } from '../sections/Hero';
import { Workflow } from '../sections/Workflow';
import { Quickstart } from '../sections/Quickstart';
import { Features } from '../sections/Features';
import { AiCli } from '../sections/AiCli';
import { Compare } from '../sections/Compare';
import { Downloads } from '../sections/Downloads';
import { Changelog } from '../sections/Changelog';
import { Faq } from '../sections/Faq';
import { CtaBanner } from '../components/CtaBanner';
import type { LatestRelease } from '../hooks/useRepo';

/* Landing page: product story + guide teaser + conversion CTA.
   Full installers live on /download, full history on /changelog. */
export function HomePage({ rel }: { rel: LatestRelease }) {
  return (
    <>
      <Hero tag={rel.tag} short={rel.short} version={rel.tag} rel={rel} />
      <Workflow />
      <Quickstart />
      <Features />
      <AiCli />
      <Compare />
      <Downloads rel={rel} />
      <Changelog limit={6} />
      <Faq />
      <CtaBanner />
    </>
  );
}
