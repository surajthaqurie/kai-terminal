import { GuidePage } from '../../views/Guide';
import { metadataFor } from '../../lib/seo';

export const metadata = metadataFor('/guide');

export default function Page() {
  return <GuidePage />;
}
