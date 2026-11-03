# Agent CLI Plugins

The orchestrator drives terminal coding agents through adapter plugins in `orchestrator/agents/`. The control loop, safety gate, pipeline, and recordings are shared; everything that differs between CLIs lives in one adapter class.

| CLI | Key | Launch | Resume | Session id | Trace copy |
|---|---|---|---|---|---|
| Devin CLI | `devin` | `devin --permission-mode auto\|smart -- <prompt>` | `-r <id>` | printed / `--export` trace | `--export` at launch |
| OpenCode | `opencode` | `opencode --prompt <prompt>` | `--session <id>` | `opencode session list` | `opencode export <id>` |
| Codex CLI | `codex` | `codex --sandbox workspace-write --ask-for-approval on-request -- <prompt>` | `codex resume <id>` | `~/.codex/sessions` rollout | rollout file |
| Claude Code | `claude-code` | `claude --session-id <uuid> --permission-mode acceptEdits -- <prompt>` | `--resume <id>` | assigned at launch | `~/.claude/projects/*/<id>.jsonl` |

Verified against Devin 3000.11, OpenCode 1.18, Codex 0.164, and Claude Code 2.1.

## Choosing a CLI

- Default for every agent: `DEVIN_ORCH_AGENT_CLI=claude-code` (default `devin`).
- Per session: `"agent_cli": "codex"` in `POST /sessions`, or the CLI picker in the new-session wizard.
- Per agent: `"agent_cli"` and `"model"` on any entry in `agents`, so one run can mix CLIs (for example, Claude Code for experiments and Codex as the critic).
- Side tasks: `"agent_cli"` in `POST /sessions/{sid}/agents`.

`GET /agent-clis` lists installed adapters and their capabilities. Session creation fails with HTTP 400 before writing anything if a selected CLI is unknown or not on `PATH`.

## Per-CLI settings

Each adapter reads `DEVIN_ORCH_<KEY>_COMMAND`, `_MODEL`, and `_EXTRA_ARGS`, where `<KEY>` is the upper-cased key with `-` replaced by `_`:

~~~dotenv
DEVIN_ORCH_CLAUDE_CODE_MODEL=opus
DEVIN_ORCH_CLAUDE_CODE_PERMISSION_MODE=acceptEdits
DEVIN_ORCH_CODEX_MODEL=gpt-5-codex
DEVIN_ORCH_OPENCODE_MODEL=anthropic/claude-sonnet-4-5
DEVIN_ORCH_OPENCODE_COMMAND=/opt/opencode/bin/opencode
~~~

Devin keeps its existing `DEVIN_ORCH_DEVIN_COMMAND`, `DEVIN_ORCH_DEVIN_MODEL`, and `DEVIN_ORCH_DEVIN_EXTRA_ARGS`.

Extra args can add flags but cannot remove the approval boundary: adapters drop permission-bypass flags such as `--dangerously-skip-permissions`, `--dangerously-bypass-approvals-and-sandbox`, `-p/--print`, and Devin's `--permission-mode`.

## Behaviour that is handled for you

- **First-run dialogs.** Claude Code and Codex ask whether to trust each new folder; Claude's default answer is "No, exit". The adapter answers trust dialogs deterministically, only for workspaces under `DEVIN_ORCH_WORKSPACE_ROOT`, and records an `adapter_startup_action` event and audit entry. Codex's self-update prompt, whose default option pipes an installer into `sh`, is always skipped with Escape.
- **Approval menus.** Each adapter recognises its CLI's tool-approval menu. The controller may confirm only a highlighted one-time approval; "don't ask again" / "allow always" options are never confirmed. Approval requests shown to humans include the menu text.
- **Busy detection.** Adapter busy markers (`esc to interrupt`, `esc interrupt`) keep the controller from acting mid-response.
- **Markers.** `AGENT_DONE`, `APPROVE`, `REJECT`, and `AGENT_QUESTION` are recognised behind TUI decorations (`●`, `⏺`, `•`, `┃`) and on the rendered screen. Prompt-echo prefixes (`❯`, `›`, `>`) are not accepted.
- **Environment.** Claude Code children drop inherited Claude Code session markers, so an orchestrator started from inside Claude Code still produces normal, resumable sessions. OpenCode receives a permission policy through `OPENCODE_CONFIG_CONTENT` (edits allowed, read-only shell commands allowed, all other shell commands ask) unless you set that variable yourself.

## Known limits

- OpenCode highlights the selected permission button with colour only, which is lost in screen rendering. The adapter assumes the default "Allow once" selection.
- Codex runs `workspace-write` with network access enabled because literature and verification stages need it. Use `DEVIN_ORCH_CODEX_EXTRA_ARGS` with a Codex profile for stricter sandboxes.
- Each CLI must already be authenticated, with a model your account can use. For example, a Codex config whose default model your plan does not support fails on the first turn; set `DEVIN_ORCH_CODEX_MODEL`.

## Writing a plugin

Subclass `AgentAdapter` and implement `build_argv`; override other hooks as needed.

~~~python
# my_plugins/aider.py
import shlex
from orchestrator.agents import AgentAdapter, Capabilities, LaunchContext, MenuState

class AiderAdapter(AgentAdapter):
    name = "aider"
    display_name = "Aider"
    description = "Aider pair-programming CLI"
    default_command = "aider"
    model_hint = "litellm model name"
    capabilities = Capabilities(resume=False)
    busy_markers = ("waiting for",)
    controller_guidance = "Aider: the prompt line starts with `>`; y/n questions end with `(Y)es/(N)o`."

    def build_argv(self, ctx: LaunchContext) -> list[str]:
        argv = shlex.split(self.command())
        if ctx.model or self.default_model():
            argv += ["--model", ctx.model or self.default_model()]
        return argv + ["--message", ctx.prompt]

    def menu_state(self, screen: str) -> MenuState:
        active = "(Y)es/(N)o" in screen
        return MenuState(active=active, approve_selected=active)
~~~

Register it with `DEVIN_ORCH_AGENT_PLUGINS=my_plugins.aider:AiderAdapter`. Use a comma-separated list for several plugins. A plugin that fails to import is logged and skipped.

Hooks:

| Hook | Purpose |
|---|---|
| `build_argv(ctx)` | Launch argv for a fresh run, or a resumed run when `ctx.resume_session_id` is set. |
| `prepare_env(env, ctx)` | Child environment. The base implementation applies `strip_env`. |
| `new_session_id()` | Return an id to pass at launch when the CLI accepts one. |
| `startup_action(screen, trusted_workspace)` | Keys for known first-run dialogs. |
| `menu_state(screen)` | Detect the approval menu and whether its one-time option is selected. |
| `busy(screen)` | Whether the CLI is still working. Defaults to `busy_markers`. |
| `extract_session_id(text)` / `discover_session_id(cwd, started_at)` | Find the resumable session id. |
| `export_trace(session_id, cwd, dest)` | Copy the CLI's transcript into `logs/<session>/traces/`. |

Add screen fixtures captured from the real CLI to `tests/test_agent_adapters.py` for every dialog and menu your adapter handles.
