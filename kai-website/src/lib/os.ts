/* Single source of truth for OS detection and labels.
   Used by Hero and InstallBar to suggest the visitor's platform. */

export type OsId = 'macos' | 'linux' | 'windows';

export function detectOs(): OsId {
  if (typeof navigator === 'undefined') return 'linux';
  const p = (navigator.platform ?? '').toLowerCase();
  const ua = navigator.userAgent.toLowerCase();
  if (p.includes('mac') || ua.includes('mac')) return 'macos';
  if (p.includes('win') || ua.includes('windows')) return 'windows';
  return 'linux';
}

export const OS_LABEL: Record<OsId, string> = {
  macos: 'macOS',
  linux: 'Linux',
  windows: 'Windows',
};
