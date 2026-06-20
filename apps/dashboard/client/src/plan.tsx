import { createElement, type VNode } from 'preact';
import { useCallback, useEffect, useMemo, useRef, useState } from 'preact/hooks';
import {
  api,
  type BoardIssueDTO,
  type PlanComment,
  type PlanDTO,
  type PlanQuestion,
  type PlanStatus,
  type PlanTextAnchor,
  type RuntimeInfo,
} from './api.js';

// ---- minimal, XSS-safe markdown → Preact renderer (no innerHTML, no deps) ----

function safeUrl(url: string): string | undefined {
  const u = url.trim();
  if (/^(https?:|mailto:|\/|#)/i.test(u)) return u;
  return undefined; // drop javascript:, data:, etc.
}

function inline(text: string): Array<string | VNode> {
  const out: Array<string | VNode> = [];
  const re = /(\*\*([^*]+)\*\*|\*([^*]+)\*|`([^`]+)`|\[([^\]]+)\]\(([^)]+)\))/g;
  let last = 0;
  let key = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    if (m.index > last) out.push(text.slice(last, m.index));
    if (m[2] != null) out.push(<strong key={key++}>{m[2]}</strong>);
    else if (m[3] != null) out.push(<em key={key++}>{m[3]}</em>);
    else if (m[4] != null) out.push(<code key={key++}>{m[4]}</code>);
    else if (m[5] != null) {
      const href = safeUrl(m[6] ?? '');
      out.push(
        href ? (
          <a key={key++} href={href} target="_blank" rel="noopener noreferrer">
            {m[5]}
          </a>
        ) : (
          (m[5] ?? '')
        ),
      );
    }
    last = re.lastIndex;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

/** An anchored comment to highlight inline in the rendered plan. */
interface RenderAnchor {
  id: string;
  exact: string;
  num: number;
  active: boolean;
  resolved: boolean;
}

/** Render a block of prose, wrapping the first occurrence of each comment anchor with a highlight + pin. */
function blockText(
  text: string,
  anchors: RenderAnchor[],
  onAnchor: (id: string) => void,
  keyer: () => number,
): Array<string | VNode> {
  for (const a of anchors) {
    const idx = a.exact.length > 0 ? text.indexOf(a.exact) : -1;
    if (idx >= 0) {
      const before = text.slice(0, idx);
      const after = text.slice(idx + a.exact.length);
      const rest = anchors.filter((x) => x !== a);
      const cls = `plan-anchor${a.active ? ' active' : ''}${a.resolved ? ' resolved' : ''}`;
      return [
        ...inline(before),
        <span
          key={keyer()}
          class={cls}
          onClick={(e) => {
            e.stopPropagation();
            onAnchor(a.id);
          }}
        >
          {inline(a.exact)}
          <sup class="plan-pin">{a.num}</sup>
        </span>,
        ...blockText(after, rest, onAnchor, keyer),
      ];
    }
  }
  return inline(text);
}

function renderMarkdown(
  md: string,
  anchors: RenderAnchor[],
  onAnchor: (id: string) => void,
): VNode[] {
  const lines = md.replace(/\r\n/g, '\n').split('\n');
  const blocks: VNode[] = [];
  let i = 0;
  let key = 0;
  const k = () => key++;
  const prose = (t: string) => blockText(t, anchors, onAnchor, k);
  while (i < lines.length) {
    const line = lines[i] ?? '';
    if (line.trim() === '') {
      i++;
      continue;
    }
    if (line.startsWith('```')) {
      const code: string[] = [];
      i++;
      while (i < lines.length && !(lines[i] ?? '').startsWith('```')) {
        code.push(lines[i] ?? '');
        i++;
      }
      i++;
      blocks.push(
        <pre key={k()} class="md-code">
          <code>{code.join('\n')}</code>
        </pre>,
      );
      continue;
    }
    const head = /^(#{1,6})\s+(.*)$/.exec(line);
    if (head) {
      const level = Math.min((head[1]?.length ?? 1) + 2, 6);
      blocks.push(createElement(`h${level}`, { key: k(), class: 'md-h' }, inline(head[2] ?? '')));
      i++;
      continue;
    }
    if (/^(-{3,}|\*{3,}|_{3,})$/.test(line.trim())) {
      blocks.push(<hr key={k()} />);
      i++;
      continue;
    }
    if (line.startsWith('>')) {
      const quote: string[] = [];
      while (i < lines.length && (lines[i] ?? '').startsWith('>')) {
        quote.push((lines[i] ?? '').replace(/^>\s?/, ''));
        i++;
      }
      blocks.push(<blockquote key={k()}>{prose(quote.join(' '))}</blockquote>);
      continue;
    }
    const ulRe = /^\s*[-*+]\s+(.*)$/;
    const olRe = /^\s*\d+\.\s+(.*)$/;
    if (ulRe.test(line) || olRe.test(line)) {
      const ordered = olRe.test(line);
      const re = ordered ? olRe : ulRe;
      const items: VNode[] = [];
      while (i < lines.length && re.test(lines[i] ?? '')) {
        const m = re.exec(lines[i] ?? '');
        items.push(<li key={k()}>{prose(m?.[1] ?? '')}</li>);
        i++;
      }
      blocks.push(ordered ? <ol key={k()}>{items}</ol> : <ul key={k()}>{items}</ul>);
      continue;
    }
    const para: string[] = [];
    while (
      i < lines.length &&
      (lines[i] ?? '').trim() !== '' &&
      !/^(#{1,6})\s/.test(lines[i] ?? '') &&
      !(lines[i] ?? '').startsWith('```') &&
      !(lines[i] ?? '').startsWith('>')
    ) {
      para.push(lines[i] ?? '');
      i++;
    }
    blocks.push(<p key={k()}>{prose(para.join(' '))}</p>);
  }
  return blocks;
}

// ---- text-quote anchoring (W3C-style) over the rendered plan ----

function textOffset(root: Node, node: Node, offset: number): number {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  let count = 0;
  let n: Node | null;
  while ((n = walker.nextNode()) !== null) {
    if (n === node) return count + offset;
    count += (n.textContent ?? '').length;
  }
  return count + offset;
}

function quoteFromSelection(container: HTMLElement): PlanTextAnchor | null {
  const sel = window.getSelection();
  if (!sel || sel.isCollapsed || sel.rangeCount === 0) return null;
  const range = sel.getRangeAt(0);
  if (!container.contains(range.commonAncestorContainer)) return null;
  const exact = sel.toString();
  if (exact.trim().length === 0) return null;
  const full = container.textContent ?? '';
  const start = textOffset(container, range.startContainer, range.startOffset);
  const prefix = full.slice(Math.max(0, start - 32), start);
  const suffix = full.slice(start + exact.length, start + exact.length + 32);
  return { exact, ...(prefix ? { prefix } : {}), ...(suffix ? { suffix } : {}) };
}

// ---- live agent log (the plan agent thinking) ----

function useLiveLog(issueId: string, active: boolean): string[] {
  const [lines, setLines] = useState<string[]>([]);
  useEffect(() => {
    if (!active) return;
    setLines([]);
    const es = api.logStream(issueId);
    es.onmessage = (m) => {
      try {
        const ev = JSON.parse(m.data) as { type: string; text?: string; toolName?: string };
        let text = '';
        if (ev.type === 'text_delta') text = ev.text ?? '';
        else if (ev.type === 'tool_use') text = `\n· ${ev.toolName}\n`;
        if (text === '') return;
        setLines((l) => [...l.slice(-199), text]);
      } catch {
        /* ignore */
      }
    };
    return () => es.close();
  }, [issueId, active]);
  return lines;
}

function relTime(iso?: string): string {
  if (!iso) return '';
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return '';
  const s = Math.max(0, Math.floor((Date.now() - t) / 1000));
  if (s < 60) return 'just now';
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

const STATUS_LABEL: Record<PlanStatus, string> = {
  planning: 'planning…',
  awaiting_input: 'waiting for your answer',
  ready: 'plan ready for review',
  approved: 'approved',
  failed: 'planning failed',
};

/** Map a plan-run failure (category + raw error text) to a short, actionable operator hint. */
function planFailureHint(error?: string, category?: string): string | null {
  const e = (error ?? '').toLowerCase();
  const is = (cat: string, re: RegExp) => category === cat || re.test(e);
  if (is('auth_required', /401|authenticat|invalid auth|credential/))
    return 'Your Claude credentials are invalid or expired. Re-authenticate (run `claude /login`), then start planning again.';
  if (is('rate_limited', /rate.?limit|\b429\b/))
    return 'Claude is rate-limited right now. Wait a moment, then retry.';
  if (is('prompt_too_large', /too large|prompt too|context length|context window/))
    return 'The planning prompt was too large. Trim the ticket description and retry.';
  if (is('upstream_unavailable', /unavailable|overloaded|\b5\d\d\b/))
    return "Claude's API is temporarily unavailable. Retry in a moment.";
  return null;
}

type Phase = 'questions' | 'drafting' | 'review';
const STEPS: Array<{ key: Phase; label: string; num: string }> = [
  { key: 'questions', label: 'Questions', num: '1' },
  { key: 'drafting', label: 'Drafting', num: '2' },
  { key: 'review', label: 'Review', num: '3' },
];

export function PlanModal(props: {
  issue: BoardIssueDTO;
  meta: RuntimeInfo | null;
  onClose: () => void;
  onChanged: () => void;
}) {
  const { issue } = props;
  const [plan, setPlan] = useState<PlanDTO | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const [answers, setAnswers] = useState<Record<string, string | string[]>>({});
  const [pendingAnchor, setPendingAnchor] = useState<PlanTextAnchor | null>(null);
  const [commentDraft, setCommentDraft] = useState('');
  const [activeComment, setActiveComment] = useState<string | null>(null);
  const [filter, setFilter] = useState<'open' | 'resolved' | 'all'>('open');
  const [instructions, setInstructions] = useState('');
  const mdRef = useRef<HTMLDivElement>(null);

  const load = useCallback(async () => {
    try {
      setPlan(await api.getPlan(issue.id));
      setErr(null);
    } catch (e) {
      setErr((e as Error).message);
    }
  }, [issue.id]);

  // Poll the plan while open (status transitions during a run); the live log carries the agent stream.
  useEffect(() => {
    void load();
    const id = setInterval(() => void load(), 1500);
    return () => clearInterval(id);
  }, [load]);

  const status = plan?.status ?? null;
  const planning = status === 'planning';
  const awaiting = status === 'awaiting_input' && !!plan?.pendingAsk;
  const hasPlan = plan?.markdown != null && plan.markdown.length > 0;
  // The start panel: no plan yet, or a failed run with nothing salvageable to review.
  const showStart = !plan || (status === 'failed' && !hasPlan);
  const phase: Phase | null = awaiting
    ? 'questions'
    : planning
      ? 'drafting'
      : hasPlan
        ? 'review'
        : null;
  const lines = useLiveLog(issue.id, planning || awaiting);
  const comments = plan?.comments ?? [];
  const unresolvedComments = useMemo(() => comments.filter((c) => !c.resolved), [comments]);

  const act = async (fn: () => Promise<{ reason?: string } | unknown>) => {
    setBusy(true);
    setErr(null);
    try {
      const r = (await fn()) as { reason?: string };
      if (r && typeof r === 'object' && 'reason' in r && r.reason) setErr(r.reason);
      await load();
      props.onChanged();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const onMouseUp = () => {
    if (!mdRef.current || editing) return;
    const a = quoteFromSelection(mdRef.current);
    if (a) {
      setPendingAnchor(a);
      setCommentDraft('');
    }
  };

  const submitComment = async () => {
    if (!pendingAnchor || !commentDraft.trim()) return;
    await act(() => api.addPlanComment(issue.id, pendingAnchor, commentDraft.trim()));
    setPendingAnchor(null);
    setCommentDraft('');
    window.getSelection()?.removeAllRanges();
  };

  const answerable = (plan?.pendingAsk?.questions ?? []).every((q) => {
    const v = answers[q.id];
    return Array.isArray(v) ? v.length > 0 : typeof v === 'string' && v.trim().length > 0;
  });
  const answeredCount = (plan?.pendingAsk?.questions ?? []).filter((q) => {
    const v = answers[q.id];
    return Array.isArray(v) ? v.length > 0 : typeof v === 'string' && v.trim().length > 0;
  }).length;

  const renderAnchors: RenderAnchor[] = comments.map((c, idx) => ({
    id: c.id,
    exact: c.anchor.exact,
    num: idx + 1,
    active: activeComment === c.id,
    resolved: c.resolved,
  }));

  return (
    <div class="overlay" onClick={props.onClose}>
      <div class="modal plan-modal" data-test="plan-modal" onClick={(e) => e.stopPropagation()}>
        {/* ── header ── */}
        <div class="plan-head">
          <div class="plan-head-row">
            <div class="row" style="gap:11px;align-items:center;min-width:0">
              <span class="plan-mark">
                <i />
              </span>
              <span class="card-id">{issue.identifier}</span>
              <b class="plan-title">Plan</b>
              {status && (
                <span class={`plan-badge ${status}`}>
                  <span class="dot" />
                  {STATUS_LABEL[status]}
                </span>
              )}
            </div>
            <div class="row" style="gap:10px;align-items:center">
              {plan && (
                <span class="plan-meta-mono">
                  {props.meta?.backend ?? 'claude-sdk'} · rev {plan.revision}
                </span>
              )}
              <button class="iconbtn" data-test="plan-close" onClick={props.onClose}>
                ×
              </button>
            </div>
          </div>
          {phase && (
            <div class="plan-stepper">
              {STEPS.map((s, idx) => {
                const cur = STEPS.findIndex((x) => x.key === phase);
                const st = idx < cur ? 'done' : idx === cur ? 'cur' : 'todo';
                return (
                  <div class="plan-step-wrap" key={s.key}>
                    <div class={`plan-step ${st}`}>
                      <span class="num">{s.num}</span>
                      <span class="lbl">{s.label}</span>
                    </div>
                    {idx < STEPS.length - 1 && <span class={`plan-step-line ${st}`} />}
                  </div>
                );
              })}
            </div>
          )}
        </div>

        {err && <div class="err-banner">⚠ {err}</div>}

        {/* A persisted plan-run failure, shown when there's still a plan to review (start panel
            carries the reason itself when there's no salvageable plan). */}
        {status === 'failed' && plan?.error && !showStart && (
          <div class="plan-fail-banner" data-test="plan-failure">
            <div class="t">⚠ Planning failed</div>
            <div class="msg">{plan.error}</div>
            {planFailureHint(plan.error, plan.errorCategory) && (
              <div class="hint">{planFailureHint(plan.error, plan.errorCategory)}</div>
            )}
          </div>
        )}

        {/* ── body ── */}
        <div
          class={`plan-body${phase === 'review' && !editing ? ' review' : ''}${showStart ? ' start' : ''}`}
        >
          {/* no plan yet (or a failed run) → offer to start, with optional steering instructions */}
          {showStart && (
            <PlanStart
              backend={props.meta?.backend ?? 'claude-sdk'}
              failed={status === 'failed'}
              busy={busy}
              instructions={instructions}
              onInstructions={setInstructions}
              error={plan?.error}
              hint={planFailureHint(plan?.error, plan?.errorCategory)}
              onStart={() =>
                void act(() => api.startPlan(issue.id, instructions)).then(() =>
                  setInstructions(''),
                )
              }
            />
          )}

          {/* questions */}
          {phase === 'questions' && (
            <div class="plan-questions pm-scroll">
              {plan?.pendingAsk?.questions.map((q) => (
                <QuestionCard
                  key={q.id}
                  q={q}
                  value={answers[q.id]}
                  onChange={(v) => setAnswers((a) => ({ ...a, [q.id]: v }))}
                />
              ))}
            </div>
          )}

          {/* drafting (live) */}
          {phase === 'drafting' && (
            <div class="plan-drafting">
              <div class="plan-drafting-head">
                <span class="ping">
                  <span class="ring" />
                  <span class="dot" />
                </span>
                <span class="t">Drafting plan{hasPlan ? ' (revision)' : ''}…</span>
              </div>
              <div class="plan-log-body pm-scroll" data-test="plan-log">
                {lines.length > 0 ? lines.join('') : 'Waiting for the agent…'}
                <span class="plan-caret">▍</span>
              </div>
            </div>
          )}

          {/* review: edit OR doc+comments */}
          {phase === 'review' &&
            (editing ? (
              <div class="plan-edit">
                <textarea
                  class="plan-textarea"
                  value={draft}
                  onInput={(e) => setDraft((e.target as HTMLTextAreaElement).value)}
                />
                <div class="plan-actions">
                  <button class="btn ghost sm" onClick={() => setEditing(false)}>
                    Cancel
                  </button>
                  <button
                    class="btn primary sm"
                    disabled={busy}
                    onClick={() =>
                      void act(() => api.editPlan(issue.id, draft)).then(() => setEditing(false))
                    }
                  >
                    Save plan
                  </button>
                </div>
              </div>
            ) : (
              <div class="plan-review">
                <div
                  class="plan-doc pm-scroll"
                  ref={mdRef}
                  data-test="plan-md"
                  onMouseUp={onMouseUp}
                >
                  <div class="plan-doc-inner">
                    <div class="plan-doc-meta">
                      rev {plan!.revision} · {props.meta?.backend ?? 'claude-sdk'}
                      {plan!.updatedAt ? ` · updated ${relTime(plan!.updatedAt)}` : ''}
                      {plan!.editedByUser ? ' · edited by you' : ''}
                      {comments.length > 0
                        ? ` · ${comments.length} comment${comments.length === 1 ? '' : 's'}`
                        : ''}
                    </div>
                    {renderMarkdown(plan!.markdown ?? '', renderAnchors, setActiveComment)}
                  </div>
                </div>
                <CommentsRail
                  comments={comments}
                  filter={filter}
                  onFilter={setFilter}
                  active={activeComment}
                  onActive={setActiveComment}
                  pendingAnchor={pendingAnchor}
                  commentDraft={commentDraft}
                  onCommentDraft={setCommentDraft}
                  onCancelDraft={() => {
                    setPendingAnchor(null);
                    window.getSelection()?.removeAllRanges();
                  }}
                  onSubmitComment={() => void submitComment()}
                  onResolve={(c) =>
                    void act(() => api.resolvePlanComment(issue.id, c.id, !c.resolved))
                  }
                  busy={busy}
                />
              </div>
            ))}
        </div>

        {/* ── footer ── */}
        <div class="modal-foot">
          <div class="row" style="gap:8px">
            {(planning || awaiting) && (
              <button
                class="btn ghost sm"
                data-test="plan-cancel"
                disabled={busy}
                onClick={() => void act(() => api.cancelPlan(issue.id))}
              >
                Cancel plan
              </button>
            )}
            {status === 'failed' && !showStart && (
              <button
                class="btn sm"
                disabled={busy}
                onClick={() => void act(() => api.startPlan(issue.id))}
              >
                Retry planning
              </button>
            )}
          </div>

          {phase === 'questions' && (
            <div class="row" style="gap:12px;align-items:center">
              <span class="plan-answered">
                {answeredCount} of {plan?.pendingAsk?.questions.length ?? 0} answered
              </span>
              <button
                class="btn primary sm"
                data-test="plan-answer"
                disabled={busy || !answerable}
                onClick={() =>
                  void act(() =>
                    api.answerPlanQuestion(issue.id, plan!.pendingAsk!.id, answers),
                  ).then(() => setAnswers({}))
                }
              >
                Submit answers
              </button>
            </div>
          )}

          {phase === 'drafting' && (
            <button class="btn sm" disabled style="cursor:default">
              Waiting for plan…
            </button>
          )}

          {phase === 'review' && !editing && (
            <div class="row" style="gap:9px">
              <button
                class="btn sm"
                onClick={() => {
                  setDraft(plan?.markdown ?? '');
                  setEditing(true);
                }}
              >
                Edit plan
              </button>
              {status !== 'approved' && (
                <button
                  class="btn sm"
                  data-test="plan-revise"
                  disabled={busy}
                  title={
                    unresolvedComments.length > 0
                      ? `revise addressing ${unresolvedComments.length} comment(s)`
                      : 'ask the agent to revise the plan'
                  }
                  onClick={() => void act(() => api.revisePlan(issue.id))}
                >
                  Request revision
                  {unresolvedComments.length > 0 ? ` (${unresolvedComments.length})` : ''}
                </button>
              )}
              {status === 'ready' && (
                <button
                  class="btn primary sm"
                  data-test="plan-approve"
                  disabled={busy}
                  title={
                    unresolvedComments.length > 0
                      ? 'there are unresolved comments — approving anyway'
                      : undefined
                  }
                  onClick={() =>
                    void act(() => api.approvePlan(issue.id)).then(() => props.onClose())
                  }
                >
                  Approve & move to {props.meta?.active_states?.[0] ?? 'Todo'}
                </button>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

// ---- start panel (no plan yet / failed run) ----

const START_STEPS: Array<{ n: string; t: string; d: string }> = [
  { n: '1', t: 'Questions', d: 'The agent asks only if it needs a decision' },
  { n: '2', t: 'Drafting', d: 'It investigates the repo and writes the plan' },
  { n: '3', t: 'Review', d: 'You comment, edit, and approve it' },
];

function PlanStart(props: {
  backend: string;
  failed: boolean;
  busy: boolean;
  instructions: string;
  onInstructions: (v: string) => void;
  error?: string;
  hint?: string | null;
  onStart: () => void;
}) {
  return (
    <div class="plan-start">
      <div class="plan-start-card">
        <div class="plan-start-icon" aria-hidden="true">
          📋
        </div>
        <h2 class="plan-start-title">{props.failed ? 'Retry planning' : 'Plan this ticket'}</h2>
        <p class="plan-start-sub">
          Start a read-only planning run. The agent investigates the repository, asks you questions
          if needed, and drafts an implementation plan to review here — it never changes code or
          moves the ticket.
        </p>

        <div class="plan-start-steps">
          {START_STEPS.map((s) => (
            <div class="plan-start-step" key={s.n}>
              <span class="num">{s.n}</span>
              <div class="meta">
                <span class="t">{s.t}</span>
                <span class="d">{s.d}</span>
              </div>
            </div>
          ))}
        </div>

        <label class="plan-start-field">
          <span class="lbl">
            Custom instructions <span class="opt">optional</span>
          </span>
          <textarea
            class="plan-start-textarea"
            data-test="plan-instructions"
            placeholder="Steer the plan — focus areas, constraints, preferred approach, files to look at, things to avoid…"
            value={props.instructions}
            disabled={props.busy}
            onInput={(e) => props.onInstructions((e.target as HTMLTextAreaElement).value)}
          />
          <span class="hint">Added to the agent's first prompt to steer this planning run.</span>
        </label>

        {props.failed && (
          <div class="plan-start-note" data-test="plan-failure">
            <div class="t">⚠ The previous planning run failed</div>
            {props.error && <div class="msg">{props.error}</div>}
            <div class="hint">
              {props.hint ?? 'Adjust the instructions if needed and try again.'}
            </div>
          </div>
        )}

        <div class="plan-start-actions">
          <span class="plan-start-tag" title="Planning runs are read-only">
            <span class="dot" />
            read-only · {props.backend}
          </span>
          <button
            class="btn primary"
            data-test="plan-start"
            disabled={props.busy}
            onClick={props.onStart}
          >
            {props.busy ? 'Starting…' : props.failed ? '↻ Retry planning' : '📋 Start planning'}
          </button>
        </div>
      </div>
    </div>
  );
}

// ---- comments rail (review) ----

function CommentsRail(props: {
  comments: PlanComment[];
  filter: 'open' | 'resolved' | 'all';
  onFilter: (f: 'open' | 'resolved' | 'all') => void;
  active: string | null;
  onActive: (id: string | null) => void;
  pendingAnchor: PlanTextAnchor | null;
  commentDraft: string;
  onCommentDraft: (v: string) => void;
  onCancelDraft: () => void;
  onSubmitComment: () => void;
  onResolve: (c: PlanComment) => void;
  busy: boolean;
}) {
  const openCount = props.comments.filter((c) => !c.resolved).length;
  const resolvedCount = props.comments.length - openCount;
  const numOf = (id: string) => props.comments.findIndex((c) => c.id === id) + 1;
  const visible = props.comments.filter((c) =>
    props.filter === 'open' ? !c.resolved : props.filter === 'resolved' ? c.resolved : true,
  );

  return (
    <div class="plan-rail">
      <div class="plan-rail-head">
        <div class="row" style="justify-content:space-between;align-items:center">
          <span class="plan-rail-title">Comments</span>
          <span class="plan-meta-mono">{props.comments.length} total</span>
        </div>
        <div class="plan-seg">
          {(['open', 'resolved', 'all'] as const).map((f) => (
            <span
              key={f}
              class={`plan-seg-item${props.filter === f ? ' on' : ''}`}
              onClick={() => props.onFilter(f)}
            >
              {f === 'open'
                ? `Open · ${openCount}`
                : f === 'resolved'
                  ? `Resolved · ${resolvedCount}`
                  : 'All'}
            </span>
          ))}
        </div>
      </div>

      <div class="plan-rail-body pm-scroll">
        {props.pendingAnchor && (
          <div class="plan-thread compose">
            <div class="plan-quote">“{props.pendingAnchor.exact}”</div>
            <textarea
              class="plan-comment-input"
              placeholder="Comment on this selection…"
              value={props.commentDraft}
              onInput={(e) => props.onCommentDraft((e.target as HTMLTextAreaElement).value)}
            />
            <div class="plan-actions">
              <button class="btn ghost xs" onClick={props.onCancelDraft}>
                Cancel
              </button>
              <button
                class="btn primary xs"
                disabled={props.busy || !props.commentDraft.trim()}
                onClick={props.onSubmitComment}
              >
                Comment
              </button>
            </div>
          </div>
        )}

        {visible.length === 0 && !props.pendingAnchor && (
          <div class="plan-rail-empty">
            No comments here.
            <br />
            Select any text in the plan to start a thread.
          </div>
        )}

        {visible.map((c) => {
          const agent = c.author === 'agent';
          return (
            <div
              key={c.id}
              class={`plan-thread${props.active === c.id ? ' active' : ''}${c.resolved ? ' resolved' : ''}`}
              onClick={() => props.onActive(c.id)}
            >
              <div class="plan-thread-top">
                <div class="plan-quote pin">
                  <span class="plan-pin-num">{numOf(c.id)}</span>
                  <span class="q">“{c.anchor.exact}”</span>
                </div>
                {c.resolved && <span class="plan-resolved-tag">resolved</span>}
              </div>
              <div class="plan-comment-row">
                <span class={`plan-av${agent ? ' agent' : ''}`}>{agent ? 'AI' : 'Y'}</span>
                <div class="plan-comment-main">
                  <div class="plan-comment-meta">
                    <span class="name">{agent ? 'claude-sdk' : 'you'}</span>
                    {agent && <span class="agent-tag">agent</span>}
                    <span class="time">{relTime(c.at)}</span>
                  </div>
                  <div class="plan-comment-body">{c.body}</div>
                </div>
              </div>
              <div class="plan-thread-foot">
                <span class="hint">Reply via Request revision</span>
                <span
                  class={`plan-resolve${c.resolved ? ' reopen' : ''}`}
                  onClick={(e) => {
                    e.stopPropagation();
                    props.onResolve(c);
                  }}
                >
                  {c.resolved ? 'Reopen' : 'Resolve'}
                </span>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ---- questions ----

function QuestionCard(props: {
  q: PlanQuestion;
  value: string | string[] | undefined;
  onChange: (v: string | string[]) => void;
}) {
  const { q } = props;
  const selected = (label: string): boolean =>
    Array.isArray(props.value) ? props.value.includes(label) : props.value === label;
  const pick = (label: string) => {
    if (q.multiSelect) {
      const cur = Array.isArray(props.value) ? props.value : [];
      props.onChange(cur.includes(label) ? cur.filter((l) => l !== label) : [...cur, label]);
    } else {
      props.onChange(label);
    }
  };
  // Free text serves single-select questions as the "Other" answer (deselects any option).
  const freeText =
    !Array.isArray(props.value) && !(q.options ?? []).some((o) => o.label === props.value);

  return (
    <div class="plan-q" data-test="plan-question">
      <div class="plan-q-head">
        <span class="lbl">{q.header}</span>
        <span class="rule" />
        <span class="hint">{q.multiSelect ? 'select all that apply' : 'choose one'}</span>
      </div>
      <div class="plan-q-text">{q.question}</div>
      <div class="plan-opts">
        {(q.options ?? []).map((o) => {
          const on = selected(o.label);
          return (
            <div
              key={o.label}
              class={`plan-opt${on ? ' on' : ''}`}
              data-test="plan-opt"
              onClick={() => pick(o.label)}
            >
              <span class={`plan-ind${q.multiSelect ? ' check' : ''}${on ? ' on' : ''}`}>
                {on && (q.multiSelect ? '✓' : <span class="rad" />)}
              </span>
              <div class="plan-opt-main">
                <span class="lbl">{o.label}</span>
                {o.description && <span class="desc">{o.description}</span>}
              </div>
            </div>
          );
        })}
        {!q.multiSelect && (
          <input
            class="plan-opt-other"
            placeholder="Other / custom answer…"
            value={freeText && typeof props.value === 'string' ? props.value : ''}
            onInput={(e) => props.onChange((e.target as HTMLInputElement).value)}
          />
        )}
      </div>
    </div>
  );
}
