import { ManualPage } from '../../views/Manual';
import { metadataFor } from '../../lib/seo';

export const metadata = metadataFor('/commands');

export default function Page() {
  return <ManualPage />;
}
