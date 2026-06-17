import { useCallback, useEffect, useMemo, useState } from 'preact/hooks';
import {
  api,
  type BoardData,
  type BoardIssueDTO,
  type RuntimeInfo,
  type SessionInfo,
  type StateSnapshot,
} from './api.js';
import { Board, type Live } from './board.js';
import { AgentDrawer, AgentsView } from './agents.js';
import { CreateTicketModal, TicketModal } from './modals.js';
import { LiveDot } from './util.js';

export function App() {
  const [board, setBoard] = useState<BoardData | null>(null);
  const [snap, setSnap] = useState<StateSnapshot | null>(null);
  const [sessions, setSessions] = useState<SessionInfo[]>([]);
  const [meta, setMeta] = useState<RuntimeInfo | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState<'board' | 'agents'>('board');
  const [showCreate, setShowCreate] = useState(false);
  const [selected, setSelected] = useState<BoardIssueDTO | null>(null);
  const [agentIssueId, setAgentIssueId] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const [b, st, ss] = await Promise.all([api.board(), api.state(), api.sessions()]);
      setBoard(b);
      setSnap(st);
      setSessions(ss.sessions);
      setNow(Date.now());
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    }
  }, []);

  useEffect(() => {
    void refresh();
    void api
      .meta()
      .then(setMeta)
      .catch(() => undefined);
    const poll = setInterval(() => void refresh(), 2000);
    const tick = setInterval(() => setNow(Date.now()), 1000);
    return () => {
      clearInterval(poll);
      clearInterval(tick);
    };
  }, [refresh]);

  const sessionsById = useMemo(() => new Map(sessions.map((s) => [s.issue_id, s])), [sessions]);
  const issuesById = useMemo(() => {
    const m = new Map<string, BoardIssueDTO>();
    for (const list of Object.values(board?.columns ?? {})) for (const i of list) m.set(i.id, i);
    return m;
  }, [board]);

  const live: Live = useMemo(
    () => ({
      sessions: sessionsById,
      blocked: new Map((snap?.blocked ?? []).map((b) => [b.issue_id, b])),
      retry: new Map((snap?.retrying ?? []).map((r) => [r.issue_id, r])),
      meta,
      now,
    }),
    [sessionsById, snap, meta, now],
  );

  const move = async (issueId: string, stateId: string) => {
    try {
      await api.moveIssue(issueId, stateId);
      await refresh();
    } catch (e) {
      setError((e as Error).message);
    }
  };
  const unblock = async (issueId: string) => {
    try {
      await api.unblock(issueId);
      await refresh();
    } catch (e) {
      setError((e as Error).message);
    }
  };

  const states = board?.states ?? [];
  const running = sessions.length;
  const maxAgents = meta?.max_concurrent_agents ?? 0;
  const pollSec = meta ? Math.round(meta.poll_interval_ms / 1000) : null;
  const bars = Math.min(Math.max(maxAgents, running, 1), 8);

  return (
    <div class="app">
      <header class="topbar">
        <div class="left">
          <div class="brand">
            <span class="mark">
              <i />
            </span>
            <b>Symphony</b>
          </div>
          <span class="sep" />
          <span class="topmeta">
            {states.length} states{pollSec !== null ? ` · poll ${pollSec}s` : ''}
            {meta ? ` · ${meta.backend}` : ''}
          </span>
        </div>
        <div class="right">
          <div class="gauge" data-test="capacity">
            {running > 0 ? <LiveDot /> : <span class="swatch" style="background:var(--faint)" />}
            <span class="val">
              {running}
              <span> / {maxAgents || '—'}</span>
            </span>
            <span class="cap">running</span>
            <span class="bars">
              {Array.from({ length: bars }, (_, k) => (
                <i key={k} class={k < running ? 'on' : ''} />
              ))}
            </span>
          </div>
          <div class="tabs">
            <button class={tab === 'board' ? 'on' : ''} onClick={() => setTab('board')}>
              Board
            </button>
            <button
              class={tab === 'agents' ? 'on' : ''}
              data-test="tab-agents"
              onClick={() => setTab('agents')}
            >
              Agents
            </button>
          </div>
          <button class="btn primary" data-test="new-ticket" onClick={() => setShowCreate(true)}>
            + New ticket
          </button>
        </div>
      </header>

      {error && <div class="err-banner">⚠ {error}</div>}

      {!board && !error && <div class="center">connecting…</div>}

      {board && tab === 'board' && (
        <Board
          board={board}
          live={live}
          onMove={move}
          onOpen={setSelected}
          onUnblock={unblock}
          onOpenAgent={setAgentIssueId}
        />
      )}

      {board && tab === 'agents' && (
        <AgentsView
          sessions={sessions}
          issuesById={issuesById}
          now={now}
          onOpen={setAgentIssueId}
        />
      )}

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

      {selected && (
        <TicketModal
          issue={selected}
          states={states}
          session={sessionsById.get(selected.id)}
          meta={meta}
          onClose={() => setSelected(null)}
          onChanged={() => void refresh()}
        />
      )}

      {agentIssueId && (
        <AgentDrawer
          issueId={agentIssueId}
          session={sessionsById.get(agentIssueId)}
          issue={issuesById.get(agentIssueId)}
          meta={meta}
          now={now}
          onClose={() => setAgentIssueId(null)}
          onAfterAction={() => void refresh()}
        />
      )}
    </div>
  );
}
