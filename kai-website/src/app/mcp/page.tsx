import { McpPage } from '../../views/Mcp';
import { metadataFor } from '../../lib/seo';

export const metadata = metadataFor('/mcp');

export default function Page() {
  return <McpPage />;
}
