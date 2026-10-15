'use client';

import { useState } from 'react';
import { Check, Copy } from 'lucide-react';

export function useCopy(text: string) {
  const [ok, setOk] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      const ta = document.createElement('textarea');
      ta.value = text;
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      ta.remove();
    }
    setOk(true);
    setTimeout(() => setOk(false), 1400);
  };
  return { ok, copy };
}

export function CopyBtn({ text }: { text: string }) {
  const { ok, copy } = useCopy(text);
  return (
    <button type="button" className="t-copy" onClick={copy} aria-label="Copy to clipboard" title="Copy">
      {ok ? <Check size={15} /> : <Copy size={15} />}
    </button>
  );
}
