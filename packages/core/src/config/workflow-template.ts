/**
 * Concise, ready-to-run starter `WORKFLOW.md` written by `symphony init`. Embedded as a constant
 * (not a runtime file read) so it works identically from the bundled CLI and from source/dev — a
 * `new URL('./file', import.meta.url)` lookup would resolve into `src/` under tsx. It parses into a
 * valid config (single_dir + claude-sdk, no active project) and renders via PromptBuilder. The full
 * annotated reference lives in `WORKFLOW.md.example` (shipped next to the CLI and on GitHub).
 */
export const WORKFLOW_TEMPLATE = `---
# Symphony workflow config. Edit as needed, then run:  symphony --port 4500
# Full annotated reference: WORKFLOW.md.example (shipped next to this CLI) or
# https://github.com/andrejvysny/symphony-ts/blob/master/WORKFLOW.md.example

tracker:
  kind: file
  # Local JSON task store root (no database, no services). Defaults to ~/.symphony.
  data_root: ~/.symphony
  # Leave project_id unset to start with NO active project — open the dashboard and use
  # "+ New project" to create or select one (the choice is written back here). There is no
  # implicit default project.
  # project_id: my-project

workspace:
  # single_dir (default): the agent works DIRECTLY in \`repo\` on its current branch, ONE task at a
  # time, so tasks build on each other. worktree: isolate each ticket in its own git worktree.
  mode: single_dir
  # The project repo — a LOCAL git path. You can also set this per-project from the dashboard.
  # repo: ~/code/your-repo

agent:
  backend: claude-sdk          # claude-sdk | claude-cli | codex-cli | opencode-cli
  permission_mode: bypassPermissions
  max_concurrent_agents: 5

server:
  port: 4500                   # dashboard at http://127.0.0.1:4500/
---

You have been assigned issue {{ issue.identifier }}: "{{ issue.title }}".

<issue>
Identifier: {{ issue.identifier }}
Issue id (pass as task_id to the tracker tools): {{ issue.id }}
Title: {{ issue.title }}
{% if issue.priority %}Priority: {{ issue.priority }}
{% endif %}{% if issue.labels.size > 0 %}Labels: {{ issue.labels | join: ", " }}
{% endif %}Description:
{% if issue.description %}{{ issue.description }}{% else %}(No description was provided. Treat the title as the specification; if it is too vague to implement safely, follow the blocked protocol.){% endif %}
</issue>

Implement this issue end to end: read it with tracker_get_task, move it to "In Progress" with a short plan comment, make the change, confirm the project's build/tests/lint pass, commit locally, then post an evidence-backed summary comment (with the verification output and commit SHA) and move the issue to "Human Review". Keep every change scoped to this issue.
`;
