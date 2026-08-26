# Operations Runbook

## Preconditions

~~~bash
conda env list
conda run -n research-agents python --version
devin models list
curl -fsS 'http://127.0.0.1:8080/search?q=orchestrator&format=json'
conda run -n research-agents python -m pip install -r requirements.txt
~~~

Confirm GLM-5.2 appears in Devin. Never use base Conda, system Python, or bare pip.

## Configure

~~~bash
cp .env.example .env
~~~

Set credentials only in private .env; never put them in a brief, API payload, feedback message, log, or commit.

~~~dotenv
OPENROUTER_API_KEY=sk-or-v1-REPLACE_ME
DEVIN_ORCH_LLM_BASE_URL=https://openrouter.ai/api/v1
DEVIN_ORCH_LLM_MODEL=stealth/ox-alpha
DEVIN_ORCH_LLM_MAX_TOKENS=0
DEVIN_ORCH_DEVIN_MODEL=glm-5.2
DEVIN_ORCH_DEVIN_EXTRA_ARGS=--respect-workspace-trust false
DEVIN_ORCH_EXPORT_TRACES=true
DEVIN_ORCH_PYTHON=/absolute/path/to/envs/research-agents/bin/python
DEVIN_ORCH_CONDA_ENV=research-agents
SEARXNG_URL=http://127.0.0.1:8080
~~~

DEVIN_ORCH_WORKSPACE_ROOT may override the default runs/ directory. Session workspaces stay relative to this root.

## Build And Start

Build the dashboard before FastAPI:

~~~bash
cd /home/vanshnawander/Documents/autonomus-agent/dashboard
npm install
npm run build

cd /home/vanshnawander/Documents/autonomus-agent
conda run -n research-agents python -m pytest -q
conda run --no-capture-output -n research-agents \
  python -m uvicorn orchestrator.app:app --host 127.0.0.1 --port 8765
~~~

Open http://127.0.0.1:8765/. Use --reload only for development because reload stops in-memory sessions.

## UI Session Flow

1. Open **Start Research Session** and choose a preset.
2. Set a unique session ID and relative workspace.
3. Enter the goal and one enforceable constraint per line.
4. Write the full brief: question, hypotheses, primary-source/SearXNG policy, datasets and licenses, compute/storage limits, Conda environment, seeds, baselines, ablations, metrics, artifacts, venue, and rejection criteria.
5. Select manual or autonomous approval mode.
6. Keep the reviewer role for a publishable pipeline and start.

The server creates the workspace and writes PROJECT_BRIEF.md atomically before Devin starts. Absolute paths, traversal, and replacement of a different existing brief are rejected.

## Approval Modes

**Manual approvals**: the OpenRouter controller still guides Devin, but medium-risk terminal confirmations pause for a person. Use this for new projects, dependencies, unfamiliar repositories, or expensive changes.

**Autonomous**: the controller may execute low- and medium-risk operations. It requires a configured controller and records every decision and action.

Both modes require a human for high-risk actions. Session configuration cannot bypass destructive-command, secret, push, publish, deployment, or major external-effect gates.

## Monitor Without Micromanaging

- Let changing output and declared long-running commands continue.
- Use the pipeline view for stages and reviewer gates.
- Inspect terminal, controller, and audit views when a decision is questionable.
- Resolve an approval only after reading its command and terminal context.
- Prefer context feedback; use immediate or interrupt feedback only when necessary.
- Restart only after confirming a process exited or cannot recover.

Normal paper retrieval and project-local commands may proceed in autonomous mode when classified below high risk. The controller waits while work progresses.

## Evidence And Search

Use local SearXNG for discovery and retain raw queries and decisions. Direct retrieval of a primary source discovered there is allowed when its URL and retrieval command are logged. Search snippets are not evidence.

Typical literature artifacts:

~~~text
outputs/literature/search_log.jsonl
outputs/literature/sources.jsonl
outputs/literature/claims.csv
outputs/literature/papers/
outputs/literature/repositories.json
~~~

## Recorded State

~~~text
logs/<session-id>/
  manifest.json
  events.jsonl
  handoffs.jsonl
  traces/<agent-id>/<attempt>.json
  agents/<agent-id>/
    sessions.jsonl
    sessions/<attempt>/
      raw.pty.log
      screen_snapshots.jsonl
      controller.jsonl
      audit.jsonl
      feedback.jsonl
      summary.json
~~~

Use the UI attempt selector for retries and reviewer revisions. Do not edit prior logs or immutable experiment results.

## API Fallback

Create session.json:

~~~json
{
  "session_id": "study-001",
  "workspace": "study-001",
  "approval_mode": "manual",
  "goal": "Conduct an evidence-grounded study and produce a reviewed paper.",
  "constraints": [
    "Use local SearXNG for discovery.",
    "Use the research-agents Conda environment only."
  ],
  "project_brief": "# Project Brief\n\n## Research question\n...\n\n## Required evidence\n...\n",
  "agents": [
    {"agent_id": "literature", "role": "literature-survey"},
    {"agent_id": "reviewer", "role": "reviewer"},
    {"agent_id": "methodology", "role": "methodology"},
    {"agent_id": "experiments", "role": "experiment-executor"},
    {"agent_id": "writer", "role": "paper-writer"}
  ]
}
~~~

~~~bash
curl -fsS -X POST http://127.0.0.1:8765/sessions \
  -H 'Content-Type: application/json' --data-binary @session.json

curl -fsS http://127.0.0.1:8765/sessions/study-001/approvals

curl -fsS -X POST \
  http://127.0.0.1:8765/sessions/study-001/approvals/APPROVAL_ID \
  -H 'Content-Type: application/json' \
  -d '{"approved":true,"reason":"Reviewed command and terminal context"}'
~~~

## Recovery And Verification

1. Inspect GET /sessions/{sid}, the live terminal, and Approvals.
2. Read the latest audit.jsonl and controller.jsonl.
3. Resume only if a Devin session ID was captured; otherwise start a fresh attempt.
4. Recorded logs survive service restart, but live control loops are not reconstructed.

~~~bash
conda run -n research-agents python -m pytest -q
conda run -n research-agents python -m py_compile orchestrator/*.py
curl -fsS http://127.0.0.1:8765/health
~~~

Install a missing package only with:

~~~bash
conda run -n research-agents python -m pip install PACKAGE
~~~

Pin and log the installed version.
