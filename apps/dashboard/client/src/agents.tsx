import { useEffect, useRef, useState } from 'preact/hooks';
import {
  api,
  type BoardIssueDTO,
  type RuntimeInfo,
  type SessionInfo,
  type TodoItem,
} from './api.js';
import { clock, dur, fmtCost, fmtTokens, LiveDot, secondsSince, useDrawerWidth } from './util.js';

interface LogLine {
  cls: string;
  text: string;
  at: string;
}

/** Normalize a TodoWrite tool input into todo items (null if it isn't a todo payload). */
function parseTodos(input: unknown): TodoItem[] | null {
  if (input === null || typeof input !== 'object') return null;
  // `todos` arrives either as an array or as a JSON-encoded string — accept both.
  let raw = (input as { todos?: unknown }).todos;
  if (typeof raw === 'string') {
    try {
      raw = JSON.parse(raw);
    } catch {
      return null;
    }
  }
  if (!Array.isArray(raw)) return null;
  const out: TodoItem[] = [];
  for (const t of raw) {
    if (t === null || typeof t !== 'object') continue;
    const o = t as Record<string, unknown>;
    if (typeof o.content !== 'string' || o.content.trim() === '') continue;
    const status =
      o.status === 'in_progress' || o.status === 'completed' ? o.status : ('pending' as const);
    out.push({
      content: o.content,
      status,
      ...(typeof o.activeForm === 'string' ? { activeForm: o.activeForm } : {}),
    });
  }
  return out.length > 0 ? out : null;
}

/** Subscribe to a session's live event stream (SSE): capped line buffer + the agent's latest plan. */
function useLiveLog(issueId: string): { lines: LogLine[]; todos: TodoItem[] | null } {
  const [lines, setLines] = useState<LogLine[]>([]);
  const [todos, setTodos] = useState<TodoItem[] | null>(null);
  useEffect(() => {
    setLines([]);
    setTodos(null);
    const es = api.logStream(issueId);
    es.onmessage = (m) => {
      try {
        const ev = JSON.parse(m.data) as {
          type: string;
          text?: string;
          toolName?: string;
          input?: unknown;
          error?: string;
          at?: string;
        };
        let cls = 'sys';
        let text = ev.type;
        if (ev.type === 'text_delta') {
          cls = '';
          text = ev.text ?? '';
        } else if (ev.type === 'tool_use') {
          cls = 'tool';
          text = `${ev.toolName}`;
          // The agent's self-managed plan: keep the latest TodoWrite snapshot.
          if (ev.toolName === 'TodoWrite') {
            const parsed = parseTodos(ev.input);
            if (parsed) setTodos(parsed);
          }
        } else if (ev.type === 'turn_failed') {
          cls = 'err';
          text = `turn failed: ${ev.error ?? ''}`;
        } else if (ev.type === 'turn_completed') {
          text = 'turn completed';
        }
        if (text.trim() === '') return;
        setLines((l) => [...l.slice(-299), { cls, text, at: ev.at ?? '' }]);
      } catch {
        /* ignore malformed frame */
      }
    };
    es.onerror = () =>
      setLines((l) => {
        // EventSource auto-reconnects and re-fires onerror; cap and de-dupe the marker.
        if (l[l.length - 1]?.text === '[stream closed]') return l;
        return [...l.slice(-299), { cls: 'sys', text: '[stream closed]', at: '' }];
      });
    return () => es.close();
  }, [issueId]);
  return { lines, todos };
}

export function AgentsView(props: {
  sessions: SessionInfo[];
  issuesById: Map<string, BoardIssueDTO>;
  now: number;
  onOpen: (issueId: string) => void;
}) {
  if (props.sessions.length === 0) {
    return <div class="center">no running agents</div>;
  }
  return (
    <div class="agents" data-test="agents">
      {props.sessions.map((s) => {
        const issue = props.issuesById.get(s.issue_id);
        return (
          <div
            class="agent-card"
            key={s.issue_id}
            data-test="agent"
            onClick={() => props.onOpen(s.issue_id)}
          >
            <div class="card-top">
              <div class="name hot" style="display:flex;align-items:center;gap:8px">
                <LiveDot />
                <span class="card-id" style="color:var(--fg)">
                  {s.issue_identifier}
                </span>
              </div>
              <span class="chip dim">
                {s.backend} · {dur(secondsSince(s.started_at, props.now))}
              </span>
            </div>
            {issue && <span class="card-title">{issue.title}</span>}
            <div class="log">
              ↳ {s.last_action ?? 'waiting…'}
              <span class="caret">▍</span>
            </div>
            <div class="chips">
              <span class="chip">turn {s.turn_count}</span>
              {s.todo_progress && (
                <span class="chip">
                  ☑ {s.todo_progress.done}/{s.todo_progress.total}
                </span>
              )}
              {s.continuation_count > 0 && <span class="chip">↻ {s.continuation_count}</span>}
              {s.tokens.total_tokens > 0 && (
                <span class="chip" title="tokens this run (input+output)">
                  ⛁ {fmtTokens(s.tokens.total_tokens)}
                  {fmtCost(s.tokens.cost_usd) ? ` · ${fmtCost(s.tokens.cost_usd)}` : ''}
                </span>
              )}
              {s.tmux_session && <span class="chip tmux">⧉ tmux:{s.issue_identifier}</span>}
            </div>
          </div>
        );
      })}
    </div>
  );
}

export function AgentDrawer(props: {
  issueId: string;
  session: SessionInfo | undefined;
  issue: BoardIssueDTO | undefined;
  meta: RuntimeInfo | null;
  now: number;
  onClose: () => void;
  onAfterAction: () => void;
}) {
  const s = props.session;
  const { lines, todos: liveTodos } = useLiveLog(props.issueId);
  // Prefer the live SSE-parsed plan; fall back to the server-computed snapshot until the first frame.
  const todos = liveTodos ?? s?.todos ?? null;
  const boxRef = useRef<HTMLDivElement>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const { width, handleProps } = useDrawerWidth();

  useEffect(() => {
    if (boxRef.current) boxRef.current.scrollTop = boxRef.current.scrollHeight;
  }, [lines]);

  const title = props.issue?.title ?? s?.issue_identifier ?? props.issueId;
  const state = props.issue?.state ?? s?.state ?? '';
  const branch = `${props.meta?.branch_prefix ?? 'symphony/'}${s?.issue_identifier ?? props.issue?.identifier ?? ''}`;
  const stallSec = props.meta?.stall_timeout_ms ? props.meta.stall_timeout_ms / 1000 : 0;
  // Mirror the server watchdog, which measures from startedAt until the first event.
  const idleSec = secondsSince(s?.last_event_at ?? s?.started_at ?? null, props.now);
  const stallPct = stallSec > 0 ? Math.min(100, Math.round((idleSec / stallSec) * 100)) : 0;

  const abort = async () => {
    setBusy(true);
    setErr(null);
    try {
      await api.terminate(props.issueId);
      props.onAfterAction();
      props.onClose();
    } catch (e) {
      setErr((e as Error).message);
      setBusy(false);
    }
  };

  return (
    <div class="drawer" data-test="agent-drawer" style={{ width: `${width}px` }}>
      <div class="drawer-resize" data-test="drawer-resize" {...handleProps} />
      <div class="drawer-head">
        <div class="row">
          <div style="display:flex;align-items:center;gap:9px">
            <span class="card-id" style="color:var(--blue)">
              {s?.issue_identifier ?? props.issue?.identifier ?? props.issueId}
            </span>
            {s && (
              <span class="pill running">
                <span class="pulse-dot" />
                RUNNING
              </span>
            )}
          </div>
          <button class="iconbtn" data-test="drawer-close" onClick={props.onClose}>
            ×
          </button>
        </div>
        <span class="ttl">{title}</span>
        <div class="tagrow">
          {s && <span class="tag">{s.backend}</span>}
          <span class="tag">{branch}</span>
          {state && <span class="tag">{state}</span>}
        </div>
      </div>

      {s ? (
        <>
          <div class="stats">
            <div class="stat">
              <span class="n">
                {s.turn_count}
                {props.meta?.max_turns ? <small>/{props.meta.max_turns}</small> : null}
              </span>
              <span class="k">turns</span>
            </div>
            <div class="stat">
              <span class="n">
                {s.continuation_count}
                {props.meta?.max_continuations ? (
                  <small>/{props.meta.max_continuations}</small>
                ) : null}
              </span>
              <span class="k">continuation</span>
            </div>
            <div class="stat">
              <span class="n">{dur(secondsSince(s.started_at, props.now))}</span>
              <span class="k">elapsed</span>
            </div>
            <div class="stat">
              <span class="n">
                {fmtTokens(s.tokens.total_tokens)}
                {fmtCost(s.tokens.cost_usd) ? <small>{fmtCost(s.tokens.cost_usd)}</small> : null}
              </span>
              <span class="k">tokens</span>
            </div>
          </div>

          {stallSec > 0 && (
            <div class="stall">
              <div class="row">
                <span>Stall watchdog</span>
                <span class="ago">last event {idleSec}s ago</span>
              </div>
              <div class={`meter${stallPct >= 60 ? ' warn' : ''}`}>
                <i style={`width:${Math.max(3, stallPct)}%`} />
              </div>
              <span class="foot">reconcile at {Math.round(stallSec / 60)}m idle</span>
            </div>
          )}
        </>
      ) : (
        <div class="stall">
          <span class="foot">session ended — showing last streamed events</span>
        </div>
      )}

      {todos && todos.length > 0 && (
        <div class="plan" data-test="agent-plan">
          <div
            class="label section"
            style="display:flex;justify-content:space-between;align-items:center"
          >
            <span style="font-size:10.5px;font-weight:600;letter-spacing:.08em;text-transform:uppercase;color:var(--muted-2)">
              Plan
            </span>
            <span class="ago">
              {todos.filter((t) => t.status === 'completed').length}/{todos.length}
            </span>
          </div>
          <ul class="todos">
            {todos.map((t, n) => (
              <li key={n} class={`todo ${t.status}`}>
                <span class="box">
                  {t.status === 'completed' ? '✓' : t.status === 'in_progress' ? '▸' : '○'}
                </span>
                <span class="txt">
                  {t.status === 'in_progress' && t.activeForm ? t.activeForm : t.content}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}

      <div class="activity">
        <div class="label section">
          <span style="font-size:10.5px;font-weight:600;letter-spacing:.08em;text-transform:uppercase;color:var(--muted-2)">
            Activity
          </span>
        </div>
        <div class="log" ref={boxRef} data-test="drawer-log">
          {lines.length === 0 && <p class="sys">waiting for events…</p>}
          {lines.map((l, n) => (
            <p key={n} class={l.cls}>
              {l.at && <span style="color:var(--faint-2)">{clock(l.at)} </span>}
              {l.text}
            </p>
          ))}
        </div>
      </div>

      {s?.tmux_session && (
        <div class="tmux">
          <div class="bar">
            <span class="s">
              <i />
              tmux: {s.tmux_session}
            </span>
            <span style="color:var(--blue)">attach ↗</span>
          </div>
          <div class="hint">$ tmux attach -t {s.tmux_session}</div>
        </div>
      )}

      {err && (
        <div class="err-banner" style="flex:none">
          ⚠ {err}
        </div>
      )}
      <div class="drawer-actions">
        <button
          class="btn danger block"
          data-test="drawer-abort"
          disabled={busy || !s}
          onClick={abort}
        >
          {busy ? 'Aborting…' : 'Abort'}
        </button>
      </div>
    </div>
  );
}
