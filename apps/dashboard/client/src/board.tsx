import { useState } from 'preact/hooks';
import type {
  BoardData,
  BoardIssueDTO,
  BoardStateDTO,
  RuntimeInfo,
  SessionInfo,
  SnapshotBlocked,
  SnapshotRetry,
} from './api.js';
import { eta, fmtShort, isTerminalState, LiveDot, priorityLabel, StatusPill } from './util.js';

/** Live signals joined onto board issues by issue_id. */
export interface Live {
  sessions: Map<string, SessionInfo>;
  blocked: Map<string, SnapshotBlocked>;
  retry: Map<string, SnapshotRetry>;
  meta: RuntimeInfo | null;
  now: number;
}

export function Board(props: {
  board: BoardData;
  live: Live;
  onMove: (issueId: string, stateId: string) => void;
  onOpen: (issue: BoardIssueDTO) => void;
  onUnblock: (issueId: string) => void;
  onOpenAgent: (issueId: string) => void;
  onAdd: (stateId: string) => void;
}) {
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  // Visible lanes = backlog + active + review (from runtime config). Done (completed) collapses to a
  // rail; Cancelled — and any legacy non-lane state like Rework/Merging — is hidden from the board.
  const meta = props.live.meta;
  const laneNames = meta
    ? new Set([meta.backlog_state, ...meta.active_states, meta.review_state].filter(Boolean))
    : null;
  const isLane = (s: BoardStateDTO) => (laneNames ? laneNames.has(s.name) : !isTerminalState(s));
  const lanes = props.board.states.filter((s) => isLane(s) && !isTerminalState(s));
  const rails = props.board.states.filter((s) => s.type === 'completed');
  const collapsed = rails.filter((s) => !expanded.has(s.id));
  const openTerminals = rails.filter((s) => expanded.has(s.id));
  const toggle = (id: string) =>
    setExpanded((e) => {
      const next = new Set(e);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });

  // States returned by the tracker, plus any column the board grouped under an
  // unknown state name (so issues are never silently dropped from the UI).
  const known = new Set(props.board.states.map((s) => s.name));
  const extras = Object.keys(props.board.columns).filter(
    (name) => !known.has(name) && (props.board.columns[name]?.length ?? 0) > 0,
  );

  return (
    <div class="board" data-test="board">
      {lanes.map((s) => (
        <Lane key={s.id} state={s} issues={props.board.columns[s.name] ?? []} {...props} />
      ))}
      {openTerminals.map((s) => (
        <Lane
          key={s.id}
          state={s}
          issues={props.board.columns[s.name] ?? []}
          onCollapse={() => toggle(s.id)}
          {...props}
        />
      ))}
      {extras.map((name) => (
        <Lane
          key={`extra-${name}`}
          state={{ id: name, name, type: 'unstarted', position: 999 }}
          issues={props.board.columns[name] ?? []}
          droppable={false}
          {...props}
        />
      ))}
      {collapsed.length > 0 && (
        <div class="rails">
          {collapsed.map((s) => (
            <Rail
              key={s.id}
              state={s}
              count={(props.board.columns[s.name] ?? []).length}
              onClick={() => toggle(s.id)}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function Rail(props: { state: BoardStateDTO; count: number; onClick: () => void }) {
  const done = props.state.type === 'completed';
  return (
    <div
      class={`rail${done ? ' done' : ''}`}
      data-test={`rail-${props.state.name}`}
      title="click to expand"
      onClick={props.onClick}
    >
      <span class={`n${props.count === 0 ? ' zero' : ''}`}>{props.count}</span>
      <span class="lbl">{props.state.name}</span>
    </div>
  );
}

function Lane(props: {
  state: BoardStateDTO;
  issues: BoardIssueDTO[];
  live: Live;
  onMove: (issueId: string, stateId: string) => void;
  onOpen: (issue: BoardIssueDTO) => void;
  onUnblock: (issueId: string) => void;
  onOpenAgent: (issueId: string) => void;
  onAdd: (stateId: string) => void;
  onCollapse?: () => void;
  droppable?: boolean;
}) {
  const [over, setOver] = useState(false);
  const hasRunning = props.issues.some((i) => i.status === 'running');
  const hasBlocked = props.issues.some((i) => i.status === 'blocked');
  const started = props.state.type === 'started';
  const wide = hasRunning || hasBlocked;
  const tone = hasRunning ? 'active' : hasBlocked ? 'blocked' : started ? 'review' : '';
  const empty = props.issues.length === 0;
  const droppable = props.droppable !== false;

  return (
    <section class={`lane${wide ? ' wide' : ''}`} data-test={`col-${props.state.name}`}>
      <div class="lane-head">
        <div class={`name${hasRunning ? ' hot' : ''}`}>
          {hasRunning ? <LiveDot /> : <span class="swatch" style={swatch(props.state)} />}
          <span>{props.state.name}</span>
        </div>
        <div style="display:flex;align-items:center;gap:6px">
          <span class={`lane-count${hasRunning || hasBlocked ? ' hot' : ''}`}>
            {props.issues.length}
          </span>
          {props.onCollapse && (
            <button class="lane-collapse" title="collapse" onClick={props.onCollapse}>
              ⟨
            </button>
          )}
        </div>
      </div>
      <div
        class={`lane-body ${tone}${over ? ' dragover' : ''}${empty && !droppable ? ' empty-pad' : ''}`}
        onDragOver={
          droppable
            ? (e) => {
                e.preventDefault();
                setOver(true);
              }
            : undefined
        }
        onDragLeave={droppable ? () => setOver(false) : undefined}
        onDrop={
          droppable
            ? (e) => {
                e.preventDefault();
                setOver(false);
                const id = e.dataTransfer?.getData('text/plain');
                if (id) props.onMove(id, props.state.id);
              }
            : undefined
        }
      >
        {empty && !droppable && <span class="empty">none</span>}
        {props.issues.map((i) => (
          <Card
            key={i.id}
            issue={i}
            live={props.live}
            started={started}
            onOpen={props.onOpen}
            onUnblock={props.onUnblock}
            onOpenAgent={props.onOpenAgent}
          />
        ))}
        {droppable && (
          <button
            class="ghost-card"
            data-test="add-card"
            title={`New ticket in ${props.state.name}`}
            onClick={() => props.onAdd(props.state.id)}
          >
            <span class="ghost-plus">+</span> Add new
          </button>
        )}
      </div>
    </section>
  );
}

function swatch(s: BoardStateDTO) {
  return s.color ? `background:${s.color}` : '';
}

const PLAN_BADGE: Record<string, string> = {
  planning: 'planning…',
  awaiting_input: 'needs input',
  ready: 'plan ready',
  approved: 'approved',
  failed: 'plan failed',
};

function Card(props: {
  issue: BoardIssueDTO;
  live: Live;
  started: boolean;
  onOpen: (issue: BoardIssueDTO) => void;
  onUnblock: (issueId: string) => void;
  onOpenAgent: (issueId: string) => void;
}) {
  const i = props.issue;
  const session = props.live.sessions.get(i.id);
  const blocked = props.live.blocked.get(i.id);
  const retry = props.live.retry.get(i.id);
  const branchPrefix = props.live.meta?.branch_prefix ?? 'symphony/';
  const maxTurns = props.live.meta?.max_turns;
  const maxCont = props.live.meta?.max_continuations ?? 0;
  // The Plan track is offered on Backlog tickets only (read-only planning before implementation).
  const isBacklog = !!props.live.meta && i.state === props.live.meta.backlog_state;

  const open = () => props.onOpen(i);
  const stop = (e: Event) => e.stopPropagation();

  return (
    <div
      class={`card ${i.status}`}
      data-test="card"
      data-issue={i.id}
      draggable
      onClick={open}
      onDragStart={(e) => e.dataTransfer?.setData('text/plain', i.id)}
    >
      <div class="card-top">
        <span class="card-id">{i.identifier}</span>
        <span class="card-top-right">
          {i.labels.includes('rework') && (
            <span class="pill rework" title="sent back for rework">
              rework
            </span>
          )}
          {i.status !== 'idle' && <StatusPill status={i.status} />}
        </span>
      </div>
      <span class="card-title">{i.title}</span>

      {i.status === 'running' && session && (
        <>
          {session.last_action && (
            <div
              class="action"
              title={session.last_action}
              onClick={(e) => {
                stop(e);
                props.onOpenAgent(i.id);
              }}
            >
              ↳ {session.last_action}
              <span class="caret">▍</span>
            </div>
          )}
          <div class="chips">
            <span class="chip">
              turn {session.turn_count}
              {maxTurns ? `/${maxTurns}` : ''}
            </span>
            {session.continuation_count > 0 && (
              <span class="chip">↻ {session.continuation_count}</span>
            )}
            {session.tmux_session ? (
              <span class="chip tmux">⧉ tmux:{session.issue_identifier}</span>
            ) : (
              <span class="chip dim">{session.backend}</span>
            )}
          </div>
        </>
      )}

      {i.status === 'blocked' && (
        <>
          {blocked && <div class="card-note">{blocked.reason}</div>}
          {maxCont > 0 && (
            <div class="chips">
              <span class="chip cap">↻ {maxCont} cap</span>
            </div>
          )}
          <button
            class="btn sm ghost"
            data-test="unblock"
            onClick={(e) => {
              stop(e);
              props.onUnblock(i.id);
            }}
          >
            Unblock
          </button>
        </>
      )}

      {i.status === 'retrying' && retry && (
        <div class="chips">
          <span class="chip retry">retry {retry.attempt}</span>
          <span class="chip plain">backoff {eta(retry.due_at, props.live.now)}</span>
        </div>
      )}

      {i.status === 'idle' && (
        <>
          {props.started && (
            <div class="chips">
              <span class="chip dim">
                {branchPrefix}
                {i.identifier}
              </span>
            </div>
          )}
          {isBacklog && i.plan_status && (
            <div class="card-plan">
              <span class={`plan-badge ${i.plan_status}`}>{PLAN_BADGE[i.plan_status]}</span>
            </div>
          )}
          <CardMeta issue={i} />
        </>
      )}
    </div>
  );
}

function CardMeta(props: { issue: BoardIssueDTO }) {
  const i = props.issue;
  const prio = priorityLabel(i.priority);
  const ts = i.updatedAt ?? i.createdAt;
  // `rework` is rendered as a prominent badge in card-top, not as a generic label chip.
  const labels = i.labels.filter((l) => l !== 'rework');
  if (!prio && labels.length === 0 && !ts) return null;
  return (
    <>
      {(prio || labels.length > 0) && (
        <div class="chips">
          {prio && <span class="chip dim">{prio}</span>}
          {labels.slice(0, 3).map((l) => (
            <span class="chip dim" key={l}>
              {l}
            </span>
          ))}
        </div>
      )}
      {ts && <span class="card-ts">upd {fmtShort(ts)}</span>}
    </>
  );
}
