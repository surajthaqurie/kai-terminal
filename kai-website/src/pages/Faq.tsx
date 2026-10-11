import { HelpCircle } from 'lucide-react';
import { PageHero } from '../components/PageHero';
import { Faq } from '../sections/Faq';
import { CtaBanner } from '../components/CtaBanner';

export function FaqPage() {
  return (
    <>
      <PageHero
        badge={<><HelpCircle size={14} /> FAQ</>}
        title="Questions, answered"
        sub="Pricing, privacy, AI setup, and platform coverage — in one place."
      />
      <Faq />
      <CtaBanner />
    </>
  );
}
