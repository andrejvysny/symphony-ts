import { useCallback, useEffect, useRef, useState } from 'preact/hooks';
import {
  api,
  type BoardData,
  type BoardIssueDTO,
  type BoardStateDTO,
  type SessionInfo,
} from './api.js';

export function App() {
  const [board, setBoard] = useState<BoardData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showCreate, setShowCreate] = useState(false);
  const [showSessions, setShowSessions] = useState(false);
  const [logIssue, setLogIssue] = useState<{ id: string; identifier: string } | null>(null);

  const refresh = useCallback(async () => {
    try {
      setBoard(await api.board());
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    }
  }, []);

  useEffect(() => {
    void refresh();
    const t = setInterval(() => void refresh(), 2000);
    return () => clearInterval(t);
  }, [refresh]);

  const move = async (issueId: string, stateId: string) => {
    try {
      await api.moveIssue(issueId, stateId);
      await refresh();
    } catch (e) {
      setError((e as Error).message);
    }
  };

  const states = board?.states ?? [];

  return (
    <div>
      <header>
        <h1>🎼 Symphony</h1>
        <span class="muted" data-test="status">
          {board ? `${states.length} columns` : 'connecting…'}
        </span>
        <span class="spacer" />
        <button class="primary" data-test="new-ticket" onClick={() => setShowCreate(true)}>
          + New ticket
        </button>
        <button data-test="sessions-btn" onClick={() => setShowSessions(true)}>
          Sessions
        </button>
      </header>

      {error && <div class="err-banner">⚠ {error}</div>}

      <div class="board" data-test="board">
        {states.map((s) => (
          <Column key={s.id} state={s} issues={board?.columns[s.name] ?? []} onDrop={move} />
        ))}
      </div>

      {showCreate && (
        <CreateTicketModal
          states={states}
          onClose={() => setShowCreate(false)}
          onCreated={() => {
            setShowCreate(false);
            void refresh();
          }}
        />
      )}

      {showSessions && (
        <SessionsDrawer onClose={() => setShowSessions(false)} onOpenLogs={setLogIssue} />
      )}

      {logIssue && <LogConsole issue={logIssue} onClose={() => setLogIssue(null)} />}
    </div>
  );
}

function Column(props: {
  state: BoardStateDTO;
  issues: BoardIssueDTO[];
  onDrop: (issueId: string, stateId: string) => void;
}) {
  const [over, setOver] = useState(false);
  return (
    <section
      class={`col${over ? ' dragover' : ''}`}
      data-test={`col-${props.state.name}`}
      onDragOver={(e) => {
        e.preventDefault();
        setOver(true);
      }}
      onDragLeave={() => setOver(false)}
      onDrop={(e) => {
        e.preventDefault();
        setOver(false);
        const id = e.dataTransfer?.getData('text/plain');
        if (id) props.onDrop(id, props.state.id);
      }}
    >
      <h2>
        <span>{props.state.name}</span>
        <span>{props.issues.length}</span>
      </h2>
      {props.issues.length === 0 && <div class="empty">none</div>}
      {props.issues.map((i) => (
        <Card key={i.id} issue={i} />
      ))}
    </section>
  );
}

function Card(props: { issue: BoardIssueDTO }) {
  const i = props.issue;
  return (
    <div
      class="card"
      data-test="card"
      data-issue={i.id}
      draggable
      onDragStart={(e) => e.dataTransfer?.setData('text/plain', i.id)}
    >
      <div class="id">{i.identifier}</div>
      <div class="title">{i.title}</div>
      <div class="row">
        {i.status !== 'idle' && (
          <span class={`badge ${i.status}`} data-test={`badge-${i.status}`}>
            {i.status}
          </span>
        )}
        {i.priority !== null && <span class="badge">P{i.priority}</span>}
      </div>
    </div>
  );
}

function CreateTicketModal(props: {
  states: BoardStateDTO[];
  onClose: () => void;
  onCreated: () => void;
}) {
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [stateId, setStateId] = useState(props.states[0]?.id ?? '');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const submit = async () => {
    if (!title.trim()) {
      setErr('Title is required');
      return;
    }
    setBusy(true);
    setErr(null);
    try {
      const form = new FormData();
      form.set('title', title);
      if (description) form.set('description', description);
      if (stateId) form.set('stateId', stateId);
      for (const f of fileRef.current?.files ?? []) form.append('files', f, f.name);
      await api.createTicket(form);
      props.onCreated();
    } catch (e) {
      setErr((e as Error).message);
      setBusy(false);
    }
  };

  return (
    <div class="overlay" onClick={props.onClose}>
      <div class="modal" data-test="create-modal" onClick={(e) => e.stopPropagation()}>
        <h3>New ticket</h3>
        {err && <div class="err-banner">{err}</div>}
        <label>Title</label>
        <input
          data-test="ticket-title"
          value={title}
          onInput={(e) => setTitle((e.target as HTMLInputElement).value)}
        />
        <label>Description (markdown)</label>
        <textarea
          data-test="ticket-desc"
          value={description}
          onInput={(e) => setDescription((e.target as HTMLTextAreaElement).value)}
        />
        <label>State</label>
        <select
          data-test="ticket-state"
          value={stateId}
          onChange={(e) => setStateId((e.target as HTMLSelectElement).value)}
        >
          {props.states.map((s) => (
            <option key={s.id} value={s.id}>
              {s.name}
            </option>
          ))}
        </select>
        <label>Attachments</label>
        <input type="file" multiple ref={fileRef} data-test="ticket-files" />
        <div class="actions">
          <button onClick={props.onClose}>Cancel</button>
          <button class="primary" data-test="create-submit" disabled={busy} onClick={submit}>
            {busy ? 'Creating…' : 'Create'}
          </button>
        </div>
      </div>
    </div>
  );
}

function SessionsDrawer(props: {
  onClose: () => void;
  onOpenLogs: (i: { id: string; identifier: string }) => void;
}) {
  const [sessions, setSessions] = useState<SessionInfo[]>([]);
  const load = useCallback(async () => {
    try {
      setSessions((await api.sessions()).sessions);
    } catch {
      /* ignore */
    }
  }, []);
  useEffect(() => {
    void load();
    const t = setInterval(() => void load(), 2000);
    return () => clearInterval(t);
  }, [load]);

  return (
    <div class="drawer" data-test="sessions-drawer">
      <header>
        <h1>Sessions ({sessions.length})</h1>
        <span class="spacer" />
        <button
          class="danger"
          data-test="terminate-all"
          onClick={async () => {
            await api.terminateAll();
            await load();
          }}
        >
          Terminate all
        </button>
        <button onClick={props.onClose}>Close</button>
      </header>
      <div class="body">
        {sessions.length === 0 && <div class="empty">no running sessions</div>}
        {sessions.map((s) => (
          <div class="session" data-test="session" key={s.issue_id}>
            <div class="id">{s.issue_identifier}</div>
            <div class="muted">
              {s.state} · turn {s.turn_count} · {s.tokens.total_tokens} tok · {s.last_event ?? '—'}
              {s.tmux_session ? ` · tmux:${s.tmux_session}` : ''}
            </div>
            <div class="row" style="margin-top:6px;display:flex;gap:6px">
              <button
                data-test="open-logs"
                onClick={() => props.onOpenLogs({ id: s.issue_id, identifier: s.issue_identifier })}
              >
                Logs
              </button>
              <button
                class="danger"
                data-test="terminate"
                onClick={async () => {
                  await api.terminate(s.issue_id);
                  await load();
                }}
              >
                Terminate
              </button>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function LogConsole(props: { issue: { id: string; identifier: string }; onClose: () => void }) {
  const [lines, setLines] = useState<{ cls: string; text: string }[]>([]);
  const boxRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const es = api.logStream(props.issue.id);
    es.onmessage = (m) => {
      try {
        const ev = JSON.parse(m.data) as {
          type: string;
          text?: string;
          toolName?: string;
          error?: string;
        };
        let cls = 'sys';
        let text = ev.type;
        if (ev.type === 'text_delta') {
          cls = '';
          text = ev.text ?? '';
        } else if (ev.type === 'tool_use') {
          cls = 'tool';
          text = `→ ${ev.toolName}`;
        } else if (ev.type === 'turn_failed') {
          cls = 'err';
          text = `turn failed: ${ev.error ?? ''}`;
        }
        setLines((l) => [...l.slice(-499), { cls, text }]);
      } catch {
        /* ignore */
      }
    };
    es.onerror = () => setLines((l) => [...l, { cls: 'sys', text: '[stream closed]' }]);
    return () => es.close();
  }, [props.issue.id]);

  useEffect(() => {
    if (boxRef.current) boxRef.current.scrollTop = boxRef.current.scrollHeight;
  }, [lines]);

  return (
    <div class="overlay" onClick={props.onClose}>
      <div class="modal" style="width:720px" onClick={(e) => e.stopPropagation()}>
        <h3>
          Live logs — {props.issue.identifier}{' '}
          <span class="muted">(tmux attach -t symphony-{props.issue.identifier})</span>
        </h3>
        <div class="console" data-test="log-console" ref={boxRef}>
          {lines.length === 0 && <div class="empty">waiting for events…</div>}
          {lines.map((l, n) => (
            <p key={n} class={`line ${l.cls}`}>
              {l.text}
            </p>
          ))}
        </div>
        <div class="actions">
          <button onClick={props.onClose}>Close</button>
        </div>
      </div>
    </div>
  );
}
