import { useEffect, useRef, useState } from 'preact/hooks';
import { api, type ProjectDTO } from './api.js';

/** Header dropdown: shows the active project and lets the operator switch / create projects. */
export function ProjectSwitcher(props: {
  projects: ProjectDTO[];
  activeProjectId: string | null;
  switching: boolean;
  onSwitch: (projectId: string) => void;
  onNew: () => void;
  onManage: () => void;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, [open]);

  const active = props.projects.find((p) => p.project_id === props.activeProjectId);
  const label = props.switching ? 'switching…' : (active?.name ?? 'No project');

  return (
    <div class="proj" ref={ref}>
      <button
        class="proj-btn"
        data-test="project-switcher"
        disabled={props.switching}
        onClick={() => setOpen((o) => !o)}
      >
        <span class="proj-ico">▦</span>
        <span class="proj-name">{label}</span>
        <span class="proj-caret">▾</span>
      </button>
      {open && (
        <div class="menu" data-test="project-menu">
          <div class="menu-head">Projects</div>
          {props.projects.length === 0 && <div class="menu-empty">no projects found</div>}
          {props.projects.map((p) => {
            const switchable = p.registered && !p.active;
            return (
              <div class="menu-row" key={p.project_id}>
                <button
                  class={`menu-item${p.active ? ' on' : ''}`}
                  data-test="project-item"
                  disabled={!switchable}
                  title={p.registered ? (p.repo ?? '') : 'not registered — create it to switch'}
                  onClick={() => {
                    if (!switchable) return;
                    setOpen(false);
                    props.onSwitch(p.project_id);
                  }}
                >
                  <span class="mi-check">{p.active ? '✓' : ''}</span>
                  <span class="mi-body">
                    <span class="mi-name">
                      {p.name}
                      {p.identifier ? <span class="mi-id"> {p.identifier}</span> : null}
                    </span>
                    <span class="mi-sub">{p.registered ? (p.repo ?? '—') : 'not registered'}</span>
                  </span>
                </button>
                {p.repo_path && (
                  <a
                    class="mi-open"
                    data-test="project-open"
                    title={`Open ${p.repo_path} in VS Code`}
                    href={`vscode://file${p.repo_path}`}
                    onClick={(e) => e.stopPropagation()}
                  >
                    ↗
                  </a>
                )}
              </div>
            );
          })}
          <div class="menu-sep" />
          <button
            class="menu-item add"
            data-test="project-new"
            onClick={() => {
              setOpen(false);
              props.onNew();
            }}
          >
            <span class="mi-check">+</span>
            <span class="mi-body">
              <span class="mi-name">Add / import project</span>
              <span class="mi-sub">point at a folder — created + git-initialized if needed</span>
            </span>
          </button>
          <button
            class="menu-item manage"
            data-test="project-manage"
            onClick={() => {
              setOpen(false);
              props.onManage();
            }}
          >
            <span class="mi-check">⚙</span>
            <span class="mi-body">
              <span class="mi-name">Manage projects</span>
              <span class="mi-sub">rename · re-point · remove</span>
            </span>
          </button>
        </div>
      )}
    </div>
  );
}

/** Slugify a project name into an issue identifier prefix (uppercase, alnum, ≤8 chars). */
function deriveIdentifier(name: string): string {
  return name
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '')
    .slice(0, 8);
}

export function CreateProjectModal(props: {
  onClose: () => void;
  onCreated: (project: ProjectDTO) => void;
}) {
  const [name, setName] = useState('');
  const [identifier, setIdentifier] = useState('');
  const [idEdited, setIdEdited] = useState(false);
  const [repo, setRepo] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const onName = (v: string) => {
    setName(v);
    if (!idEdited) setIdentifier(deriveIdentifier(v));
  };

  const submit = async () => {
    if (!name.trim() || !identifier.trim() || !repo.trim()) {
      setErr('Name, identifier and repo are all required');
      return;
    }
    setBusy(true);
    setErr(null);
    try {
      const created = await api.createProject({
        name: name.trim(),
        identifier: identifier.trim(),
        repo: repo.trim(),
      });
      props.onCreated(created);
    } catch (e) {
      setErr((e as Error).message);
      setBusy(false);
    }
  };

  return (
    <div class="overlay" onClick={props.onClose}>
      <div class="modal" data-test="create-project-modal" onClick={(e) => e.stopPropagation()}>
        <h3>Add / import project</h3>
        {err && (
          <div class="err-banner" style="border-radius:7px;margin-bottom:8px">
            {err}
          </div>
        )}
        <label class="field">
          <span>Name</span>
          <input
            data-test="project-name"
            value={name}
            onInput={(e) => onName((e.target as HTMLInputElement).value)}
          />
        </label>
        <label class="field">
          <span>Identifier (issue id prefix)</span>
          <input
            data-test="project-identifier"
            value={identifier}
            onInput={(e) => {
              setIdEdited(true);
              setIdentifier((e.target as HTMLInputElement).value.toUpperCase());
            }}
          />
        </label>
        <label class="field">
          <span>Project folder</span>
          <input
            data-test="project-repo"
            placeholder="~/code/my-project"
            value={repo}
            onInput={(e) => setRepo((e.target as HTMLInputElement).value)}
          />
          <span class="field-hint">
            An existing folder is imported as-is; a missing one is created and git-initialized on
            first switch.
          </span>
        </label>
        <div class="modal-actions">
          <button class="btn ghost sm" onClick={props.onClose}>
            Cancel
          </button>
          <button
            class="btn primary sm"
            data-test="project-create-submit"
            disabled={busy}
            onClick={submit}
          >
            {busy ? 'Creating…' : 'Create project'}
          </button>
        </div>
      </div>
    </div>
  );
}

/** List + manage projects: switch, rename, re-point (move), and remove (unregister, keeps data). */
export function ManageProjectsModal(props: {
  projects: ProjectDTO[];
  onClose: () => void;
  onChanged: () => void;
  onSwitch: (projectId: string) => void;
  onAdd: () => void;
  /** Detach the active project (no project active → dashboard shows the create/open prompt). */
  onCloseProject: () => void;
}) {
  const hasActive = props.projects.some((p) => p.active);
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [edit, setEdit] = useState<{ id: string; field: 'name' | 'repo'; value: string } | null>(
    null,
  );
  const [confirmRemove, setConfirmRemove] = useState<string | null>(null);

  const run = async (id: string, fn: () => Promise<unknown>) => {
    setBusy(id);
    setErr(null);
    try {
      await fn();
      props.onChanged();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(null);
    }
  };

  const saveEdit = async () => {
    if (!edit) return;
    const value = edit.value.trim();
    const { id, field } = edit;
    setEdit(null);
    if (!value) return;
    const patch = field === 'repo' ? { repo: value } : { name: value };
    await run(id, () => api.updateProject(id, patch));
  };

  return (
    <div class="overlay" onClick={props.onClose}>
      <div
        class="modal pm-modal"
        data-test="manage-projects-modal"
        onClick={(e) => e.stopPropagation()}
      >
        <div class="modal-head">
          <h3>Projects</h3>
          <button class="iconbtn" data-test="pm-close" title="Close" onClick={props.onClose}>
            ×
          </button>
        </div>
        {err && (
          <div class="err-banner" style="border-radius:7px;margin-bottom:8px">
            {err}
          </div>
        )}
        <div class="pm-list" data-test="pm-list">
          {props.projects.length === 0 && <div class="menu-empty">no projects found</div>}
          {props.projects.map((p) => {
            const ed = edit && edit.id === p.project_id ? edit : null;
            const rowBusy = busy === p.project_id;
            return (
              <div
                class={`pm-row${p.active ? ' active' : ''}`}
                key={p.project_id}
                data-test="pm-row"
              >
                <div class="pm-main">
                  <div class="pm-name">
                    <span class="pm-title">{p.name}</span>
                    {p.identifier && <span class="mi-id">{p.identifier}</span>}
                    {p.active && <span class="pm-badge on">active</span>}
                    {!p.registered && <span class="pm-badge muted">not registered</span>}
                  </div>
                  {ed ? (
                    <div class="pm-edit">
                      <input
                        autofocus
                        data-test="pm-edit-input"
                        value={ed.value}
                        placeholder={ed.field === 'repo' ? '~/code/my-project' : 'Project name'}
                        onInput={(e) =>
                          setEdit({ ...ed, value: (e.target as HTMLInputElement).value })
                        }
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') {
                            e.preventDefault();
                            void saveEdit();
                          }
                          if (e.key === 'Escape') setEdit(null);
                        }}
                      />
                      <button
                        class="btn primary sm"
                        disabled={rowBusy}
                        onClick={() => void saveEdit()}
                      >
                        Save
                      </button>
                      <button class="btn ghost sm" onClick={() => setEdit(null)}>
                        Cancel
                      </button>
                      {ed.field === 'repo' && p.active && (
                        <span class="pm-warn">re-points the live workspace — restarts agents</span>
                      )}
                    </div>
                  ) : (
                    <div class="pm-sub">
                      {p.repo_path ?? p.repo ?? (p.registered ? '—' : 'on disk, unregistered')}
                    </div>
                  )}
                </div>
                {!ed && (
                  <div class="pm-actions">
                    {p.repo_path && (
                      <a
                        class="iconbtn"
                        data-test="pm-open"
                        title={`Open ${p.repo_path} in VS Code`}
                        href={`vscode://file${p.repo_path}`}
                        onClick={(e) => e.stopPropagation()}
                      >
                        ↗
                      </a>
                    )}
                    {p.registered && !p.active && (
                      <button
                        class="btn ghost sm"
                        data-test="pm-switch"
                        disabled={rowBusy}
                        onClick={() => props.onSwitch(p.project_id)}
                      >
                        Switch
                      </button>
                    )}
                    {p.registered && (
                      <>
                        <button
                          class="btn ghost sm"
                          data-test="pm-rename"
                          disabled={rowBusy}
                          onClick={() =>
                            setEdit({ id: p.project_id, field: 'name', value: p.name })
                          }
                        >
                          Rename
                        </button>
                        <button
                          class="btn ghost sm"
                          data-test="pm-repoint"
                          disabled={rowBusy}
                          onClick={() =>
                            setEdit({ id: p.project_id, field: 'repo', value: p.repo ?? '' })
                          }
                        >
                          Re-point
                        </button>
                        {confirmRemove === p.project_id ? (
                          <span class="pm-confirm" data-test="pm-confirm-remove">
                            <button
                              class="btn danger sm"
                              disabled={rowBusy}
                              onClick={() => {
                                setConfirmRemove(null);
                                void run(p.project_id, () => api.removeProject(p.project_id));
                              }}
                            >
                              Remove
                            </button>
                            <button class="btn ghost sm" onClick={() => setConfirmRemove(null)}>
                              Keep
                            </button>
                          </span>
                        ) : (
                          <button
                            class="btn danger sm"
                            data-test="pm-remove"
                            disabled={rowBusy || p.active}
                            title={
                              p.active
                                ? 'switch to another project first'
                                : 'unregister (keeps task data on disk)'
                            }
                            onClick={() => setConfirmRemove(p.project_id)}
                          >
                            Remove
                          </button>
                        )}
                      </>
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>
        <div class="modal-actions" style="justify-content:space-between">
          <button class="btn sm" data-test="pm-add" onClick={props.onAdd}>
            + Add / import project
          </button>
          <div style="display:flex;gap:8px">
            {hasActive && (
              <button
                class="btn ghost sm"
                data-test="pm-close-project"
                title="Detach the active project (no project active)"
                onClick={props.onCloseProject}
              >
                Close project
              </button>
            )}
            <button class="btn ghost sm" onClick={props.onClose}>
              Done
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
