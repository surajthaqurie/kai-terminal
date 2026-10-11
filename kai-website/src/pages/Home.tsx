import { Hero } from '../sections/Hero';
import { Quickstart } from '../sections/Quickstart';
import { Features } from '../sections/Features';
import { AiCli } from '../sections/AiCli';
import { Compare } from '../sections/Compare';
import { Faq } from '../sections/Faq';
import { CtaBanner } from '../components/CtaBanner';
import type { LatestRelease } from '../hooks/useRepo';

/* Landing page: product story + guide teaser + conversion CTA.
   Full installers live on /download, full history on /changelog. */
export function HomePage({ rel }: { rel: LatestRelease }) {
  return (
    <>
      <Hero tag={rel.tag} short={rel.short} version={rel.tag} />
      <Quickstart />
      <Features />
      <AiCli />
      <Compare />
      <Faq />
      <CtaBanner />
    </>
  );
}
