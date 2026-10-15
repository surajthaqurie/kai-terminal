import { ChangelogPage } from '../../views/Changelog';
import { metadataFor } from '../../lib/seo';

export const metadata = metadataFor('/changelog');

export default function Page() {
  return <ChangelogPage />;
}
