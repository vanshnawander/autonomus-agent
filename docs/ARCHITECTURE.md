# Architecture

## System Boundary

The service coordinates Devin CLI sessions through pseudo-terminals. Each role receives a project-local brief and writes durable artifacts. The controller observes terminal state and returns one structured action; the safety gate decides whether it may execute.

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
                               Devin PTY session
                                      |
                         workspace + recorder
~~~

## Session Creation

POST /sessions accepts session_id, relative workspace, exact project_brief, goal, constraints, approval_mode, and agent declarations.

orchestrator/app.py resolves the workspace below DEVIN_ORCH_WORKSPACE_ROOT, rejects absolute paths and traversal, writes the brief atomically, and rejects conflicting content. Agents without an explicit validated cwd use the session workspace.

Every stage prompt contains the goal, constraints, workspace, brief path, base rules, role rules, and handoff context. The manifest separately records the brief hash and approval mode. Prompt context is rebuilt for retries and revisions.

## Pipeline

orchestrator/roles.py inserts a reviewer after every declared work stage:

~~~text
literature-survey -> reviewer
methodology -> reviewer
experiment-executor -> reviewer
paper-writer -> reviewer
~~~

Work roles emit AGENT_DONE <role>; reviewers emit APPROVE <role> or REJECT <role>: <reasons>. A controller decision cannot substitute for a validated marker.

Role prompts require bounded, traceable subagents where appropriate. The owning role records run IDs, verifies outputs, retains final judgment, and avoids concurrent GPU training.

## Control Loop

Each project/agent pair has a PTY, idle detector, stop flag, and control thread:

1. Read PTY bytes and update raw and visible records.
2. Detect questions, completion markers, and reviewer verdicts.
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

## Devin PTY

orchestrator/pty_manager.py starts one Devin process per attempt. Defaults select glm-5.2. The launcher derives Devin permissions from the session: `auto` for manual sessions and `accept-edits` for autonomous sessions. Generic transport flags remain:

~~~text
--respect-workspace-trust false
~~~

The outer safety gate remains authoritative. Optional --export traces use a distinct path for every attempt. PTYs are keyed by project and agent.

## Persistence

~~~text
logs/<session-id>/
  manifest.json
  events.jsonl
  handoffs.jsonl
  traces/<agent-id>/<attempt>.json
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
| DEVIN_ORCH_DEVIN_COMMAND | devin | Devin executable |
| DEVIN_ORCH_DEVIN_MODEL | glm-5.2 | Role model |
| DEVIN_ORCH_DEVIN_EXTRA_ARGS | --respect-workspace-trust false | Transport flags; session mode selects permissions |
| DEVIN_ORCH_EXPORT_TRACES | true | Devin traces |
| DEVIN_ORCH_LLM_BASE_URL | OpenRouter | Controller endpoint |
| OPENROUTER_API_KEY | unset | Default credential |
| DEVIN_ORCH_LLM_API_KEY | OpenRouter key | Credential override |
| DEVIN_ORCH_LLM_MODEL | stealth/ox-alpha | Controller model |
| DEVIN_ORCH_LLM_MAX_TOKENS | 0 | Provider default |
| DEVIN_ORCH_WORKSPACE_ROOT | repository runs/ | Workspace root |
| DEVIN_ORCH_LOG_DIR | repository logs/ | Recorder root |
| DEVIN_ORCH_PYTHON | running Conda interpreter | Python executable recorded for agents |
| DEVIN_ORCH_CONDA_ENV | current Conda environment | Required environment name |
| SEARXNG_URL | http://127.0.0.1:8080 | Logged research discovery endpoint |
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
