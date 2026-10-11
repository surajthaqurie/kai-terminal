/* Small display formatters shared across sections. */

export function fmtSize(bytes: number): string {
  if (!bytes || bytes <= 0) return '';
  if (bytes < 1_048_576) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  return `${(bytes / 1_048_576).toFixed(1)} MB`;
}

export function archLabel(name: string): string {
  const n = name.toLowerCase();
  if (n.includes('arm64') || n.includes('aarch64')) return 'ARM64';
  if (n.includes('amd64') || n.includes('x86_64') || n.includes('x64')) return 'x64';
  return '';
}

export function fmtDate(iso: string): string {
  if (!iso) return '';
  try {
    return new Date(iso).toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' });
  } catch {
    return '';
  }
}

export function notesSnippet(body: string, max = 200): string {
  const clean = body
    .split('\n')
    .map((l) => l.replace(/^#{1,3}\s*/, '').trim())
    .filter((l) => l.length > 0)
    .join(' ');
  if (clean.length <= max) return clean;
  return `${clean.slice(0, max).trimEnd()}…`;
}
