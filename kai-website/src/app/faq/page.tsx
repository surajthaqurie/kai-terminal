import { FaqPage } from '../../views/Faq';
import { metadataFor, jsonLdFaq } from '../../lib/seo';

export const metadata = metadataFor('/faq');

const FAQ_JSON_LD = jsonLdFaq([
  { q: 'What is Kai?', a: 'Kai is a desktop terminal for macOS, Linux, and Windows (built with Tauri 2 and Rust). MIT licensed.' },
  { q: 'What does it cost? Is there tracking?', a: 'Free. No accounts, no tracking. Your code stays on your machine; connecting Azure DevOps (per folder) or Microsoft Teams is optional, and Shared Agent opens a listener on your network only while sharing is on.' },
  { q: 'Can my AI tool read Azure DevOps?', a: 'Yes. In your project folder, run kai integration azure in any terminal: it signs you in, connects the project from the git remote, wires your AI tools and checks that it works. Access is read-only unless you allow writes per folder with kai integration azure --allow-writes (only you, never an AI agent). A merge branch and a branch naming regex can be set per folder, and agents follow them for each work item; they are guidance, not enforced.' },
  { q: 'Can I use the Claude on my other PC?', a: 'Yes, with Shared Agent (AI Providers, Shared Agent tab). Share your agent with a one-time invite link, or paste a link to chat with another PC’s Claude Code or OpenCode. Shared agents only chat: read-only, in an empty folder, with no access to your files.' },
  { q: 'How do I start?', a: 'Download the installer, run kai open, then run your AI coding tool inside Kai.' },
  { q: 'Which file do I download?', a: 'macOS: .dmg (Apple Silicon or Intel). Linux: .deb, .rpm or .AppImage (x64 and ARM64). Windows: .exe or .msi (64-bit), or the ARM64 .exe.' },
]);

export default function Page() {
  return (
    <>
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify(FAQ_JSON_LD) }} />
      <FaqPage />
    </>
  );
}
