import { Section, SectionHead } from '../components/ui';

/* Real screenshots of the desktop app (sample data, no real accounts).
   Fixed width/height reserve the space, so the page does not jump while they load. */
const SHOTS = [
  {
    src: '/screens/app.png',
    title: 'One window, one header',
    body: 'Tabs, a command palette, AI providers and settings in a single row. The status bar shows your git branch and the version.',
    alt: 'Kai Terminal window running kai health, kai integration list and an AI agent session',
  },
  {
    src: '/screens/teams.png',
    title: 'Microsoft Teams in the terminal',
    body: '`kai teams` opens your chats and channels in the tab you run it in. Click or use the keyboard.',
    alt: 'Kai Terminal running kai teams: teams, channels and chats on the left, a conversation on the right, a message box below',
  },
  {
    src: '/screens/integrations.png',
    title: 'Azure DevOps rules for agents',
    body: 'Type the merge branch and a branch naming pattern. Kai checks the branch exists when you save. Agents follow them for every work item; nothing is blocked.',
    alt: 'The Integrations tab with the Azure DevOps card showing a merge branch field and a branch naming regex field',
  },
];

export function Screens() {
  return (
    <Section id="screens">
      <SectionHead title="See it in action" sub="Real screens from Kai 0.2. Sample projects and people." />
      <div className="t-shots">
        {SHOTS.map((s) => (
          <figure key={s.src} className="t-shot">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={s.src} alt={s.alt} width={1280} height={760} loading="lazy" decoding="async" />
            <figcaption>
              <strong>{s.title}</strong>
              <span>{s.body.replace(/`([^`]+)`/g, '$1')}</span>
            </figcaption>
          </figure>
        ))}
      </div>
    </Section>
  );
}
