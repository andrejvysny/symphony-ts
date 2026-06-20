import { useCallback, useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { api, type BoardData, type BoardIssueDTO, type OrderDTO, type RuntimeInfo } from './api.js';
import { renderMd } from './markdown.js';
import { QuestionCard } from './plan.js';

/** Live agent log for an ordering run (SSE keyed by runId). */
function useOrderLog(runId: string | null, active: boolean): string[] {
  const [lines, setLines] = useState<string[]>([]);
  useEffect(() => {
    if (!runId || !active) return;
    setLines([]);
    const es = api.orderLogStream(runId);
    es.onmessage = (m) => {
      try {
        const ev = JSON.parse(m.data) as { type: string; text?: string; toolName?: string };
        let text = '';
        if (ev.type === 'text_delta') text = ev.text ?? '';
        else if (ev.type === 'tool_use') text = `\n· ${ev.toolName}\n`;
        if (text === '') return;
        setLines((l) => [...l.slice(-199), text]);
      } catch {
        /* ignore malformed frame */
      }
    };
    return () => es.close();
  }, [runId, active]);
  return lines;
}

const STEPS: Array<{ key: 'analyzing' | 'review'; label: string; num: string }> = [
  { key: 'analyzing', label: 'Analyze', num: '1' },
  { key: 'review', label: 'Review & order', num: '2' },
];

/** A run is still resumable (not yet a terminal artifact state) — the tab reopens it on load. */
function isLiveRun(o: OrderDTO): boolean {
  return o.status === 'ordering' || o.status === 'awaiting_input' || o.status === 'ready';
}

export function SequenceView(props: {
  board: BoardData;
  meta: RuntimeInfo | null;
  onChanged: () => void;
}) {
  const backlogName = props.meta?.backlog_state ?? 'Backlog';
  const entryLane = props.meta?.active_states?.[0] ?? 'Todo';
  const backlog = useMemo<BoardIssueDTO[]>(
    () => props.board.columns[backlogName] ?? [],
    [props.board, backlogName],
  );
  const titleById = useMemo(() => {
    const m = new Map<string, BoardIssueDTO>();
    for (const list of Object.values(props.board.columns)) for (const i of list) m.set(i.id, i);
    return m;
  }, [props.board]);

  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [instructions, setInstructions] = useState('');
  const [runId, setRunId] = useState<string | null>(null);
  const [order, setOrder] = useState<OrderDTO | null>(null);
  const [seq, setSeq] = useState<string[]>([]); // local (drag-reorderable) order in the Review phase
  const [answers, setAnswers] = useState<Record<string, string | string[]>>({});
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);

  // On mount, resume the most recent still-live ordering run (survives a page refresh).
  useEffect(() => {
    let cancelled = false;
    void api
      .listOrders()
      .then((runs) => {
        if (cancelled) return;
        const live = runs.find(isLiveRun);
        if (live) {
          setRunId(live.runId);
          setOrder(live);
        }
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, []);

  // Poll the active run while it is analyzing / awaiting input (the live phases).
  useEffect(() => {
    if (!runId) return;
    let stop = false;
    const tick = () =>
      api
        .getOrder(runId)
        .then((o) => {
          if (stop || !o) return;
          setOrder(o);
        })
        .catch(() => undefined);
    void tick();
    const id = setInterval(() => {
      if (order && order.status !== 'ordering' && order.status !== 'awaiting_input') return;
      void tick();
    }, 1500);
    return () => {
      stop = true;
      clearInterval(id);
    };
  }, [runId, order?.status]);

  // Seed the local drag order from the proposal whenever a fresh proposal arrives.
  const proposalKey = order?.proposal ? `${order.runId}:${order.revision}` : '';
  useEffect(() => {
    if (order?.proposal) setSeq(order.proposal.order);
  }, [proposalKey]);

  const log = useOrderLog(runId, order?.status === 'ordering');
  const logRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight;
  }, [log]);

  const act = useCallback(
    async (fn: () => Promise<unknown>) => {
      setBusy(true);
      setErr(null);
      try {
        await fn();
        if (runId) {
          const o = await api.getOrder(runId);
          if (o) setOrder(o);
        }
        props.onChanged();
      } catch (e) {
        setErr((e as Error).message);
      } finally {
        setBusy(false);
      }
    },
    [runId, props.onChanged],
  );

  const reset = () => {
    setRunId(null);
    setOrder(null);
    setSeq([]);
    setAnswers({});
    setPicked(new Set());
    setInstructions('');
  };

  // Commit the resolved order. release=true → also queue the batch to the entry lane; release=false →
  // record rank + dependencies on the tickets but keep them in Backlog (badges show, nothing dispatches).
  const approve = (runId: string, release: boolean) =>
    act(async () => {
      const r = await api.approveOrder(runId, seq, release);
      if (!r.approved) {
        setErr(r.reason ?? 'approve failed');
        return;
      }
      const n = r.applied ?? seq.length;
      const skip = r.skipped && r.skipped.length ? ` (skipped ${r.skipped.join(', ')})` : '';
      setNote(
        release
          ? `Queued ${n} tickets to ${entryLane}${skip}.`
          : `Applied the order to ${n} backlog tickets — kept in ${backlogName}${skip}.`,
      );
    });

  const toggle = (id: string) =>
    setPicked((s) => {
      const next = new Set(s);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const start = async () => {
    setBusy(true);
    setErr(null);
    try {
      const r = await api.startOrder([...picked], instructions.trim() || undefined);
      if (!r.started || !r.runId) {
        setErr(r.reason ?? 'could not start ordering');
        return;
      }
      setRunId(r.runId);
      const o = await api.getOrder(r.runId);
      if (o) setOrder(o);
      props.onChanged();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  // ---- drag reorder of the review list (native HTML5 DnD, zero-dep) ----
  const dragId = useRef<string | null>(null);
  const [overId, setOverId] = useState<string | null>(null);
  const onDrop = (targetId: string) => {
    const src = dragId.current;
    dragId.current = null;
    setOverId(null);
    if (!src || src === targetId) return;
    setSeq((cur) => {
      const next = cur.filter((x) => x !== src);
      const at = next.indexOf(targetId);
      next.splice(at < 0 ? next.length : at, 0, src);
      return next;
    });
  };

  const edited = useMemo(
    () => order?.proposal && JSON.stringify(seq) !== JSON.stringify(order.proposal.order),
    [seq, order?.proposal],
  );
  const blockedByOf = useMemo(() => {
    const m = new Map<string, string[]>();
    for (const t of order?.proposal?.tickets ?? []) m.set(t.id, t.blockedBy);
    return m;
  }, [order?.proposal]);
  const rationaleOf = useMemo(() => {
    const m = new Map<string, string>();
    for (const t of order?.proposal?.tickets ?? []) m.set(t.id, t.rationale);
    return m;
  }, [order?.proposal]);

  const labelFor = (id: string) =>
    titleById.get(id)?.identifier ?? order?.selected.find((s) => s.id === id)?.identifier ?? id;
  const titleFor = (id: string) =>
    titleById.get(id)?.title ?? order?.selected.find((s) => s.id === id)?.title ?? '';

  const phase: 'analyzing' | 'review' =
    order && (order.status === 'ready' || order.status === 'approved') ? 'review' : 'analyzing';

  // ---------- render ----------
  return (
    <div class="sequence" data-test="sequence">
      <div class="seq-head">
        <div class="seq-title">
          <b>Sequence</b>
          <span class="seq-sub">
            Pick {backlogName} tickets, let an agent resolve dependencies, then queue them in order.
          </span>
        </div>
        {order && (
          <div class="seq-headright">
            <span class={`plan-badge ${order.status}`}>{order.status.replace('_', ' ')}</span>
            <button class="btn sm" disabled={busy} onClick={reset}>
              New ordering
            </button>
          </div>
        )}
      </div>

      {err && <div class="err-banner">⚠ {err}</div>}
      {note && <div class="info-banner">{note}</div>}

      {!order && (
        <SequencePicker
          backlog={backlog}
          picked={picked}
          onToggle={toggle}
          instructions={instructions}
          onInstructions={setInstructions}
          busy={busy}
          onStart={start}
        />
      )}

      {order && (
        <>
          <div class="plan-stepper seq-stepper">
            {STEPS.map((s, idx) => {
              const done = phase === 'review' && s.key === 'analyzing';
              const st = s.key === phase ? 'cur' : done ? 'done' : 'todo';
              return (
                <div class="plan-step-wrap" key={s.key}>
                  <div class={`plan-step ${st}`}>
                    <span class="num">{done ? '✓' : s.num}</span>
                    <span class="lbl">{s.label}</span>
                  </div>
                  {idx === 0 && <span class={`plan-step-line ${done ? 'done' : ''}`} />}
                </div>
              );
            })}
          </div>

          {/* Questions interstitial */}
          {order.status === 'awaiting_input' && order.pendingAsk && (
            <div class="seq-panel">
              <div class="seq-panel-h">The agent needs a decision</div>
              {order.pendingAsk.questions.map((q) => (
                <QuestionCard
                  key={q.id}
                  q={q}
                  value={answers[q.id]}
                  onChange={(v) => setAnswers((a) => ({ ...a, [q.id]: v }))}
                />
              ))}
              <div class="seq-foot">
                <button
                  class="btn ghost"
                  disabled={busy}
                  onClick={() => void act(() => api.cancelOrder(order.runId))}
                >
                  Cancel
                </button>
                <button
                  class="btn primary"
                  disabled={busy || !order.pendingAsk}
                  onClick={() =>
                    void act(() =>
                      api.answerOrderQuestion(order.runId, order.pendingAsk!.id, answers),
                    )
                  }
                >
                  Submit answers
                </button>
              </div>
            </div>
          )}

          {/* Analyzing — live log */}
          {order.status === 'ordering' && (
            <div class="seq-panel">
              <div class="seq-analyzing">
                <span class="ping" /> Analyzing {order.selected.length} tickets…
              </div>
              <div class="log seq-log" ref={logRef}>
                {log.length === 0 ? (
                  <p class="sys">waiting for the agent…</p>
                ) : (
                  log.map((l, n) => <span key={n}>{l}</span>)
                )}
                <span class="caret">▍</span>
              </div>
              <div class="seq-foot">
                <button
                  class="btn ghost"
                  disabled={busy}
                  onClick={() => void act(() => api.cancelOrder(order.runId))}
                >
                  Cancel
                </button>
              </div>
            </div>
          )}

          {/* Failed */}
          {order.status === 'failed' && (
            <div class="seq-panel">
              <div class="err-banner">⚠ Ordering failed: {order.error ?? 'unknown error'}</div>
              <div class="seq-foot">
                <button class="btn" disabled={busy} onClick={reset}>
                  Start over
                </button>
                <button
                  class="btn primary"
                  disabled={busy}
                  onClick={() => void act(() => api.reRunOrder(order.runId))}
                >
                  Retry
                </button>
              </div>
            </div>
          )}

          {/* Review / approved — the drag-reorder list */}
          {(order.status === 'ready' || order.status === 'approved') && order.proposal && (
            <div class="seq-panel">
              {order.proposal.summary && (
                <div class="seq-summary">{renderMd(order.proposal.summary)}</div>
              )}
              {order.status === 'approved' && (
                <div class="info-banner" data-test="seq-approved">
                  {order.released === false
                    ? `✓ Order applied — the tickets keep their #position + dependencies and stay in ${backlogName}. Move them to ${entryLane} when you're ready to run them.`
                    : `✓ Queued in order. The tickets moved to ${entryLane} and will run respecting their dependencies.`}
                </div>
              )}
              <ol class="seq-list" data-test="seq-list">
                {seq.map((id, k) => {
                  const deps = (blockedByOf.get(id) ?? []).filter((b) => seq.indexOf(b) > k);
                  return (
                    <li
                      key={id}
                      class={`seq-row${overId === id ? ' dragover' : ''}`}
                      draggable={order.status === 'ready'}
                      onDragStart={() => {
                        dragId.current = id;
                      }}
                      onDragOver={(e) => {
                        e.preventDefault();
                        setOverId(id);
                      }}
                      onDragLeave={() => setOverId((o) => (o === id ? null : o))}
                      onDrop={(e) => {
                        e.preventDefault();
                        onDrop(id);
                      }}
                    >
                      <span class="seq-k">{k + 1}</span>
                      <div class="seq-main">
                        <div class="seq-row-top">
                          <span class="seq-id">{labelFor(id)}</span>
                          <span class="seq-ttl">{titleFor(id)}</span>
                        </div>
                        <div class="seq-meta">
                          {(blockedByOf.get(id) ?? []).length > 0 && (
                            <span class="seq-blocked">
                              ↳ needs {(blockedByOf.get(id) ?? []).map(labelFor).join(', ')}
                            </span>
                          )}
                          {deps.length > 0 && (
                            <span class="seq-warn" title="this edge will be dropped on approve">
                              ⚠ ordered before {deps.map(labelFor).join(', ')}
                            </span>
                          )}
                        </div>
                        {rationaleOf.get(id) && <div class="seq-why">{rationaleOf.get(id)}</div>}
                      </div>
                      {order.status === 'ready' && <span class="seq-grip">⠿</span>}
                    </li>
                  );
                })}
              </ol>

              {order.status === 'ready' && (
                <div class="seq-foot">
                  <button
                    class="btn ghost"
                    disabled={busy}
                    onClick={() => void act(() => api.cancelOrder(order.runId))}
                  >
                    Cancel
                  </button>
                  <div class="seq-foot-right">
                    {edited && <span class="seq-edited">edited</span>}
                    <button
                      class="btn"
                      disabled={busy}
                      onClick={() => void act(() => api.reRunOrder(order.runId))}
                    >
                      Re-run
                    </button>
                    <button
                      class="btn"
                      data-test="seq-apply"
                      title={`Record the order + dependencies on the tickets but keep them in ${backlogName}`}
                      disabled={busy}
                      onClick={() => void approve(order.runId, false)}
                    >
                      Apply (keep in {backlogName})
                    </button>
                    <button
                      class="btn primary"
                      data-test="seq-approve"
                      title={`Apply the order and move the tickets to ${entryLane} to run now`}
                      disabled={busy}
                      onClick={() => void approve(order.runId, true)}
                    >
                      Approve &amp; queue
                    </button>
                  </div>
                </div>
              )}
            </div>
          )}
        </>
      )}
    </div>
  );
}

function SequencePicker(props: {
  backlog: BoardIssueDTO[];
  picked: Set<string>;
  onToggle: (id: string) => void;
  instructions: string;
  onInstructions: (v: string) => void;
  busy: boolean;
  onStart: () => void;
}) {
  const n = props.picked.size;
  return (
    <div class="seq-picker" data-test="seq-picker">
      {props.backlog.length === 0 ? (
        <div class="center seq-empty">
          No backlog tickets yet. Create a few, then sequence them here.
        </div>
      ) : (
        <ul class="seq-pick-list">
          {props.backlog.map((i) => {
            const on = props.picked.has(i.id);
            return (
              <li
                key={i.id}
                class={`seq-pick${on ? ' on' : ''}`}
                data-test="seq-pick"
                onClick={() => props.onToggle(i.id)}
              >
                <span class={`seq-check${on ? ' on' : ''}`}>{on ? '✓' : ''}</span>
                <span class="seq-id">{i.identifier}</span>
                <span class="seq-ttl">{i.title}</span>
              </li>
            );
          })}
        </ul>
      )}
      <textarea
        class="seq-instr"
        placeholder="Optional: steer the ordering (e.g. 'prioritize the API before the UI')"
        value={props.instructions}
        onInput={(e) => props.onInstructions((e.target as HTMLTextAreaElement).value)}
      />
      <div class="seq-foot">
        <span class="seq-count">{n} selected</span>
        <button
          class="btn primary"
          data-test="seq-start"
          disabled={props.busy || n < 2}
          onClick={props.onStart}
        >
          {props.busy ? 'Starting…' : `Auto-order (${n})`}
        </button>
      </div>
    </div>
  );
}
