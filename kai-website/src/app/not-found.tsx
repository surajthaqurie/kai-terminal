import { NotFoundPage } from '../views/NotFound';
import { metadataFor } from '../lib/seo';

export const metadata = metadataFor('/404');

export default function NotFound() {
  return <NotFoundPage />;
}
