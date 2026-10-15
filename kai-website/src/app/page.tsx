import { HomePage } from '../views/Home';
import { getServerRelease } from '../lib/release';
import { metadataFor } from '../lib/seo';

export const metadata = metadataFor('/');

export default function Page() {
  const rel = getServerRelease();
  return <HomePage rel={rel} />;
}
