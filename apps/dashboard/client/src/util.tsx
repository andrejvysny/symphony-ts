import type { ComponentChildren } from 'preact';
import type { BoardStateDTO, IssueActivityDTO, IssueStatus } from './api.js';

/** Full local timestamp, or em-dash for missing. */
export function fmt(iso?: string | null): string {
  if (!iso) return '—';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '—' : d.toLocaleString();
}

/** Compact "Jun 17, 13:42"-style stamp. */
export function fmtShort(iso?: string | null): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

/** "HH:MM:SS" wall-clock portion of an ISO stamp (drawer activity log). */
export function clock(iso?: string | null): string {
  if (!iso) return '';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleTimeString(undefined, { hour12: false });
}

/** Whole seconds since `iso` relative to `now` (ms), clamped at 0. */
export function secondsSince(iso: string | null, now: number): number {
  if (!iso) return 0;
  const t = new Date(iso).getTime();
  return Number.isNaN(t) ? 0 : Math.max(0, Math.floor((now - t) / 1000));
}

/** Humanize a second-count: "2m13s" / "45s" / "1h04m". */
export function dur(totalSec: number): string {
  if (totalSec < 60) return `${totalSec}s`;
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  if (m < 60) return `${m}m${String(s).padStart(2, '0')}s`;
  const h = Math.floor(m / 60);
  return `${h}h${String(m % 60).padStart(2, '0')}m`;
}

/** "m:ss" countdown to a future ISO instant (retry backoff ETA). */
export function eta(iso: string, now: number): string {
  const ms = new Date(iso).getTime() - now;
  if (Number.isNaN(ms) || ms <= 0) return 'now';
  const s = Math.round(ms / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

export function describeActivity(a: IssueActivityDTO): string {
  if (a.verb === 'created' && !a.field) return 'created the ticket';
  if (a.field === 'state') return `state: ${a.oldValue ?? '∅'} → ${a.newValue ?? '∅'}`;
  if (a.field) return `${a.field}: ${a.oldValue ?? '∅'} → ${a.newValue ?? '∅'}`;
  return a.verb;
}

/** Terminal lanes (completed/cancelled) collapse to vertical rails in Option A. */
export function isTerminalState(s: BoardStateDTO): boolean {
  return s.type === 'completed' || s.type === 'cancelled';
}

export function priorityLabel(p: number | null): string | null {
  if (p === null || p === 0) return null;
  return ['', 'Urgent', 'High', 'Medium', 'Low'][p] ?? `P${p}`;
}

/** Live ping dot (animated) — used for running agents/lanes. */
export function LiveDot() {
  return <span class="live" />;
}

/** Solid pulsing dot — compact running indicator. */
export function PulseDot() {
  return <span class="pulse-dot" />;
}

const PILL_TEXT: Record<Exclude<IssueStatus, 'idle'>, string> = {
  running: 'RUNNING',
  blocked: 'NEEDS OPERATOR',
  retrying: 'RETRY',
  paused: 'PAUSED',
};

export function StatusPill(props: { status: IssueStatus; children?: ComponentChildren }) {
  if (props.status === 'idle') return null;
  return (
    <span class={`pill ${props.status}`}>
      {props.status === 'running' && <PulseDot />}
      {props.children ?? PILL_TEXT[props.status]}
    </span>
  );
}
