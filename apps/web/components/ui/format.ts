/**
 * Display-only formatters. No deps to keep edge bundles lean.
 */

export function formatRelative(date: Date | string | null | undefined): string {
  if (!date) return '—';
  const d = typeof date === 'string' ? new Date(date) : date;
  const ms = Date.now() - d.getTime();
  const min = Math.round(ms / 60_000);
  if (min < 1) return 'just now';
  if (min < 60) return `${min}m ago`;
  const hrs = Math.round(min / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.round(hrs / 24);
  if (days < 7) return `${days}d ago`;
  return d.toLocaleDateString();
}

export function formatUsd(n: number): string {
  if (Number.isNaN(n)) return '$0.00';
  if (n < 1) return `$${n.toFixed(4)}`;
  if (n < 100) return `$${n.toFixed(2)}`;
  return `$${Math.round(n).toLocaleString()}`;
}

export function truncate(s: string | null | undefined, len = 80): string {
  if (!s) return '';
  if (s.length <= len) return s;
  return s.slice(0, len - 1) + '…';
}
