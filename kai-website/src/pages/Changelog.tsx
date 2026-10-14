import { ScrollText } from 'lucide-react';
import { PageHero } from '../components/PageHero';
import { Changelog } from '../sections/Changelog';
import { CtaBanner } from '../components/CtaBanner';

/* Dedicated history page. Content is automatic:
   published releases via GitHub API. No manual edits. */
export function ChangelogPage() {
  return (
    <>
      <PageHero
        badge={<><ScrollText size={14} /> Changelog</>}
        title="What's new in Kai"
        sub="Release notes. Newest first."
      />
      <Changelog limit={20} showHead={false} />
      <CtaBanner />
    </>
  );
}
