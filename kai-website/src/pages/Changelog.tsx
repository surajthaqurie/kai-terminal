import { ScrollText } from 'lucide-react';
import { PageHero } from '../components/PageHero';
import { Changelog } from '../sections/Changelog';

/* Dedicated history page. Content is fully automatic:
   published releases via GitHub API + pending entries via
   src/generated/changesets.json (written by prebuild). No manual edits. */
export function ChangelogPage() {
  return (
    <>
      <PageHero
        badge={<><ScrollText size={14} /> Auto-synced · GitHub + changesets</>}
        title="Changelog"
        sub="Published releases plus pending unreleased changes. This page updates itself — no manual editing."
      />
      <Changelog limit={20} />
    </>
  );
}
