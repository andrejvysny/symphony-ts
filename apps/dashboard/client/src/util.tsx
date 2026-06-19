import type { ComponentChildren } from 'preact';
import { useRef, useState } from 'preact/hooks';
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

/** Compact token count: "934", "12.3k", "1.2M". */
export function fmtTokens(n: number): string {
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}k`;
  return `${(n / 1_000_000).toFixed(1)}M`;
}

/** USD cost: "$0.04" / "$1.20"; null/0 → null (caller omits it). */
export function fmtCost(usd: number | null | undefined): string | null {
  if (usd === null || usd === undefined || usd <= 0) return null;
  return usd < 1 ? `$${usd.toFixed(2)}` : `$${usd.toFixed(usd < 100 ? 2 : 0)}`;
}

/** Compact "time until" a future ISO instant: "45m", "3h", "2d4h", or "now". */
export function untilReset(iso: string, now: number): string {
  const ms = new Date(iso).getTime() - now;
  if (Number.isNaN(ms) || ms <= 0) return 'now';
  const min = Math.floor(ms / 60000);
  if (min < 60) return `${min}m`;
  const h = Math.floor(min / 60);
  if (h < 24) return `${h}h${min % 60 ? `${min % 60}m` : ''}`;
  const d = Math.floor(h / 24);
  return `${d}d${h % 24 ? `${h % 24}h` : ''}`;
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

/**
 * Terminal states (completed or cancel-type). Note `typeFor` emits `'canceled'` (one L); accept both
 * spellings so Cancelled is correctly classified as terminal (and thus hidden) rather than a lane.
 */
export function isTerminalState(s: BoardStateDTO): boolean {
  return s.type === 'completed' || s.type === 'canceled' || s.type === 'cancelled';
}

/** Cancel-type terminals are hidden from the board entirely (decision: hide Cancelled). */
export function isHiddenState(s: BoardStateDTO): boolean {
  return s.type === 'canceled' || s.type === 'cancelled';
}

export function priorityLabel(p: number | null): string | null {
  if (p === null || p === 0) return null;
  return ['', 'Urgent', 'High', 'Medium', 'Low'][p] ?? `P${p}`;
}

type Theme = 'dark' | 'light';
const THEME_KEY = 'symphony-theme';

/** Current theme from the <html data-theme> the pre-paint script set; dark default. */
function readTheme(): Theme {
  return document.documentElement.dataset.theme === 'light' ? 'light' : 'dark';
}

function applyTheme(t: Theme) {
  document.documentElement.dataset.theme = t;
  try {
    localStorage.setItem(THEME_KEY, t);
  } catch {
    /* storage blocked (private mode) — toggle still works for this session */
  }
}

/** Dark/light toggle. Persists to localStorage; the inline script in index.html
 *  applies the saved choice before first paint (no flash). Defaults to dark. */
export function ThemeToggle() {
  const [theme, setTheme] = useState<Theme>(readTheme);
  const next: Theme = theme === 'dark' ? 'light' : 'dark';
  return (
    <button
      class="iconbtn"
      data-test="theme-toggle"
      title={`Switch to ${next} mode`}
      aria-label={`Switch to ${next} mode`}
      onClick={() => {
        applyTheme(next);
        setTheme(next);
      }}
    >
      {theme === 'dark' ? '☀' : '☾'}
    </button>
  );
}

const DRAWER_WIDTH_KEY = 'symphony-drawer-width';
const DRAWER_DEFAULT_WIDTH = 460;

function clampDrawerWidth(n: number): number {
  return Math.min(Math.max(n, 360), Math.min(window.innerWidth * 0.96, 1100));
}

function readDrawerWidth(): number {
  try {
    const n = parseInt(localStorage.getItem(DRAWER_WIDTH_KEY) ?? '', 10);
    return Number.isFinite(n) ? clampDrawerWidth(n) : DRAWER_DEFAULT_WIDTH;
  } catch {
    return DRAWER_DEFAULT_WIDTH;
  }
}

function persistDrawerWidth(n: number): void {
  try {
    localStorage.setItem(DRAWER_WIDTH_KEY, String(Math.round(n)));
  } catch {
    /* storage blocked (private mode) — resize still works for this session */
  }
}

/**
 * Drag-to-resize for the right-anchored agent drawer. Returns the current width + handle props
 * (pointer-capture drag, so no window listeners; dragging the left edge widens). Persists to
 * localStorage on release; double-click resets to the default. Mirrors the ThemeToggle storage style.
 */
export function useDrawerWidth() {
  const [width, setWidth] = useState<number>(readDrawerWidth);
  const drag = useRef<{ startX: number; startW: number; latest: number } | null>(null);

  const onPointerDown = (e: PointerEvent) => {
    drag.current = { startX: e.clientX, startW: width, latest: width };
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    document.body.classList.add('resizing-x');
    e.preventDefault();
  };
  const onPointerMove = (e: PointerEvent) => {
    const d = drag.current;
    if (!d) return;
    const next = clampDrawerWidth(d.startW + (d.startX - e.clientX));
    d.latest = next;
    setWidth(next);
  };
  const onPointerUp = (e: PointerEvent) => {
    const d = drag.current;
    if (!d) return;
    drag.current = null;
    (e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId);
    document.body.classList.remove('resizing-x');
    persistDrawerWidth(d.latest);
  };
  const onDblClick = () => {
    setWidth(DRAWER_DEFAULT_WIDTH);
    persistDrawerWidth(DRAWER_DEFAULT_WIDTH);
  };

  return { width, handleProps: { onPointerDown, onPointerMove, onPointerUp, onDblClick } };
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
