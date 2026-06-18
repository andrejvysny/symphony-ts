import { useEffect, useState } from 'preact/hooks';
import { api, type SettingsDTO } from './api.js';

const BACKENDS = ['claude-sdk', 'claude-cli', 'codex-cli', 'opencode-cli'];
const PERMISSION_MODES = ['default', 'acceptEdits', 'bypassPermissions', 'plan'];

/** Settings screen (modal overlay): edit runtime preferences, persisted to WORKFLOW.md. */
export function SettingsModal(props: { onClose: () => void; onSaved: () => void }) {
  const [form, setForm] = useState<SettingsDTO | null>(null);
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    api
      .settings()
      .then(setForm)
      .catch((e) => setErr((e as Error).message));
  }, []);

  const setAgent = <K extends keyof SettingsDTO['agent']>(k: K, v: SettingsDTO['agent'][K]) => {
    setForm((f) => (f ? { ...f, agent: { ...f.agent, [k]: v } } : f));
    setSaved(false);
  };

  const setWorkspace = <K extends keyof SettingsDTO['workspace']>(
    k: K,
    v: SettingsDTO['workspace'][K],
  ) => {
    setForm((f) => (f ? { ...f, workspace: { ...f.workspace, [k]: v } } : f));
    setSaved(false);
  };

  const save = async () => {
    if (!form) return;
    setBusy(true);
    setErr(null);
    try {
      await api.updateSettings({
        agent: {
          backend: form.agent.backend,
          model: form.agent.model?.trim() ? form.agent.model.trim() : null,
          permission_mode: form.agent.permission_mode,
          max_turns: form.agent.max_turns,
          max_continuations: form.agent.max_continuations,
          max_concurrent_agents: form.agent.max_concurrent_agents,
          max_retry_backoff_ms: form.agent.max_retry_backoff_ms,
          turn_timeout_ms: form.agent.turn_timeout_ms,
          stall_timeout_ms: form.agent.stall_timeout_ms,
          tmux: form.agent.tmux,
          max_budget_usd: form.agent.max_budget_usd,
        },
        polling: { interval_ms: form.polling.interval_ms },
        workspace: {
          branch_prefix: form.workspace.branch_prefix,
          mode: form.workspace.mode,
          merge_on_accept: form.workspace.merge_on_accept,
        },
      });
      setSaved(true);
      props.onSaved();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const numField = (label: string, value: number, onChange: (n: number) => void, test: string) => (
    <label class="field">
      <span>{label}</span>
      <input
        type="number"
        data-test={test}
        value={String(value)}
        onInput={(e) => {
          const n = Number((e.target as HTMLInputElement).value);
          if (Number.isFinite(n)) onChange(n);
        }}
      />
    </label>
  );

  return (
    <div class="overlay" onClick={props.onClose}>
      <div class="modal settings" data-test="settings-modal" onClick={(e) => e.stopPropagation()}>
        <h3>Settings</h3>
        {err && (
          <div class="err-banner" style="border-radius:7px;margin-bottom:8px">
            {err}
          </div>
        )}
        {!form && !err && <div class="empty">loading…</div>}
        {form && (
          <div class="settings-body">
            <div class="settings-group">
              <div class="settings-h">Agent</div>
              <label class="field">
                <span>Backend</span>
                <select
                  data-test="set-backend"
                  value={form.agent.backend}
                  onChange={(e) => setAgent('backend', (e.target as HTMLSelectElement).value)}
                >
                  {BACKENDS.map((b) => (
                    <option key={b} value={b}>
                      {b}
                    </option>
                  ))}
                </select>
              </label>
              <label class="field">
                <span>Model (optional)</span>
                <input
                  data-test="set-model"
                  placeholder="default"
                  value={form.agent.model ?? ''}
                  onInput={(e) => setAgent('model', (e.target as HTMLInputElement).value)}
                />
              </label>
              <label class="field">
                <span>Permission mode</span>
                <select
                  data-test="set-permission"
                  value={form.agent.permission_mode}
                  onChange={(e) =>
                    setAgent('permission_mode', (e.target as HTMLSelectElement).value)
                  }
                >
                  {PERMISSION_MODES.map((p) => (
                    <option key={p} value={p}>
                      {p}
                    </option>
                  ))}
                </select>
              </label>
              <div class="settings-row">
                {numField(
                  'Max concurrent agents',
                  form.agent.max_concurrent_agents,
                  (n) => setAgent('max_concurrent_agents', n),
                  'set-max-concurrent',
                )}
                {numField(
                  'Max turns',
                  form.agent.max_turns,
                  (n) => setAgent('max_turns', n),
                  'set-max-turns',
                )}
              </div>
              <div class="settings-row">
                {numField(
                  'Max continuations',
                  form.agent.max_continuations,
                  (n) => setAgent('max_continuations', n),
                  'set-max-continuations',
                )}
                {numField(
                  'Turn timeout (ms)',
                  form.agent.turn_timeout_ms,
                  (n) => setAgent('turn_timeout_ms', n),
                  'set-turn-timeout',
                )}
              </div>
              <div class="settings-row">
                {numField(
                  'Stall timeout (ms)',
                  form.agent.stall_timeout_ms,
                  (n) => setAgent('stall_timeout_ms', n),
                  'set-stall-timeout',
                )}
                {numField(
                  'Max retry backoff (ms)',
                  form.agent.max_retry_backoff_ms,
                  (n) => setAgent('max_retry_backoff_ms', n),
                  'set-retry-backoff',
                )}
              </div>
              <label class="field check">
                <input
                  type="checkbox"
                  data-test="set-tmux"
                  checked={form.agent.tmux}
                  onChange={(e) => setAgent('tmux', (e.target as HTMLInputElement).checked)}
                />
                <span>Supervise CLI agents under tmux</span>
              </label>
            </div>

            <div class="settings-group">
              <div class="settings-h">Polling &amp; workspace</div>
              {numField(
                'Poll interval (ms)',
                form.polling.interval_ms,
                (n) => setForm((f) => (f ? { ...f, polling: { interval_ms: n } } : f)),
                'set-poll-interval',
              )}
              <label class="field">
                <span>Workspace mode</span>
                <select
                  data-test="set-workspace-mode"
                  value={form.workspace.mode}
                  onChange={(e) => setWorkspace('mode', (e.target as HTMLSelectElement).value)}
                >
                  <option value="single_dir">
                    single_dir — one project dir, one task at a time
                  </option>
                  <option value="worktree">worktree — isolated per-ticket worktrees</option>
                </select>
              </label>
              <span class="muted" style="font-size:11px">
                Mode applies immediately when no agents are running; otherwise on the next restart.
              </span>
              {form.workspace.mode === 'worktree' && (
                <>
                  <label class="field">
                    <span>Branch prefix</span>
                    <input
                      data-test="set-branch-prefix"
                      value={form.workspace.branch_prefix}
                      onInput={(e) =>
                        setWorkspace('branch_prefix', (e.target as HTMLInputElement).value)
                      }
                    />
                  </label>
                  <label class="field check">
                    <input
                      type="checkbox"
                      data-test="set-merge-on-accept"
                      checked={form.workspace.merge_on_accept}
                      onChange={(e) =>
                        setWorkspace('merge_on_accept', (e.target as HTMLInputElement).checked)
                      }
                    />
                    <span>Merge the issue branch into base on accept</span>
                  </label>
                </>
              )}
            </div>
          </div>
        )}
        <div class="modal-actions">
          <span class="muted" style="margin-right:auto;font-size:11.5px">
            {saved ? 'Saved ✓' : ''}
          </span>
          <button class="btn ghost sm" onClick={props.onClose}>
            Close
          </button>
          <button
            class="btn primary sm"
            data-test="settings-save"
            disabled={busy || !form}
            onClick={save}
          >
            {busy ? 'Saving…' : 'Save'}
          </button>
        </div>
      </div>
    </div>
  );
}
