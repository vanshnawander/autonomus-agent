# Autonomous Research Orchestrator

This repository runs an auditable research pipeline in Devin CLI PTYs. An OpenAI-compatible controller observes each terminal, chooses one action at a time, enforces approval policy, and advances work through reviewer gates.

~~~text
literature-survey -> reviewer -> methodology -> reviewer
                  -> experiment-executor -> reviewer -> paper-writer -> reviewer
~~~

Devin role sessions use **GLM-5.2** by default. Research discovery should use local SearXNG so queries and result decisions remain traceable.

## Records

Each run has two durable locations:

- runs/<workspace>/: PROJECT_BRIEF.md, sources, code, experiment results, reviews, and paper artifacts.
- logs/<session-id>/: manifest, events, handoffs, numbered attempts, raw PTY output, screen snapshots, controller turns, action audit logs, feedback, summaries, and optional Devin traces.

Attempts are numbered instead of overwritten. The manifest records the workspace, approval mode, brief hash, controller model, Devin model, and agents.

## Requirements

- Conda environment research-agents
- Authenticated devin CLI with glm-5.2
- Node.js and npm for the dashboard
- Local SearXNG JSON API, normally http://127.0.0.1:8080
- OpenRouter key, or another OpenAI-compatible endpoint, for autonomous mode

Use research-agents for every Python command and package installation. Do not install into base Conda or the system interpreter.

## Quick Start

~~~bash
conda run -n research-agents python -m pip install -r requirements.txt
conda run -n research-agents python -m pytest -q

cp .env.example .env
# Edit .env locally and set OPENROUTER_API_KEY. Never commit the key.

cd dashboard
npm install
npm run build
cd ..

conda run --no-capture-output -n research-agents \
  python -m uvicorn orchestrator.app:app --host 127.0.0.1 --port 8765
~~~

Build the dashboard **before** starting FastAPI. Open http://127.0.0.1:8765/. For UI development, keep FastAPI on port 8765, run npm run dev in dashboard/, and open the Vite URL.

## Run From The UI

The dashboard is the primary workflow:

1. Select **Start Research Session** and choose a preset.
2. Enter a filesystem-safe session ID and relative workspace. It is created below DEVIN_ORCH_WORKSPACE_ROOT, which defaults to runs/.
3. Write the complete brief: question, evidence rules, datasets, compute/storage limits, environment, evaluation, artifacts, and publication target.
4. Choose an approval mode:
   - **Manual approvals**: medium-risk terminal confirmations wait for a person.
   - **Autonomous**: the OpenRouter controller may approve low- and medium-risk actions.
5. Review roles, create the session, and monitor the terminal, events, decisions, audit records, and reviewer verdicts.

High-risk actions always require a person in both modes. Session creation writes PROJECT_BRIEF.md before the first agent starts and rejects a workspace containing a different brief.

See [docs/UI_GUIDE.md](docs/UI_GUIDE.md) for the complete operator flow.

## Configuration

Copy .env.example to private .env:

~~~dotenv
OPENROUTER_API_KEY=sk-or-v1-REPLACE_ME
DEVIN_ORCH_LLM_BASE_URL=https://openrouter.ai/api/v1
DEVIN_ORCH_LLM_MODEL=stealth/ox-alpha
DEVIN_ORCH_LLM_TEMP=0.2
DEVIN_ORCH_LLM_MAX_TOKENS=0

DEVIN_ORCH_DEVIN_MODEL=glm-5.2
DEVIN_ORCH_DEVIN_EXTRA_ARGS=--respect-workspace-trust false
DEVIN_ORCH_EXPORT_TRACES=true

DEVIN_ORCH_WORKSPACE_ROOT=/absolute/path/to/autonomus-agent/runs
DEVIN_ORCH_PYTHON=/absolute/path/to/envs/research-agents/bin/python
DEVIN_ORCH_CONDA_ENV=research-agents
SEARXNG_URL=http://127.0.0.1:8080
~~~

The UI never needs the key. approval_mode is per session and cannot weaken the immutable high-risk gate.

## API Fallback

The UI uses the same POST /sessions contract. workspace must be relative to DEVIN_ORCH_WORKSPACE_ROOT; omit per-agent cwd so every role uses that workspace.

~~~bash
curl -fsS -X POST http://127.0.0.1:8765/sessions \
  -H 'Content-Type: application/json' \
  --data-binary @- <<'JSON'
{
  "session_id": "reference-window-flow-001",
  "workspace": "reference-window-flow-001",
  "approval_mode": "autonomous",
  "goal": "Adapt reference sliding-window attention to diffusion and flow models and evaluate it rigorously.",
  "constraints": [
    "Use local SearXNG for search discovery and retain the search ledger.",
    "Search broadly, retain verified primary papers, and stop at documented evidence saturation; do not impose a top-N cap.",
    "Use the research-agents Conda environment only.",
    "Keep peak GPU memory below 6 GB and datasets below 20 GB."
  ],
  "project_brief": "# Project Brief\n\n## Research question\nHow should reference sliding-window attention be adapted for diffusion and flow models?\n\n## Deliverable\nAn auditable study, experiments, and publication-ready paper.\n",
  "agents": [
    {"agent_id": "literature", "role": "literature-survey"},
    {"agent_id": "reviewer", "role": "reviewer"},
    {"agent_id": "methodology", "role": "methodology"},
    {"agent_id": "experiments", "role": "experiment-executor"},
    {"agent_id": "writer", "role": "paper-writer"}
  ]
}
JSON
~~~

Use approval_mode manual for supervised approvals. Autonomous creation fails early without a controller key.

| Endpoint | Purpose |
|---|---|
| GET /health | Controller and Devin configuration |
| GET /preflight | Secret-safe readiness checks for controller, Devin, Conda, workspace, traces, and SearXNG |
| GET /sessions/all | Live and recorded sessions |
| GET /sessions/{sid} | Current pipeline and agents |
| GET /sessions/{sid}/events | Session SSE stream |
| GET /sessions/{sid}/approvals | Pending decisions |
| POST /sessions/{sid}/approvals/{id} | Approve or deny |
| POST /sessions/{sid}/feedback | Agent feedback |
| POST /sessions/{sid}/resume | Reconstruct an interrupted run and resume its validated Devin history with `devin -r` |
| GET /logs/{sid}/agents/{aid}/raw | Raw PTY transcript |
| GET /logs/{sid}/agents/{aid}/audit | Executed actions |
| GET /logs/{sid}/agents/{aid}/controller | Controller turns |

## Safety And Quality

- Destructive commands, secret access, pushes, publishing, deployments, and major external effects always require human approval.
- Stage completion requires an exact validated marker; controller inference cannot advance the pipeline.
- An independent reviewer can reject every stage back for revision.
- Agents preserve sources, commands, versions, hashes, seeds, failed runs, and claim mappings.
- Role-appropriate subagents may handle bounded work, but the owning role records run IDs and verifies outputs. GPU training remains serialized within the declared budget.

## Resume After Restart Or Power Loss

Session manifests are updated atomically with the current stage, active agent, approval mode, workspace, attempt counters, and validated Devin history IDs. Devin IDs come from exported trace metadata; nested tool-shell `Session:` labels are deliberately rejected.

After restarting FastAPI, open the recorded run and choose **Resume**, or call:

~~~bash
curl -fsS -X POST http://127.0.0.1:8765/sessions/SESSION_ID/resume
~~~

The API reconstructs the pipeline and runs `devin -r <validated-history-id>` in the original workspace. If no validated ID exists it returns 409 instead of guessing. An operator may explicitly restart only that stage with `?fresh_if_missing=true`; existing artifacts and numbered attempts remain intact. Completed sessions cannot be resumed.

## Troubleshooting

| Symptom | Check |
|---|---|
| Dashboard missing or stale | Build dashboard/, then restart FastAPI |
| Autonomous session rejected | Set the controller key in private .env |
| SearXNG fails | Query http://127.0.0.1:8080/search?q=test&format=json |
| Devin cannot start | Check devin models list for GLM-5.2 |
| Python import missing | Use conda run -n research-agents python -m pip install PACKAGE |
| Workspace returns 409 | Reuse the exact brief or choose a new workspace |
| Run is waiting | Check Approvals, terminal, controller, and audit |

See [docs/OPERATIONS.md](docs/OPERATIONS.md) and [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).
