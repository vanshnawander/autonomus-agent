# Autonomous Research Orchestrator

Run a full research project (literature survey → methodology → experiments → paper) with terminal coding agents. An adversarial **critic** and an independent **reviewer** check every stage, and a person approves anything risky.

The orchestrator runs each agent in a real terminal and watches it. A controller LLM picks one safe action at a time. You follow everything from a web dashboard: what is running, what is waiting on you, and why each stage was accepted or sent back.

> **Work in progress.** Interfaces may still change. Bug reports, design feedback, and new agent integrations are welcome. See [Contributing](#contributing).

## Contents

- [How it works](#how-it-works)
- [Supported agent CLIs](#supported-agent-clis)
- [Quick start](#quick-start)
- [Your first run](#your-first-run)
- [Approval modes](#approval-modes)
- [Configuration](#configuration)
- [Where results go](#where-results-go)
- [Resuming after a restart](#resuming-after-a-restart)
- [Safety guarantees](#safety-guarantees)
- [HTTP API](#http-api)
- [Troubleshooting](#troubleshooting)
- [Documentation map](#documentation-map)
- [Contributing](#contributing)

## How it works

Each work stage is followed by two gates. Either gate can **reject** the work and send it back to that stage with reasons.

~~~text
Literature survey ─► Critic ─► Reviewer ─┐
                                         ▼
Methodology ───────► Critic ─► Reviewer ─┐
                                         ▼
Experiments ───────► Critic ─► Reviewer ─┐
                                         ▼
Paper writing ─────► Critic ─► Reviewer ─► done
~~~

| Part | What it does |
|---|---|
| **Agents** | One CLI coding agent per role (Devin, Claude Code, Codex, OpenCode, …), each in its own terminal and working in the project folder. |
| **Controller** | An LLM reached through an OpenAI-compatible API (OpenRouter by default). It reads each agent's screen and chooses **one** action: wait, type, press a key, approve a menu, or ask you. |
| **Safety gate** | Checks every keystroke against risk rules. High-risk actions always wait for a person. |
| **Stage markers** | A stage advances only when the agent prints an exact marker such as `AGENT_DONE methodology` or `APPROVE methodology`. The controller cannot advance the pipeline on its own judgement. |
| **Dashboard** | Shows status, pending approvals, the live terminal, the pipeline, and a readable activity feed. |

## Supported agent CLIs

Choose the CLI for a whole run, or per agent, and mix them in one run. For example, Claude Code can run experiments while Codex acts as the critic.

| CLI | Key | Resume | Notes |
|---|---|---|---|
| [Devin CLI](https://devin.ai) | `devin` | ✅ | Reference integration (current default). |
| [Claude Code](https://claude.com/claude-code) | `claude-code` | ✅ | Session ID assigned at launch; folder trust handled automatically. |
| [Codex CLI](https://github.com/openai/codex) | `codex` | ✅ | Sandboxed to the workspace; its self-update prompt is always skipped. |
| [OpenCode](https://opencode.ai) | `opencode` | ✅ | Works with any provider configured in OpenCode. |

You can add other CLIs as plugins without touching the orchestrator core. See **[docs/AGENT_PLUGINS.md](docs/AGENT_PLUGINS.md)** for per-CLI settings, known limits, and how to write a plugin.

## Quick start

### 1. Prerequisites

| Need | Why |
|---|---|
| Conda env named `research-agents` | All Python runs here. Never install into base Conda or the system Python. |
| At least one **authenticated** agent CLI | `devin`, `claude`, `codex`, or `opencode` on your `PATH`. |
| Node.js + npm | To build the dashboard. |
| Local [SearXNG](https://docs.searxng.org/) with the JSON API (usually `http://127.0.0.1:8080`) | Literature search and claim verification go through it, so every query is logged. |
| An OpenRouter key (or any OpenAI-compatible endpoint) | Only needed for **Autonomous** mode. |

### 2. Install

~~~bash
conda run -n research-agents python -m pip install -r requirements.txt
cd dashboard && npm install && npm run build && cd ..
~~~

### 3. Configure

~~~bash
cp .env.example .env
~~~

Then edit `.env`:

- Set `OPENROUTER_API_KEY`.
- Optionally pick your default agent CLI with `DEVIN_ORCH_AGENT_CLI=claude-code`.

`.env` is private, so never commit it.

### 4. Start

~~~bash
conda run --no-capture-output -n research-agents \
  python -m uvicorn orchestrator.app:app --host 127.0.0.1 --port 8765
~~~

Open **http://127.0.0.1:8765/**. The home page shows a **Setup** checklist. Fix anything marked red before starting a run.

> Build the dashboard *before* starting the server. For UI development, keep the server on port 8765, run `npm run dev` in `dashboard/`, and open the Vite URL.

### 5. Check it works (optional)

~~~bash
conda run -n research-agents python -m pytest -q
curl -s http://127.0.0.1:8765/agent-clis    # which CLIs the server can see
~~~

## Your first run

Click **New run**. The wizard has four steps:

| Step | What you fill in |
|---|---|
| **1. Basics** | A template (*Full Research Pipeline*, *Literature Survey Only*, *Experiments + Paper*), the topic, and a run ID. The workspace folder is created under `runs/` by default. |
| **2. Brief** | The goal, constraints (one per line), and `PROJECT_BRIEF.md`. A good brief states the research question, evidence rules, datasets, compute and storage limits, evaluation, required artifacts, and publication target. |
| **3. Agents** | The default agent CLI, plus optional per-agent CLI, model, and extra instructions. |
| **4. Review & start** | The approval mode (see below) and a readiness check. Then click **Create and start**. |

The brief is written to the workspace before any agent starts. A workspace that already has a *different* brief is refused rather than overwritten.

### Reading a run page

The top of every run page answers two questions: what is happening, and does it need me?

- **Status banner:** one sentence plus the main button (**Resume run**, **Stop all**, or **Review now**).
- **Action needed:** shown only when something waits on you:
  - approvals, with the exact keystroke and terminal text
  - agent questions, with a reply box
  - controller errors

Everything else lives in four tabs:

| Tab | What's there |
|---|---|
| **Overview** | Pipeline progress (what's done, where it stopped, how often work was sent back) and one row per agent. |
| **Terminal** | The live agent screen, keyboard controls, and feedback (*Send now*, *Add as guidance for next step*, *Interrupt and send*). |
| **Activity** | A readable history; switch to *Everything* or *Raw JSON* for full detail. |
| **Settings** | Run details, start a side task, remove the run. |

Runs that need you show a **Needs you** badge in the header and the sidebar. More detail: [docs/UI_GUIDE.md](docs/UI_GUIDE.md).

## Approval modes

Each run has its own approval mode.

| Risk | Manual | Autonomous |
|---|---|---|
| Low (e.g. reading files) | Controller proceeds | Controller proceeds |
| Medium (e.g. `pip install`, `git commit`) | **Waits for you** | Controller may proceed |
| High (e.g. `rm -rf`, `git push`, secrets, deploys, `sudo`) | **Waits for you** | **Waits for you** |

High-risk gating cannot be turned off. Autonomous mode needs a controller API key, and creating an autonomous run fails early without one.

## Configuration

All settings are environment variables, usually set in `.env`. [`.env.example`](.env.example) lists them with defaults. The ones you are most likely to change:

| Variable | Default | Purpose |
|---|---|---|
| `OPENROUTER_API_KEY` | — | Controller credential (or `DEVIN_ORCH_LLM_API_KEY`). |
| `DEVIN_ORCH_LLM_MODEL` | `z-ai/glm-5.3-flash` | Controller model. |
| `DEVIN_ORCH_LLM_BASE_URL` | OpenRouter | Any OpenAI-compatible endpoint. |
| `DEVIN_ORCH_AGENT_CLI` | `devin` | Default CLI: `devin`, `claude-code`, `codex`, `opencode`. |
| `DEVIN_ORCH_<CLI>_MODEL` | CLI's own default | Model per CLI, e.g. `DEVIN_ORCH_CLAUDE_CODE_MODEL=opus`, `DEVIN_ORCH_CODEX_MODEL=…`. Devin uses `DEVIN_ORCH_DEVIN_MODEL` (default `swe-2-high`). |
| `DEVIN_ORCH_<CLI>_COMMAND` | `devin` / `claude` / `codex` / `opencode` | Path to the CLI if it is not on `PATH`. |
| `DEVIN_ORCH_WORKSPACE_ROOT` | `./runs` | Where project workspaces are created. |
| `SEARXNG_URL` | `http://127.0.0.1:8080` | Local search endpoint. |
| `DEVIN_ORCH_SERVERS_FILE` | `./servers.json` | Optional remote compute inventory (see `servers.example.json`). |

<details>
<summary>Full example <code>.env</code></summary>

~~~dotenv
OPENROUTER_API_KEY=sk-or-v1-REPLACE_ME
DEVIN_ORCH_LLM_BASE_URL=https://openrouter.ai/api/v1
DEVIN_ORCH_LLM_MODEL=z-ai/glm-5.3-flash
DEVIN_ORCH_LLM_TEMP=0.2
DEVIN_ORCH_LLM_MAX_TOKENS=0

DEVIN_ORCH_AGENT_CLI=devin
DEVIN_ORCH_DEVIN_MODEL=swe-2-high
DEVIN_ORCH_DEVIN_EXTRA_ARGS=--respect-workspace-trust false
DEVIN_ORCH_EXPORT_TRACES=true
# DEVIN_ORCH_CLAUDE_CODE_MODEL=opus
# DEVIN_ORCH_CODEX_MODEL=gpt-5-codex
# DEVIN_ORCH_OPENCODE_MODEL=anthropic/claude-sonnet-4-5

DEVIN_ORCH_WORKSPACE_ROOT=/absolute/path/to/autonomus-agent/runs
DEVIN_ORCH_PYTHON=/absolute/path/to/envs/research-agents/bin/python
DEVIN_ORCH_CONDA_ENV=research-agents
SEARXNG_URL=http://127.0.0.1:8080
DEVIN_ORCH_SERVERS_FILE=/absolute/path/to/autonomus-agent/servers.json
~~~

</details>

The dashboard never needs or sees your keys.

## Where results go

Every run has two folders. Nothing is overwritten: retries get new numbered attempts.

~~~text
runs/<workspace>/            ← the research itself
  PROJECT_BRIEF.md
  outputs/literature/ …      sources, search log, per-paper notes, ideas
  outputs/methodology/ …     plan, experiment manifest
  outputs/critiques/ …       critic reports
  outputs/reviews/ …         reviewer reports
  outputs/paper/ …           manuscript, references, claim traceability
  experiments/ …             code, configs, tests
  repositories/ …            cloned reference code (commit SHAs recorded)

logs/<run-id>/               ← the audit trail
  manifest.json              stage, agents, CLIs, models, approval mode, brief hash
  events.jsonl               everything that happened, in order
  handoffs.jsonl             stage transitions and rejections
  traces/<agent>/            each CLI's own transcript (Devin, Claude Code, Codex, OpenCode)
  agents/<agent>/sessions/<attempt>/
    raw.pty.log              exact terminal output
    screen_snapshots.jsonl   what the controller saw
    controller.jsonl         every controller decision
    audit.jsonl              every keystroke sent, and by whom
~~~

## Resuming after a restart

Run state is saved continuously. After a crash, reboot, or server restart:

1. Start the server again.
2. Open the run and click **Resume run**, or call:

   ~~~bash
   curl -fsS -X POST http://127.0.0.1:8765/sessions/RUN_ID/resume
   ~~~

The active stage's agent picks up its previous CLI conversation (`devin -r`, `claude --resume`, `codex resume`, `opencode --session`). If no saved conversation ID exists, the API returns `409` instead of guessing. Add `?fresh_if_missing=true` to restart just that stage. The UI's **Resume run** does this for you. Existing artifacts and attempts are kept. Completed runs cannot be resumed.

## Safety guarantees

- **People approve risky actions.** Destructive commands, secret access, pushes, publishing, deployments, and remote access always need a person.
- **Only markers advance stages.** Stages advance on exact markers printed by the agent, never on the controller's opinion.
- **One-time approvals only.** On CLI approval menus, the controller may only pick the one-time option, never "don't ask again" or "allow always".
- **Bypass flags are stripped.** Permission-bypass flags (e.g. `--dangerously-skip-permissions`) are removed from any CLI's extra arguments.
- **Adversarial review.** The critic attacks reasoning, novelty, confounds, code paths, and evidence. The reviewer then independently accepts or rejects. Either can send work back.
- **Reproducibility.** Agents record sources, commands, versions, hashes, seeds, failed runs, and claim-to-evidence mappings.

## HTTP API

The dashboard uses this same API, so anything you can do in the UI you can script.

| Endpoint | Purpose |
|---|---|
| `GET /health` | Controller status, default CLI, installed CLIs. |
| `GET /preflight` | Readiness checklist (controller, CLIs, Conda, workspace, SearXNG, server inventory). |
| `GET /agent-clis` | Available CLI plugins and their capabilities. |
| `POST /sessions` | Create and start a run. |
| `GET /sessions/all` | All runs, live and recorded, with status. |
| `GET /sessions/{sid}` | One run: pipeline, agents, current stage. |
| `GET /sessions/{sid}/events` | Live event stream (SSE). |
| `GET /sessions/{sid}/approvals` | Pending approvals. |
| `POST /sessions/{sid}/approvals/{id}` | Approve or deny. |
| `POST /sessions/{sid}/feedback` | Send feedback to an agent. |
| `POST /sessions/{sid}/agents` | Start a side task (extra agent). |
| `POST /sessions/{sid}/resume` | Resume an interrupted run. |
| `GET /logs/{sid}/agents/{aid}/raw` | Raw terminal transcript. |
| `GET /logs/{sid}/agents/{aid}/controller` | Controller decisions. |
| `GET /logs/{sid}/agents/{aid}/audit` | Keystrokes actually sent. |

Interactive API docs are served at **http://127.0.0.1:8765/docs**.

<details>
<summary>Example: create a run with <code>curl</code></summary>

`workspace` is relative to `DEVIN_ORCH_WORKSPACE_ROOT`. `agent_cli` sets the run's default CLI. Any agent can override it with its own `agent_cli` and `model`.

~~~bash
curl -fsS -X POST http://127.0.0.1:8765/sessions \
  -H 'Content-Type: application/json' \
  --data-binary @- <<'JSON'
{
  "session_id": "reference-window-flow-001",
  "workspace": "reference-window-flow-001",
  "approval_mode": "manual",
  "agent_cli": "claude-code",
  "goal": "Adapt reference sliding-window attention to diffusion and flow models and evaluate it rigorously.",
  "constraints": [
    "Use local SearXNG for search discovery and retain the search ledger.",
    "Use the research-agents Conda environment only.",
    "Keep peak GPU memory below 6 GB and datasets below 20 GB."
  ],
  "project_brief": "# Project Brief\n\n## Research question\nHow should reference sliding-window attention be adapted for diffusion and flow models?\n\n## Deliverable\nAn auditable study, experiments, and publication-ready paper.\n",
  "agents": [
    {"agent_id": "literature", "role": "literature-survey"},
    {"agent_id": "critic", "role": "critic", "agent_cli": "codex"},
    {"agent_id": "reviewer", "role": "reviewer"},
    {"agent_id": "methodology", "role": "methodology"},
    {"agent_id": "experiments", "role": "experiment-executor"},
    {"agent_id": "writer", "role": "paper-writer"}
  ]
}
JSON
~~~

</details>

## Troubleshooting

| Symptom | What to do |
|---|---|
| Dashboard missing or out of date | Run `npm run build` in `dashboard/`, restart the server, and hard-refresh the browser. |
| "CLI is not installed" when creating a run | Install the CLI, put it on `PATH`, or set `DEVIN_ORCH_<CLI>_COMMAND`. `GET /agent-clis` shows what the server sees. |
| Agent fails on its first reply | That CLI's own model or login is wrong. Set `DEVIN_ORCH_<CLI>_MODEL` or log in to the CLI again. |
| Devin won't start | Run `devin models list` and check that your configured model is available. |
| Autonomous run refused | Set the controller key in `.env`. |
| Search fails | Check SearXNG: `curl 'http://127.0.0.1:8080/search?q=test&format=json'`. |
| Run looks stuck | Look at **Action needed** on the run page. Otherwise check the terminal and the controller decisions on the agent page. |
| Creating a run returns 409 | The workspace already has a different brief. Reuse the exact brief or pick a new workspace. |
| Remote server inventory fails | Copy `servers.example.json` to `servers.json`, fill it in, then run `chmod 600 servers.json`. |
| Missing Python package | Run `conda run -n research-agents python -m pip install PACKAGE`. |

## Documentation map

| Document | Read it when you want to… |
|---|---|
| [docs/UI_GUIDE.md](docs/UI_GUIDE.md) | Learn the dashboard workflow in detail. |
| [docs/AGENT_PLUGINS.md](docs/AGENT_PLUGINS.md) | Configure a specific CLI or add a new one. |
| [docs/OPERATIONS.md](docs/OPERATIONS.md) | Run, monitor, and recover studies day to day. |
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | Understand the control loop, safety gate, and persistence. |
| [docs/RESEARCH_QUALITY_AUDIT.md](docs/RESEARCH_QUALITY_AUDIT.md) | See the quality bar the critic and reviewer enforce. |
| [docs/MAINTAINER_HANDOFF.md](docs/MAINTAINER_HANDOFF.md) | Pick up maintenance of the codebase. |
| [TODO.md](TODO.md) | See the roadmap and good first contributions. |

## Contributing

1. Open or reference an issue before starting a large change.
2. Keep changes focused and add tests (`conda run -n research-agents python -m pytest -q`).
3. For dashboard changes, run `npm run build` and `npm run lint` in `dashboard/`.
4. Never commit `.env`, API keys, `servers.json`, run artifacts, or private traces.

New agent CLI integrations are especially welcome. Start with [docs/AGENT_PLUGINS.md](docs/AGENT_PLUGINS.md).
