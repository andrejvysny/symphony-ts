import { useCallback, useEffect, useRef, useState } from 'preact/hooks';
import {
  api,
  type BoardIssueDTO,
  type BoardStateDTO,
  type IssueDetailDTO,
  type LabelInfo,
  type RuntimeInfo,
  type SessionInfo,
} from './api.js';
import { describeActivity, fmt, StatusPill } from './util.js';

const PRIORITIES: { value: number | null; label: string }[] = [
  { value: 1, label: 'Urgent' },
  { value: 2, label: 'High' },
  { value: 3, label: 'Medium' },
  { value: 4, label: 'Low' },
  { value: null, label: 'None' },
];

interface Attachment {
  id: number;
  file: File;
  preview: string | null;
  ext: string;
}

export function CreateTicketModal(props: {
  states: BoardStateDTO[];
  onClose: () => void;
  onCreated: () => void;
}) {
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [stateId, setStateId] = useState(props.states[0]?.id ?? '');
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
      <div class="modal" data-test="create-modal" onClick={(e) => e.stopPropagation()}>
        <h3>New ticket</h3>
        {err && (
          <div class="err-banner" style="border-radius:7px;margin-bottom:8px">
            {err}
          </div>
        )}
        <label class="field">
          <span>Title</span>
          <input
            data-test="ticket-title"
            value={title}
            onInput={(e) => setTitle((e.target as HTMLInputElement).value)}
          />
        </label>
        <label class="field">
          <span>Description (markdown)</span>
          <textarea
            data-test="ticket-desc"
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
}) {
  const i = props.issue;
  const [detail, setDetail] = useState<IssueDetailDTO | null>(null);
  const [tab, setTab] = useState<'comments' | 'history'>('comments');
  const [comment, setComment] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  // Editable fields (status uses the dedicated instant-move path below).
  const [title, setTitle] = useState(i.title);
  const [description, setDescription] = useState('');
  const [priority, setPriority] = useState<number | null>(i.priority);
  const [labels, setLabels] = useState<string[]>(i.labels);
  const [labelInput, setLabelInput] = useState('');
  const [labelOpts, setLabelOpts] = useState<LabelInfo[]>([]);
  const [dirty, setDirty] = useState(false);
  const dirtyRef = useRef(false);
  const touch = () => {
    dirtyRef.current = true;
    setDirty(true);
    setSaved(false);
  };

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
      await api.updateIssue(i.id, { title: title.trim(), description, priority, labels });
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

  const branch = `${props.meta?.branch_prefix ?? 'symphony/'}${i.identifier}`;
  const backend = props.session?.backend ?? props.meta?.backend ?? '—';
  const scope = i.identifier.split('-')[0] ?? 'SYM';

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
          <button class="iconbtn" data-test="ticket-close" onClick={props.onClose}>
            ×
          </button>
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
              <div class="opened">Updated {fmt(detail?.updatedAt ?? i.updatedAt)}</div>
            </div>

            {err && (
              <div class="err-banner" style="border-radius:7px">
                {err}
              </div>
            )}

            <div class="section">
              <div class="label">Description</div>
              <textarea
                class="desc-edit"
                data-test="edit-description"
                placeholder="Add a description… (markdown)"
                value={description}
                onInput={(e) => {
                  setDescription((e.target as HTMLTextAreaElement).value);
                  touch();
                }}
              />
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

            <div class="hr" />

            <div style="display:flex;flex-direction:column;gap:11px">
              <div class="side-row">
                <span class="k">Branch</span>
                <span class="v blue">{branch}</span>
              </div>
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
              <div class="side-row">
                <span class="k">Created</span>
                <span class="v">{fmt(detail?.createdAt ?? i.createdAt)}</span>
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
          <span class="muted" style="font-size:11.5px">
            {saved ? 'Saved ✓' : dirty ? 'Unsaved changes' : ''}
          </span>
          <div style="display:flex;gap:9px">
            <button class="btn ghost sm" onClick={props.onClose}>
              Close
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
