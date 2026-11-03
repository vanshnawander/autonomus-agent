# Architecture

## System Boundary

The service coordinates CLI coding agents (Devin, OpenCode, Codex, Claude Code, or a plugin) through pseudo-terminals. Each role receives a project-local brief and writes durable artifacts. The controller observes terminal state and returns one structured action; the safety gate decides whether it may execute.

~~~text
Dashboard / REST API
        |
        v
FastAPI -> SessionStore -> Orchestrator control loop
                             |             |
                             v             v
                      OpenRouter       SafetyGate
                      controller           |
                              \           /
                             agent CLI PTY session
                                      |
                         workspace + recorder
~~~

## Session Creation

POST /sessions accepts session_id, relative workspace, exact project_brief, goal, constraints, approval_mode, and agent declarations.

orchestrator/app.py resolves the workspace below DEVIN_ORCH_WORKSPACE_ROOT, rejects absolute paths and traversal, writes the brief atomically, and rejects conflicting content. Agents without an explicit validated cwd use the session workspace.

Every stage prompt contains the goal, constraints, workspace, brief path, base rules, role rules, and handoff context. The manifest separately records the brief hash and approval mode. Prompt context is rebuilt for retries and revisions.

## Pipeline

orchestrator/roles.py inserts two gates after every declared work stage. The critic attacks scientific reasoning first; the reviewer independently performs acceptance:

~~~text
literature-survey -> critic -> reviewer
methodology -> critic -> reviewer
experiment-executor -> critic -> reviewer
paper-writer -> critic -> reviewer
~~~

Work roles emit AGENT_DONE <role>; both gates emit APPROVE <role> or REJECT <role>: <reasons>. A controller decision cannot substitute for a validated marker. A rejection rewinds to a fresh work-stage attempt so a stale completion marker cannot replay; reviewer rejection routes through the critic again.

Role prompts require bounded, traceable subagents where appropriate. The owning role records run IDs, verifies outputs, retains final judgment, and avoids concurrent GPU training.

## Control Loop

Each project/agent pair has a PTY, idle detector, stop flag, and control thread:

1. Read PTY bytes and update raw and visible records.
2. Detect questions, completion markers, and critic/reviewer verdicts.
3. Wait while output changes or long work is active.
4. At a stable prompt, send session state, visible screen, and recent output to the controller.
5. Persist the complete request and response.
6. Classify interactive input using its payload and terminal context.
7. Execute, queue approval, or wait; record the result.

Quiet terminals are sampled without requiring new bytes. Repeated idle waits, low confidence, process death, and timeouts produce explicit events.

## Controller

orchestrator/llm_controller.py uses an OpenAI-compatible API. Defaults point to OpenRouter. The validated decision contains state, one action, confidence, risk, reason, and optional payload fields. Invalid responses or provider failures fall back to a safe wait.

Terminal text, repository files, and web pages are untrusted input. The controller avoids repeated input, respects role boundaries, and never treats prose as completion proof.

## Approval Policy

| Mode | Low risk | Medium risk | High risk |
|---|---|---|---|
| manual | Controller executes | Human approval | Human approval |
| autonomous | Controller executes | Controller may execute | Human approval |

High-risk gating is immutable. Approval items and resolutions are session-scoped. Approval executes the inspected decision exactly once; denial dismisses the terminal confirmation.

## Agent CLI PTYs

orchestrator/pty_manager.py starts one CLI process per attempt, directly from an argv (never through a shell). Each agent's CLI is chosen per agent, then per session, then by `DEVIN_ORCH_AGENT_CLI`. The adapter plugin in orchestrator/agents/ (see docs/AGENT_PLUGINS.md) builds the launch flags, cleans the child environment, answers known first-run dialogs, recognises the CLI's approval menu and busy state, and finds the resumable session id.

Devin derives permissions from the session: `auto` for manual sessions and `smart` for autonomous sessions. Claude Code uses `acceptEdits`, Codex uses `workspace-write` with `on-request` approvals, and OpenCode receives an ask-for-shell policy. Shell commands therefore reach the controller as approval menus.

The outer safety gate remains authoritative. Trace copies use a distinct path for every attempt. PTYs are keyed by project and agent.

## Persistence

~~~text
logs/<session-id>/
  manifest.json
  events.jsonl
  handoffs.jsonl
  traces/<agent-id>/<attempt>.json            # Devin --export
  traces/<agent-id>/<attempt>.<cli>.json      # other CLIs' transcripts
  agents/<agent-id>/sessions.jsonl
  agents/<agent-id>/sessions/<attempt>/
    raw.pty.log
    screen_snapshots.jsonl
    controller.jsonl
    audit.jsonl
    feedback.jsonl
    summary.json
~~~

JSONL writes are locked. Retries and revisions create attempts instead of overwriting records. Project artifacts live separately under the workspace root.

## API And Dashboard

FastAPI serves dashboard/dist/; build it before server startup. Vite development proxies to port 8765.

| Method | Endpoint | Responsibility |
|---|---|---|
| POST | /sessions | Prepare workspace and start |
| GET | /sessions/all | Live and recorded summaries |
| GET | /sessions/{sid} | Current state |
| GET | /sessions/{sid}/events | Session SSE |
| GET | /events | Global SSE |
| POST | /sessions/{sid}/feedback | Inject feedback |
| POST | /sessions/{sid}/agents/{aid}/input | Manual input |
| POST | /sessions/{sid}/agents/{aid}/restart | Resume/restart |
| GET | /sessions/{sid}/approvals | Pending approvals |
| POST | /sessions/{sid}/approvals/{apid} | Resolve approval |
| GET | /logs/{sid}/agents/{aid}/raw | PTY output |
| GET | /logs/{sid}/agents/{aid}/audit | Executed actions |
| GET | /logs/{sid}/agents/{aid}/controller | Controller turns |

## Configuration

| Setting | Default | Purpose |
|---|---|---|
| DEVIN_ORCH_AGENT_CLI | devin | Default CLI: devin, opencode, codex, claude-code |
| DEVIN_ORCH_<CLI>_COMMAND / _MODEL / _EXTRA_ARGS | per CLI | Per-CLI executable, model, extra flags |
| DEVIN_ORCH_AGENT_PLUGINS | unset | Extra adapters as module:Class list |
| DEVIN_ORCH_DEVIN_COMMAND | devin | Devin executable |
| DEVIN_ORCH_DEVIN_MODEL | swe-2-high | Role model |
| DEVIN_ORCH_DEVIN_EXTRA_ARGS | --respect-workspace-trust false | Transport flags; session mode selects permissions |
| DEVIN_ORCH_EXPORT_TRACES | true | Devin traces |
| DEVIN_ORCH_LLM_BASE_URL | OpenRouter | Controller endpoint |
| OPENROUTER_API_KEY | unset | Default credential |
| DEVIN_ORCH_LLM_API_KEY | OpenRouter key | Credential override |
| DEVIN_ORCH_LLM_MODEL | z-ai/glm-5.3-flash | Controller model |
| DEVIN_ORCH_LLM_MAX_TOKENS | 0 | Provider default |
| DEVIN_ORCH_WORKSPACE_ROOT | repository runs/ | Workspace root |
| DEVIN_ORCH_LOG_DIR | repository logs/ | Recorder root |
| DEVIN_ORCH_PYTHON | running Conda interpreter | Python executable recorded for agents |
| DEVIN_ORCH_CONDA_ENV | current Conda environment | Required environment name |
| SEARXNG_URL | http://127.0.0.1:8080 | Logged research discovery endpoint |
| DEVIN_ORCH_SERVERS_FILE | repository servers.json | Private 0600 server inventory used only through the restricted broker |
| DEVIN_ORCH_QUIET_MS | 1200 | Idle threshold |
| DEVIN_ORCH_POLL_S | 0.1 | PTY polling |
| DEVIN_ORCH_MAX_RETRIES | 2 | Retry limit |
| DEVIN_ORCH_AGENT_TIMEOUT | 0 | Attempt timeout |

## Verification

~~~bash
conda run -n research-agents python -m pytest -q
conda run -n research-agents python -m py_compile orchestrator/*.py

cd dashboard
npm run build
~~~

Tests cover prompt composition, project-scoped PTYs, approval isolation, exact-once approval execution, markers, recorder writes, workspace containment, brief conflicts, API responses, and terminal behavior.
