import { useEffect, useRef, useState } from 'preact/hooks';
import { api, type ProjectDTO } from './api.js';

/** Header dropdown: shows the active project and lets the operator switch / create projects. */
export function ProjectSwitcher(props: {
  projects: ProjectDTO[];
  activeProjectId: string | null;
  switching: boolean;
  onSwitch: (projectId: string) => void;
  onNew: () => void;
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
              <button
                class={`menu-item${p.active ? ' on' : ''}`}
                key={p.project_id}
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
              <span class="mi-name">New project</span>
              <span class="mi-sub">create a Plane project + repo</span>
            </span>
          </button>
        </div>
      )}
    </div>
  );
}

/** Slugify a project name into a Plane identifier (uppercase, alnum, ≤8 chars). */
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
        <h3>New project</h3>
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
          <span>Identifier (Plane prefix)</span>
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
          <span>Repo folder (local path or git URL)</span>
          <input
            data-test="project-repo"
            placeholder="~/code/my-project"
            value={repo}
            onInput={(e) => setRepo((e.target as HTMLInputElement).value)}
          />
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
