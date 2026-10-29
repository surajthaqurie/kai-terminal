import { FaqPage } from '../../views/Faq';
import { metadataFor, jsonLdFaq } from '../../lib/seo';

export const metadata = metadataFor('/faq');

const FAQ_JSON_LD = jsonLdFaq([
  { q: 'What is Kai?', a: 'Kai is a desktop terminal for macOS, Linux, and Windows (built with Tauri 2 and Rust). MIT licensed.' },
  { q: 'What does it cost? Is there tracking?', a: 'Free. No accounts, no tracking. Your code stays on your machine; connecting Azure DevOps is optional and per folder.' },
  { q: 'Can my AI tool read Azure DevOps?', a: 'Yes. In a Kai Terminal tab in your project folder, run kai integration azure: it signs you in, connects the project from the git remote, wires your AI tools and checks that it works. Access is read-only.' },
  { q: 'How do I start?', a: 'Download the installer, run kai open, then run your AI coding tool inside Kai.' },
  { q: 'Which file do I download?', a: 'macOS: .dmg (Apple Silicon). Linux: .deb or .AppImage. Windows: .exe or .msi (64-bit).' },
]);

export default function Page() {
  return (
    <>
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify(FAQ_JSON_LD) }} />
      <FaqPage />
    </>
  );
}
