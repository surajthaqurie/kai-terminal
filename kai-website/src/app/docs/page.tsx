import { DocsIndexPage } from '../../views/Docs';
import { metadataFor } from '../../lib/seo';

export const metadata = metadataFor('/docs');

export default function Page() {
  return <DocsIndexPage />;
}
