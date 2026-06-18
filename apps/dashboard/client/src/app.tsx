import { useCallback, useEffect, useMemo, useState } from 'preact/hooks';
import {
  api,
  type BoardData,
  type BoardIssueDTO,
  type Capabilities,
  type ProjectDTO,
  type RuntimeInfo,
  type SessionInfo,
  type StateSnapshot,
} from './api.js';
import { Board, type Live } from './board.js';
import { AgentDrawer, AgentsView } from './agents.js';
import { CreateTicketModal, TicketModal } from './modals.js';
import { CreateProjectModal, ProjectSwitcher } from './projects.js';
import { SettingsModal } from './settings.js';
import { LiveDot, ThemeToggle } from './util.js';

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
  const [caps, setCaps] = useState<Capabilities | null>(null);
  const [projects, setProjects] = useState<ProjectDTO[]>([]);
  const [activeProjectId, setActiveProjectId] = useState<string | null>(null);
  const [switching, setSwitching] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [showNewProject, setShowNewProject] = useState(false);

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

  const refreshProjects = useCallback(async () => {
    try {
      const p = await api.projects();
      setProjects(p.projects);
      setActiveProjectId(p.active_project_id);
    } catch {
      /* projects unavailable (no store wired) — switcher stays hidden via caps */
    }
  }, []);

  useEffect(() => {
    void refresh();
    void api
      .meta()
      .then(setMeta)
      .catch(() => undefined);
    void api
      .capabilities()
      .then((c) => {
        setCaps(c);
        if (c.projects) void refreshProjects();
      })
      .catch(() => undefined);
    // Live updates: refetch on each board-changed push (SSE). A 2s poll is the fallback while SSE is
    // down (e.g. a buffering proxy); a slow 15s poll is a safety net even when SSE is healthy.
    let sseHealthy = false;
    const es = api.eventStream();
    es.onopen = () => {
      sseHealthy = true;
    };
    es.onmessage = () => void refresh();
    es.onerror = () => {
      sseHealthy = false;
    };
    const poll = setInterval(() => {
      if (!sseHealthy) void refresh();
    }, 2000);
    const slow = setInterval(() => void refresh(), 15000);
    const tick = setInterval(() => setNow(Date.now()), 1000);
    return () => {
      es.close();
      clearInterval(poll);
      clearInterval(slow);
      clearInterval(tick);
    };
  }, [refresh, refreshProjects]);

  const switchProject = async (projectId: string) => {
    setSwitching(true);
    setError(null);
    try {
      await api.switchProject(projectId);
      await Promise.all([refresh(), refreshProjects()]);
      await api
        .meta()
        .then(setMeta)
        .catch(() => undefined);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSwitching(false);
    }
  };

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
          {caps?.projects && (
            <>
              <span class="sep" />
              <ProjectSwitcher
                projects={projects}
                activeProjectId={activeProjectId}
                switching={switching}
                onSwitch={(id) => void switchProject(id)}
                onNew={() => setShowNewProject(true)}
              />
            </>
          )}
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
          <ThemeToggle />
          {caps?.settings && (
            <button
              class="iconbtn"
              data-test="open-settings"
              title="Settings"
              onClick={() => setShowSettings(true)}
            >
              ⚙
            </button>
          )}
        </div>
      </header>

      {error && <div class="err-banner">⚠ {error}</div>}

      {snap?.merge_failures?.length ? (
        <div class="err-banner" data-test="merge-failures">
          ⚠ Auto-merge failed for {snap.merge_failures.map((m) => m.issue_identifier).join(', ')} —
          the branch is preserved; merge it manually.
        </div>
      ) : null}

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
          onViewRunningAgent={(id) => {
            setSelected(null);
            setTab('agents');
            setAgentIssueId(id);
          }}
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

      {showNewProject && (
        <CreateProjectModal
          onClose={() => setShowNewProject(false)}
          onCreated={() => {
            setShowNewProject(false);
            void refreshProjects();
          }}
        />
      )}

      {showSettings && (
        <SettingsModal
          onClose={() => setShowSettings(false)}
          onSaved={() =>
            void api
              .meta()
              .then(setMeta)
              .catch(() => undefined)
          }
        />
      )}
    </div>
  );
}
