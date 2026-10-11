import { HelpCircle } from 'lucide-react';
import { PageHero } from '../components/PageHero';
import { Faq } from '../sections/Faq';
import { CtaBanner } from '../components/CtaBanner';

export function FaqPage() {
  return (
    <>
      <PageHero
        badge={<><HelpCircle size={14} /> FAQ</>}
        title="Simple answers"
        sub="Is it free? Is it private? How do I start? All answered here."
      />
      <Faq />
      <CtaBanner />
    </>
  );
}
