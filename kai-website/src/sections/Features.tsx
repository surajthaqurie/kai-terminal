import { Card, Section, SectionHead } from '../components/ui';
import { FEATURES } from '../data/site';

export function Features() {
  return (
    <Section id="features">
      <SectionHead
        title="A terminal that just works"
        sub="Fast, simple, and private. Everything you need, nothing you don't."
      />
      <div className="t-grid-3">
        {FEATURES.map((f) => (
          <Card key={f.title} hover>
            <span className="t-tag">{f.tag}</span>
            <div className={`t-icon ${f.tone}`}>
              <f.icon size={24} />
            </div>
            <h3>{f.title}</h3>
            <p>{f.body}</p>
          </Card>
        ))}
      </div>
    </Section>
  );
}
