import { HelpCircle } from 'lucide-react';
import { PageHero } from '../components/PageHero';
import { Faq } from '../sections/Faq';
import { CtaBanner } from '../components/CtaBanner';

export function FaqPage() {
  return (
    <>
      <PageHero
        badge={<><HelpCircle size={14} /> FAQ</>}
        title="FAQ"
        sub="What Kai is, how to install it, and which file to pick."
      />
      <Faq />
      <CtaBanner />
    </>
  );
}
