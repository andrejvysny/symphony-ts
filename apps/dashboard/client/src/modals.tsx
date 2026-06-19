import { useCallback, useEffect, useRef, useState } from 'preact/hooks';
import {
  api,
  type AgentEffort,
  type BoardIssueDTO,
  type BoardStateDTO,
  type IssueDetailDTO,
  type LabelInfo,
  type RuntimeInfo,
  type SessionInfo,
} from './api.js';
import { describeActivity, fmt, fmtCost, fmtTokens, StatusPill } from './util.js';

const PRIORITIES: { value: number | null; label: string }[] = [
  { value: 1, label: 'Urgent' },
  { value: 2, label: 'High' },
  { value: 3, label: 'Medium' },
  { value: 4, label: 'Low' },
  { value: null, label: 'None' },
];

// Per-task agent overrides. Empty value = inherit the workflow's global agent config.
const MODELS: { value: string; label: string }[] = [
  { value: '', label: 'Default (workflow)' },
  { value: 'claude-opus-4-8', label: 'Opus 4.8' },
  { value: 'claude-opus-4-7', label: 'Opus 4.7' },
  { value: 'claude-sonnet-4-6', label: 'Sonnet 4.6' },
  { value: 'claude-haiku-4-5', label: 'Haiku 4.5' },
  { value: 'claude-fable-5', label: 'Fable 5' },
];
const EFFORTS: { value: string; label: string }[] = [
  { value: '', label: 'Default' },
  { value: 'low', label: 'Low' },
  { value: 'medium', label: 'Medium' },
  { value: 'high', label: 'High' },
  { value: 'xhigh', label: 'X-High' },
  { value: 'max', label: 'Max' },
];

interface Attachment {
  id: number;
  file: File;
  preview: string | null;
  ext: string;
}

export function CreateTicketModal(props: {
  states: BoardStateDTO[];
  preselectedStateId?: string | null;
  onClose: () => void;
  onCreated: () => void;
}) {
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [stateId, setStateId] = useState(props.preselectedStateId ?? props.states[0]?.id ?? '');
  const [model, setModel] = useState('');
  const [effort, setEffort] = useState('');
  const [atts, setAtts] = useState<Attachment[]>([]);
  const [over, setOver] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const nextId = useRef(1);
  const attsRef = useRef<Attachment[]>([]);
  attsRef.current = atts;

  // Revoke any outstanding object URLs only on unmount (removal revokes per-item below);
  // an [atts]-deps cleanup would wrongly revoke still-visible previews on every add.
  useEffect(
    () => () => attsRef.current.forEach((a) => a.preview && URL.revokeObjectURL(a.preview)),
    [],
  );

  const add = (files: FileList | null) => {
    const next: Attachment[] = [];
    for (const file of Array.from(files ?? [])) {
      const isImg = file.type.startsWith('image/');
      next.push({
        id: nextId.current++,
        file,
        preview: isImg ? URL.createObjectURL(file) : null,
        ext: (file.name.split('.').pop() ?? 'file').toUpperCase().slice(0, 4),
      });
    }
    if (next.length) setAtts((a) => [...a, ...next]);
  };
  const remove = (id: number) =>
    setAtts((a) => {
      const hit = a.find((x) => x.id === id);
      if (hit?.preview) URL.revokeObjectURL(hit.preview);
      return a.filter((x) => x.id !== id);
    });

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
      if (model) form.set('model', model);
      if (effort) form.set('effort', effort);
      for (const a of atts) form.append('files', a.file, a.file.name);
      await api.createTicket(form);
      props.onCreated();
    } catch (e) {
      setErr((e as Error).message);
      setBusy(false);
    }
  };

  return (
    <div class="overlay" onClick={props.onClose}>
      <div class="modal create-modal" data-test="create-modal" onClick={(e) => e.stopPropagation()}>
        <div class="modal-head">
          <h3>New ticket</h3>
          <button class="iconbtn" data-test="create-close" title="Close" onClick={props.onClose}>
            ×
          </button>
        </div>
        {err && (
          <div class="err-banner" style="border-radius:7px;margin-bottom:8px">
            {err}
          </div>
        )}
        <label class="field">
          <span>Title</span>
          <input
            data-test="ticket-title"
            placeholder="Short, imperative summary…"
            value={title}
            onInput={(e) => setTitle((e.target as HTMLInputElement).value)}
          />
        </label>
        <label class="field">
          <span>Description (markdown)</span>
          <textarea
            data-test="ticket-desc"
            placeholder="Context, acceptance criteria, links…"
            value={description}
            onInput={(e) => setDescription((e.target as HTMLTextAreaElement).value)}
          />
        </label>
        <label class="field">
          <span>State</span>
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
        </label>
        <div class="field">
          <span class="subhead">Agent</span>
          <div class="field-row" style="margin-top:0">
            <label class="field" style="margin-top:0">
              <span>Model</span>
              <select
                data-test="ticket-model"
                value={model}
                onChange={(e) => setModel((e.target as HTMLSelectElement).value)}
              >
                {MODELS.map((m) => (
                  <option key={m.value} value={m.value}>
                    {m.label}
                  </option>
                ))}
              </select>
            </label>
            <label class="field" style="margin-top:0">
              <span>Effort</span>
              <select
                data-test="ticket-effort"
                value={effort}
                onChange={(e) => setEffort((e.target as HTMLSelectElement).value)}
              >
                {EFFORTS.map((x) => (
                  <option key={x.value} value={x.value}>
                    {x.label}
                  </option>
                ))}
              </select>
            </label>
          </div>
        </div>
        <div class="field">
          <span>Attachments</span>
          <input
            type="file"
            multiple
            ref={fileRef}
            data-test="ticket-files"
            style="display:none"
            accept="image/*,.md,.log,.txt,.json,.patch,.diff"
            onChange={(e) => {
              add((e.target as HTMLInputElement).files);
              (e.target as HTMLInputElement).value = '';
            }}
          />
          <div class="att-grid">
            <div
              class={`dropzone${over ? ' over' : ''}`}
              onClick={() => fileRef.current?.click()}
              onDragOver={(e) => {
                e.preventDefault();
                setOver(true);
              }}
              onDragLeave={() => setOver(false)}
              onDrop={(e) => {
                e.preventDefault();
                setOver(false);
                add(e.dataTransfer?.files ?? null);
              }}
            >
              <span class="ic">↑</span>
              <span class="t">Add files</span>
              <span class="h">drop screenshots or click</span>
            </div>
            {atts.map((a) => (
              <div class="att" key={a.id}>
                {a.preview ? (
                  <img
                    src={a.preview}
                    alt={a.file.name}
                    style="width:100%;height:100%;object-fit:cover"
                  />
                ) : (
                  <span class="ext">{a.ext}</span>
                )}
                <button class="rm" onClick={() => remove(a.id)}>
                  ×
                </button>
                <span class="name">{a.file.name}</span>
              </div>
            ))}
          </div>
        </div>
        <div class="modal-actions">
          <button class="btn ghost sm" onClick={props.onClose}>
            Cancel
          </button>
          <button class="btn primary sm" data-test="create-submit" disabled={busy} onClick={submit}>
            {busy ? 'Creating…' : 'Create'}
          </button>
        </div>
      </div>
    </div>
  );
}

export function TicketModal(props: {
  issue: BoardIssueDTO;
  states: BoardStateDTO[];
  session: SessionInfo | undefined;
  meta: RuntimeInfo | null;
  onClose: () => void;
  onChanged: () => void;
  /** Jump to the live agent view for this ticket (shown only while a session is running). */
  onViewRunningAgent?: (issueId: string) => void;
}) {
  const i = props.issue;
  const [detail, setDetail] = useState<IssueDetailDTO | null>(null);
  const [tab, setTab] = useState<'comments' | 'history'>('comments');
  const [comment, setComment] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [reviewNotes, setReviewNotes] = useState('');

  // Editable fields (status uses the dedicated instant-move path below).
  const [title, setTitle] = useState(i.title);
  const [description, setDescription] = useState('');
  const [priority, setPriority] = useState<number | null>(i.priority);
  const [labels, setLabels] = useState<string[]>(i.labels);
  const [model, setModel] = useState('');
  const [effort, setEffort] = useState<'' | AgentEffort>('');
  const [labelInput, setLabelInput] = useState('');
  const [labelOpts, setLabelOpts] = useState<LabelInfo[]>([]);
  const [dirty, setDirty] = useState(false);
  const dirtyRef = useRef(false);
  // Description toggles between a read card and an editable textarea (click to edit).
  const [editingDesc, setEditingDesc] = useState(false);
  // Header overflow menu (Delete / Copy id / Open link) + delete confirmation.
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  // Attachment upload (drag-drop / picker) on the existing issue.
  const [attOver, setAttOver] = useState(false);
  const attFileRef = useRef<HTMLInputElement>(null);
  const touch = () => {
    dirtyRef.current = true;
    setDirty(true);
    setSaved(false);
  };

  useEffect(() => {
    if (!menuOpen) return;
    const onDoc = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) setMenuOpen(false);
    };
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, [menuOpen]);

  const load = useCallback(async () => {
    try {
      const d = await api.issueDetail(i.id);
      setDetail(d);
      setErr(null);
      // Hydrate the editor from the server only while the operator hasn't started editing.
      if (d && !dirtyRef.current) {
        setTitle(d.title);
        setDescription(d.description ?? '');
        setPriority(d.priority);
        setLabels(d.labels);
        setModel(d.model ?? '');
        setEffort(d.effort ?? '');
      }
    } catch (e) {
      setErr((e as Error).message);
    }
  }, [i.id]);
  useEffect(() => {
    void load();
  }, [load]);
  useEffect(() => {
    api
      .labels()
      .then(setLabelOpts)
      .catch(() => undefined);
  }, []);

  const currentState = detail?.state ?? i.state;
  const move = async (stateId: string) => {
    setBusy(true);
    try {
      await api.moveIssue(i.id, stateId);
      await load();
      props.onChanged();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const submitComment = async () => {
    if (!comment.trim()) return;
    setBusy(true);
    try {
      await api.addComment(i.id, comment);
      setComment('');
      await load();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const addLabel = (name: string) => {
    const n = name.trim();
    if (!n || labels.some((l) => l.toLowerCase() === n.toLowerCase())) return;
    setLabels((ls) => [...ls, n]);
    setLabelInput('');
    touch();
  };
  const removeLabel = (name: string) => {
    setLabels((ls) => ls.filter((l) => l !== name));
    touch();
  };

  const save = async () => {
    if (!title.trim()) {
      setErr('Title is required');
      return;
    }
    setBusy(true);
    setErr(null);
    try {
      await api.updateIssue(i.id, {
        title: title.trim(),
        description,
        priority,
        labels,
        model: model || null,
        effort: effort || null,
      });
      dirtyRef.current = false;
      setDirty(false);
      setSaved(true);
      await load();
      props.onChanged();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  // ---- Human-review actions: resolve targets from the workflow (no hardcoded state names) ----
  // Done/Cancelled come from board-state type. Rework sends the ticket back to In Progress with a
  // `rework` tag (Rework is no longer a state). The section shows only while the issue is in review.
  const reviewState = props.meta?.review_state;
  const inReview = reviewState !== undefined && currentState === reviewState;
  const doneState = props.states.find((s) => s.type === 'completed');
  const cancelledState = props.states.find((s) => s.type === 'canceled' || s.type === 'cancelled');
  const inProgressName = props.meta?.in_progress_state;
  const reworkState = inProgressName
    ? props.states.find((s) => s.name === inProgressName)
    : undefined;
  // Post the notes (if any), then move. Used by Accept / Discard.
  const reviewMove = async (target: BoardStateDTO | undefined) => {
    if (!target) return;
    setBusy(true);
    setErr(null);
    try {
      if (reviewNotes.trim()) await api.addComment(i.id, reviewNotes.trim());
      await api.moveIssue(i.id, target.id);
      setReviewNotes('');
      await load();
      props.onChanged();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  // Rework: tag the ticket `rework` and send it back to In Progress so the agent picks it up again.
  const reworkAction = async () => {
    if (!reworkState) return;
    setBusy(true);
    setErr(null);
    try {
      if (reviewNotes.trim()) await api.addComment(i.id, reviewNotes.trim());
      if (!labels.includes('rework')) {
        const next = [...labels, 'rework'];
        setLabels(next);
        await api.updateIssue(i.id, { labels: next });
      }
      await api.moveIssue(i.id, reworkState.id);
      setReviewNotes('');
      await load();
      props.onChanged();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  // Dispatch: move the ticket into the In Progress lane and poke the orchestrator so the agent picks
  // it up now (the configured in_progress_state is the active lane the orchestrator dispatches from).
  const dispatch = async () => {
    if (!reworkState) return;
    setBusy(true);
    setErr(null);
    try {
      if (currentState !== reworkState.name) await api.moveIssue(i.id, reworkState.id);
      await api.refresh().catch(() => undefined);
      await load();
      props.onChanged();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const del = async () => {
    setBusy(true);
    setErr(null);
    try {
      await api.deleteIssue(i.id);
      props.onChanged();
      props.onClose();
    } catch (e) {
      setErr((e as Error).message);
      setBusy(false);
      setConfirmDelete(false);
    }
  };

  const addAttachments = async (files: FileList | null) => {
    const list = Array.from(files ?? []);
    if (list.length === 0) return;
    setBusy(true);
    setErr(null);
    try {
      for (const f of list) {
        const form = new FormData();
        form.append('files', f, f.name);
        await api.addAttachment(i.id, form);
      }
      await load();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const removeAtt = async (url: string) => {
    setBusy(true);
    setErr(null);
    try {
      await api.removeAttachment(i.id, url);
      await load();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const branch = `${props.meta?.branch_prefix ?? 'symphony/'}${i.identifier}`;
  const backend = props.session?.backend ?? props.meta?.backend ?? '—';
  const scope = i.identifier.split('-')[0] ?? 'SYM';
  const worktree = detail?.worktree_path ?? null;
  const attachments = detail?.attachments ?? [];
  const curType = props.states.find((s) => s.name === currentState)?.type ?? '';
  const isTerminalState =
    curType === 'completed' || curType === 'canceled' || curType === 'cancelled';
  const isRunning = props.session !== undefined;
  // Image attachments preview inline; everything else shows an extension badge.
  const isImageUrl = (u: string) => /\.(png|jpe?g|gif|webp|svg)(\?|$)/i.test(u);
  const extOf = (u: string) => {
    const name = u.split('/').pop() ?? u;
    return (name.split('.').pop() ?? 'file').toUpperCase().slice(0, 4);
  };

  return (
    <div class="overlay" onClick={props.onClose}>
      <div class="ticket" data-test="ticket-detail" onClick={(e) => e.stopPropagation()}>
        <div class="ticket-head">
          <div class="crumb">
            <span class="scope">{scope}</span>
            <span style="color:var(--faint-2)">/</span>
            <span class="id">{i.identifier}</span>
            {i.status !== 'idle' && <StatusPill status={i.status} />}
          </div>
          <div class="head-actions" ref={menuRef}>
            <button
              class="iconbtn"
              data-test="ticket-menu"
              title="More actions"
              onClick={() => setMenuOpen((o) => !o)}
            >
              ⋯
            </button>
            {menuOpen && (
              <div class="head-menu" data-test="ticket-menu-pop">
                <button
                  onClick={() => {
                    void navigator.clipboard?.writeText(i.identifier);
                    setMenuOpen(false);
                  }}
                >
                  Copy id
                </button>
                {i.url && (
                  <a
                    href={i.url}
                    target="_blank"
                    rel="noreferrer"
                    onClick={() => setMenuOpen(false)}
                  >
                    Open link ↗
                  </a>
                )}
                {worktree && (
                  <a
                    href={`vscode://file${encodeURI(worktree)}`}
                    onClick={() => setMenuOpen(false)}
                  >
                    Open in VS Code ↗
                  </a>
                )}
              </div>
            )}
            <button class="iconbtn" data-test="ticket-close" onClick={props.onClose}>
              ×
            </button>
          </div>
        </div>

        <div class="ticket-body">
          <div class="ticket-main">
            <div>
              <input
                class="title-edit"
                data-test="edit-title"
                value={title}
                onInput={(e) => {
                  setTitle((e.target as HTMLInputElement).value);
                  touch();
                }}
              />
              <div class="opened">Opened {fmt(detail?.createdAt ?? i.createdAt)}</div>
            </div>

            {err && (
              <div class="err-banner" style="border-radius:7px">
                {err}
              </div>
            )}

            <div class="section">
              <div class="label">Description</div>
              {editingDesc ? (
                <textarea
                  class="desc-edit"
                  data-test="edit-description"
                  autofocus
                  placeholder="Add a description… (markdown)"
                  value={description}
                  onInput={(e) => {
                    setDescription((e.target as HTMLTextAreaElement).value);
                    touch();
                  }}
                  onBlur={() => setEditingDesc(false)}
                />
              ) : (
                <div
                  class="desc desc-view"
                  data-test="desc-view"
                  title="Click to edit"
                  onClick={() => setEditingDesc(true)}
                >
                  {description.trim() ? (
                    description
                  ) : (
                    <span class="empty">Add a description… (markdown)</span>
                  )}
                </div>
              )}
            </div>

            <div class="section">
              <div class="label">
                Attachments
                {attachments.length > 0 && <span class="count">{attachments.length}</span>}
              </div>
              <input
                type="file"
                multiple
                ref={attFileRef}
                data-test="att-files"
                style="display:none"
                accept="image/*,.md,.log,.txt,.json,.patch,.diff"
                onChange={(e) => {
                  void addAttachments((e.target as HTMLInputElement).files);
                  (e.target as HTMLInputElement).value = '';
                }}
              />
              <div class="att-grid">
                <div
                  class={`dropzone${attOver ? ' over' : ''}`}
                  onClick={() => attFileRef.current?.click()}
                  onDragOver={(e) => {
                    e.preventDefault();
                    setAttOver(true);
                  }}
                  onDragLeave={() => setAttOver(false)}
                  onDrop={(e) => {
                    e.preventDefault();
                    setAttOver(false);
                    void addAttachments(e.dataTransfer?.files ?? null);
                  }}
                >
                  <span class="ic">↑</span>
                  <span class="t">Add files</span>
                  <span class="h">drop screenshots or click</span>
                </div>
                {attachments.map((a) => (
                  <div class="att" key={a.url}>
                    {isImageUrl(a.url) ? (
                      <img
                        src={a.url}
                        alt={a.title}
                        style="width:100%;height:100%;object-fit:cover"
                      />
                    ) : (
                      <span class="ext">{extOf(a.url)}</span>
                    )}
                    <button
                      class="rm"
                      data-test="att-remove"
                      disabled={busy}
                      onClick={() => void removeAtt(a.url)}
                    >
                      ×
                    </button>
                    <span class="name">{a.title}</span>
                  </div>
                ))}
              </div>
            </div>

            <div class="section">
              <div class="subtabs">
                <button class={tab === 'comments' ? 'on' : ''} onClick={() => setTab('comments')}>
                  Comments
                </button>
                <button class={tab === 'history' ? 'on' : ''} onClick={() => setTab('history')}>
                  History
                </button>
              </div>

              {tab === 'comments' && (
                <div class="stream" data-test="detail-comments">
                  {detail && detail.comments.length === 0 && <div class="empty">no comments</div>}
                  {detail?.comments.map((c, n) => (
                    <div class="cmt" key={n}>
                      <div class="avatar">•</div>
                      <div class="body">
                        <div class="by">
                          <span class="when">{fmt(c.at)}</span>
                        </div>
                        <div class="txt">{c.body}</div>
                      </div>
                    </div>
                  ))}
                  <div class="cmt">
                    <div class="avatar">Y</div>
                    <div class="body">
                      <textarea
                        data-test="detail-comment"
                        placeholder="Add a comment…"
                        value={comment}
                        onInput={(e) => setComment((e.target as HTMLTextAreaElement).value)}
                      />
                      <div class="modal-actions" style="margin-top:9px">
                        <button
                          class="btn primary sm"
                          disabled={busy || !comment.trim()}
                          onClick={submitComment}
                        >
                          Comment
                        </button>
                      </div>
                    </div>
                  </div>
                </div>
              )}

              {tab === 'history' && (
                <div style="margin-top:14px" data-test="detail-history">
                  {!detail && <div class="empty">loading…</div>}
                  {detail && detail.activity.length === 0 && <div class="empty">no activity</div>}
                  {detail?.activity.map((a, n) => (
                    <div class="event" key={n}>
                      <span class="when">{fmt(a.at)}</span>
                      <span>{describeActivity(a)}</span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>

          <div class="ticket-side">
            {isRunning && props.onViewRunningAgent ? (
              <button
                class="btn primary block dispatch-btn"
                data-test="view-running-agent"
                title="Open the live agent view for this ticket"
                onClick={() => props.onViewRunningAgent?.(i.id)}
              >
                ▶ View running agent
              </button>
            ) : !isTerminalState && reworkState ? (
              <button
                class="btn primary block dispatch-btn"
                data-test="dispatch-agent"
                disabled={busy}
                title={`Dispatch — move to ${reworkState.name} and run now`}
                onClick={() => void dispatch()}
              >
                ▶ Dispatch to agent
              </button>
            ) : null}

            <label class="field" style="margin:0">
              <span>Status</span>
              <select
                data-test="detail-state"
                disabled={busy}
                value={currentState}
                onChange={(e) => {
                  const name = (e.target as HTMLSelectElement).value;
                  const st = props.states.find((s) => s.name === name);
                  if (st && st.name !== currentState) void move(st.id);
                }}
              >
                {props.states.map((s) => (
                  <option key={s.id} value={s.name}>
                    {s.name}
                  </option>
                ))}
              </select>
            </label>

            <div class="field" style="margin:0">
              <span>Assignee</span>
              <div class="assignee" data-test="assignee">
                <span class="ai-badge">AI</span>
                <span class="an">{backend}</span>
              </div>
            </div>

            <label class="field" style="margin:0">
              <span>Priority</span>
              <select
                data-test="edit-priority"
                disabled={busy}
                value={priority === null ? 'none' : String(priority)}
                onChange={(e) => {
                  const v = (e.target as HTMLSelectElement).value;
                  setPriority(v === 'none' ? null : Number(v));
                  touch();
                }}
              >
                {PRIORITIES.map((p) => (
                  <option key={p.label} value={p.value === null ? 'none' : String(p.value)}>
                    {p.label}
                  </option>
                ))}
              </select>
            </label>

            <label class="field" style="margin:0">
              <span>Model</span>
              <select
                data-test="edit-model"
                disabled={busy}
                value={model}
                onChange={(e) => {
                  setModel((e.target as HTMLSelectElement).value);
                  touch();
                }}
              >
                {MODELS.map((m) => (
                  <option key={m.value} value={m.value}>
                    {m.label}
                  </option>
                ))}
              </select>
            </label>

            <label class="field" style="margin:0">
              <span>Effort</span>
              <select
                data-test="edit-effort"
                disabled={busy}
                value={effort}
                onChange={(e) => {
                  setEffort((e.target as HTMLSelectElement).value as '' | AgentEffort);
                  touch();
                }}
              >
                {EFFORTS.map((x) => (
                  <option key={x.value} value={x.value}>
                    {x.label}
                  </option>
                ))}
              </select>
            </label>

            <div>
              <div class="label">Labels</div>
              <div class="chips" style="margin-bottom:8px">
                {labels.length === 0 && <span class="empty">none</span>}
                {labels.map((l) => (
                  <span class="chip dim label-chip" key={l}>
                    {l}
                    <button class="label-x" data-test="label-remove" onClick={() => removeLabel(l)}>
                      ×
                    </button>
                  </span>
                ))}
              </div>
              <input
                data-test="label-add"
                list="ticket-labels"
                placeholder="add label…"
                value={labelInput}
                onInput={(e) => setLabelInput((e.target as HTMLInputElement).value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault();
                    addLabel(labelInput);
                  }
                }}
              />
              <datalist id="ticket-labels">
                {labelOpts.map((l) => (
                  <option key={l.id} value={l.name} />
                ))}
              </datalist>
            </div>

            {inReview && (
              <>
                <div class="hr" />
                <div class="review-actions" data-test="review-actions">
                  <div class="label">Review</div>
                  <textarea
                    class="review-notes"
                    data-test="review-notes"
                    placeholder="Notes (optional, attached to the action)…"
                    value={reviewNotes}
                    disabled={busy}
                    onInput={(e) => setReviewNotes((e.target as HTMLTextAreaElement).value)}
                  />
                  <div class="review-btns">
                    <button
                      class="btn sm primary"
                      data-test="review-accept"
                      disabled={busy || !doneState}
                      title={doneState ? 'Accept — move to Done' : 'no Done state in workflow'}
                      onClick={() => void reviewMove(doneState)}
                    >
                      Accept
                    </button>
                    <button
                      class="btn sm"
                      data-test="review-rework"
                      disabled={busy || !reworkState}
                      title={
                        reworkState
                          ? `Rework — tag 'rework' and send back to ${reworkState.name}`
                          : 'no In Progress state'
                      }
                      onClick={() => void reworkAction()}
                    >
                      Rework
                    </button>
                    <button
                      class="btn sm danger"
                      data-test="review-discard"
                      disabled={busy || !cancelledState}
                      title={cancelledState ? 'Discard — move to Cancelled' : 'no Cancelled state'}
                      onClick={() => void reviewMove(cancelledState)}
                    >
                      Discard
                    </button>
                  </div>
                </div>
              </>
            )}

            <div class="hr" />

            <div style="display:flex;flex-direction:column;gap:11px">
              <div class="side-row">
                <span class="k">Branch</span>
                <span class="v blue">{branch}</span>
              </div>
              {worktree && (
                <div class="side-row">
                  <span class="k">Workspace</span>
                  <a
                    class="v blue"
                    data-test="open-vscode"
                    href={`vscode://file${encodeURI(worktree)}`}
                    title={worktree}
                  >
                    open in VS Code ↗
                  </a>
                </div>
              )}
              <div class="side-row">
                <span class="k">Backend</span>
                <span class="v">{backend}</span>
              </div>
              {props.session && (
                <div class="side-row">
                  <span class="k">Last run</span>
                  <span class="v">
                    turn {props.session.turn_count}
                    {props.session.continuation_count > 0
                      ? ` · ↻${props.session.continuation_count}`
                      : ''}
                  </span>
                </div>
              )}
              {detail?.usage && detail.usage.total_tokens > 0 && (
                <div class="side-row">
                  <span class="k">Usage</span>
                  <span class="v" title="cumulative tokens (input+output) for this task">
                    {fmtTokens(detail.usage.total_tokens)} tok
                    {fmtCost(detail.usage.cost_usd) ? ` · ${fmtCost(detail.usage.cost_usd)}` : ''}
                  </span>
                </div>
              )}
              <div class="side-row">
                <span class="k">Created</span>
                <span class="v">{fmt(detail?.createdAt ?? i.createdAt)}</span>
              </div>
              <div class="side-row">
                <span class="k">Updated</span>
                <span class="v">{fmt(detail?.updatedAt ?? i.updatedAt)}</span>
              </div>
              {i.url && (
                <div class="side-row">
                  <span class="k">Link</span>
                  <a class="v blue" href={i.url} target="_blank" rel="noreferrer">
                    open ↗
                  </a>
                </div>
              )}
            </div>
          </div>
        </div>

        <div class="ticket-foot">
          <div class="foot-left">
            {confirmDelete ? (
              <div class="confirm-del" data-test="confirm-delete">
                <span>Delete this ticket?</span>
                <button
                  class="btn danger sm"
                  data-test="confirm-delete-yes"
                  disabled={busy}
                  onClick={() => void del()}
                >
                  {busy ? 'Deleting…' : 'Delete'}
                </button>
                <button
                  class="btn ghost sm"
                  disabled={busy}
                  onClick={() => setConfirmDelete(false)}
                >
                  Keep
                </button>
              </div>
            ) : (
              <button
                class="btn danger sm"
                data-test="ticket-delete"
                disabled={isRunning}
                title={isRunning ? 'terminate the agent first' : 'Delete this ticket'}
                onClick={() => setConfirmDelete(true)}
              >
                Delete
              </button>
            )}
          </div>
          <div style="display:flex;align-items:center;gap:9px">
            <span class="muted" style="font-size:11.5px">
              {saved ? 'Saved ✓' : dirty ? 'Unsaved changes' : ''}
            </span>
            <button class="btn ghost sm" onClick={props.onClose}>
              Cancel
            </button>
            <button
              class="btn primary sm"
              data-test="ticket-save"
              disabled={busy || !dirty}
              onClick={save}
            >
              {busy ? 'Saving…' : 'Save changes'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
