import { DownloadPage } from '../../views/Download';
import { getServerRelease } from '../../lib/release';
import { metadataFor } from '../../lib/seo';

export const metadata = metadataFor('/download');

export default function Page() {
  const rel = getServerRelease();
  return <DownloadPage rel={rel} />;
}
