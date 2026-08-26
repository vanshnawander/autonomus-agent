# Pending Work — Autonomous ML Research Pipeline

**Status**: All infrastructure wired (OpenRouter defaults, non-interactive devin spawn, `--export` traces, `.env` loading, smoke test 5/5). Docs written. Below is everything remaining.

---

## 1. Critical — User Action Required

### 1a. Provide OpenRouter API Key

The orchestrator defaults to `anthropic/claude-sonnet-4.5` via OpenRouter. The API key must be provided and placed in `.env`:

```bash
# Fill this in (currently placeholder):
OPENROUTER_API_KEY=sk-or-v1-REPLACE_ME
```

Without this, the LLM controller will fail on any `controller.decide()` call. The controller uses the `openai.OpenAI` client pointed at `DEVIN_ORCH_LLM_BASE_URL` (defaults to `https://openrouter.ai/api/v1`).

### 1b. Verify LLM Controller End-to-End

Once the API key is provided, test the controller directly:

```bash
cd /home/vanshnawander/Documents/autonomus-agent
python3 -c "
from orchestrator.llm_controller import make_controller
from orchestrator.schemas import ControllerDecision
ctrl = make_controller()
snapshot = {
  'session_id': 'test',
  'agent_id': 'test',
  'visible_terminal': 'AGENT_DONE survey',
  'recent_output': 'AGENT_DONE survey',
  'goal': 'Survey',
  'agent_role': 'survey',
  'last_action': None,
  'human_feedback': [],
  'other_agent_summaries': {},
}
dec = ctrl.decide(snapshot, 'AGENT_DONE survey', ['AGENT_DONE survey'])
print(dec.model_dump())
"
```

Expected: valid JSON with `action: "mark_done"` or similar.

---

## 2. High Priority — Run the Scaled 100+ Paper Survey

### 2a. Write Updated Literature Survey Brief (v2)

Brief `runs/dlm-survey/briefs/01_lit_survey.md` was written for the 24-paper run. A v2 is needed for:
- **100+ papers** instead of 12–24
- **2026 focus** — mention current year explicitly in search queries
- **Per-paper summaries** written by devin subagents (devin auto-creates subagents when prompted)
- **Gap identification** from each paper (must be explicit, per the paper's own stated limitations + future work)

The v2 brief should instruct the main agent to:
1. Run more diverse SearXNG queries (20+ distinct queries)
2. Download ALL papers found (aim for 100+ PDFs)
3. Spawn subagent batches of ~10 papers each for summarization
4. Each subagent writes a `notes/paper_<arxivid>.md` with: summary, method, limitations, gaps, future work
5. Compile into `notes/survey_report.md` with ranked open problems

### 2b. Run the Survey

After brief v2 is ready, launch the survey agent via opencode or devin with the updated prompt. Monitor progress via:
```bash
ls papers/pdf | wc -l      # target: 100+
ls notes/paper_*.md | wc -l  # target: 100+
cat notes/survey_report.md | wc -l  # target: 2000+
```

### 2c. Devise Batch Strategy for Paper Summaries

With 100+ papers, the main agent cannot summarize all of them alone. Dev auto-creates subagents, but the prompt must explicitly mention subagent batching:

```
For batches of 10 papers each, spawn a subagent with:
  "Summarize papers 1-10 from papers/pdf/. For each paper:
   - Read the HTML from papers/html/<id>.html
   - Write notes/paper_<id>.md with summary, method, limitations, gaps
   - Print AGENT_DONE summarizer when batch is complete"
```

---

## 3. High Priority — Paper Writing Agent

### 3a. Create Paper Writing Agent Brief

A new brief `briefs/04_paper_writer.md` is needed covering:
- **Template compliance**: Use `paper_template/neurips_2026.tex` (NeurIPS 2026 workshop format, "Autonomous ML Research" workshop)
- **Sections required**: Abstract, Introduction, Related Work, Method, Experiments, Results, Discussion, Conclusion, References
- **Matplotlib graphs**: Generate at least 3 figures:
  - Papers-per-year bar chart (from survey data)
  - Method family taxonomy diagram
  - Experiment results (confidence ordering vs dependency, diversity-matched gen-PPL curves)
- **Citations**: Use BibTeX entries from downloaded papers; format consistently with the template's `neurips_2026.sty`
- **Compile**: `pdflatex` + `bibtex` twice for references to resolve; verify PDF is generated without errors

### 3b. Run the Paper Writer Agent

```bash
cd /home/vanshnawander/Documents/autonomus-agent/runs/dlm-survey
devin --print --prompt-file briefs/04_paper_writer.md \
  --export traces/paper-writer
```

### 3c. Review and Multimodal Check

After the paper writer agent finishes:
1. Reviewer agent reads `outputs/paper.md` + compiled PDF
2. Multimodal agent (opencode with image attach via `-f`) reads rendered page images from `pdftoppm -png outputs/paper.pdf`
3. Both print APPROVE/REJECT with reasons
4. Paper writer revises and recompiles

---

## 4. Medium Priority — Devin Trace Recording Audit

### 4a. Verify `--export` flag works on current devin version

The `build_command` fix adds `--export <dir>` automatically. Test:

```bash
devin -p --permission-mode dangerous --export /tmp/test_export -- "Hello, world"
ls /tmp/test_export/  # should contain conversation JSON
```

### 4b. Verify session dir + traces directory structure

After orchestrator runs, the directory should contain:
```
logs/<session_id>/
  manifest.json
  events.jsonl
  agents/<agent_id>/
    raw.pty.log
    screen.png
    audit.jsonl
    feedback.jsonl
    summary.json
  traces/<agent_id>/     # <-- devin --export writes here
    *.json               # conversation transcript
```

### 4c. Ensure `.env.example` documents all knobs

Currently documented: OpenRouter API key, devin extra args, export traces flag. Verify no undocumented settings remain.

---

## 5. Medium Priority — Orchestrator Reliability (from spec.md Phase 5)

### 5a. Stuck-Session Detection

The control loop (`control_loop.py`) already has `IdleDetector` + `max_low_confidence_waits`, but:
- What happens if the agent process is alive but stuck in a loop (no new output, not idle per idle detector)?
- Add: a **max-loops-without-change** counter (e.g., 30 consecutive idle→wait decisions without any text input → escalate)

### 5b. Dead-Process Detection

The control loop checks `sess.is_alive()` (line 279). If the agent process dies silently (as opencode did on "Service Unavailable"), the orchestrator already marks `AgentStatus.error` and stops. However, there's no automatic retry/re-dispatch. Add:
- Configurable retry policy (e.g., `DEVIN_ORCH_MAX_RETRIES=2`)
- On death, restart with same or alternate CLI

### 5c. Timeout Detection

No hard timeout on agent execution currently. Add per-agent or per-session timeout:
```bash
DEVIN_ORCH_AGENT_TIMEOUT=3600  # seconds (0 = no timeout)
```

### 5d. Log Hygiene — ANSI Stripping

Raw PTY logs contain ANSI escape sequences. The recorder persists every byte (`raw.pty.log`), but the controller receives rendered screen via `pyte`. Verify that the controller's visible_terminal is always ANSI-clean (it uses `screen.display` which is clean). Add a `sanitize` function to `terminal_screen.py` for defense-in-depth.

---

## 6. Medium Priority — Safety Enhancements

### 6a. Expand Pattern Lists

`_HIGH_RISK_PATTERNS` and `_MEDIUM_RISK_PATTERNS` in `safety.py` should be extended:
- Add: `docker rm`, `git reset --hard HEAD`, `DROP TABLE`, `DROP DATABASE`, `CREATE EXTENSION`
- Add: editing `.ssh/`, `.aws/`, `.env` files, any `~/.config/` containing secrets
- Add: `curl | bash`, `wget | bash`, `eval`, `exec` of untrusted content

### 6b. Approval Queue API

Currently `_wait_for_approval()` blocks the control loop (busy-wait on `safety.pending()`). Add:
- REST endpoint: `POST /sessions/{sid}/agents/{aid}/approve/{approval_id}` (currently `POST /sessions/{sid}/agents/{aid}/resolve_approval/{approval_id}`)
- WebSocket notification on approval needed
- Configurable timeout: if no approval within N seconds, auto-reject

### 6c. Production Guardrails

`_HIGH_RISK_PATTERNS` catches `git push` — but what about `git push --force`? Add pattern variants:
```python
re.compile(r'git\s+push\s+--force', re.I),
re.compile(r'git\s+push\s+.*--force', re.I),
```

---

## 7. Low Priority — Feature Extensions

### 7a. WebSocket/SSE Event Streaming

`/sessions/{sid}/events` endpoint exists (app.py line 304) but should be implemented as an async generator with proper SSE headers:
```python
from sse_starlette.sse import EventSourceResponse
```

### 7b. Session Replay

`logs/<session_id>/events.jsonl` + `manifest.json` enable full replay of a pipeline run. Build a `replay.py` script that reads events in order and reconstructs the pipeline flow for debugging.

### 7c. Cost/Token Tracking

Per-agent token usage from `llm_controller.py` responses should be logged to `audit.jsonl` (currently not implemented). Add:
```python
# After controller.decide():
arec.record_action("llm_call", tokens_used=..., model=..., cost_usd=...)
```

### 7d. Per-Agent Memory Summaries

`agent_summaries` in `session_store.py` is a simple dict. Enhance to use a rolling-window memory (e.g., last 5 agent summaries as context for controller decisions). The controller prompt already mentions `human_feedback` — extend to include memory summaries.

### 7e. Multi-Session Support

Currently one session at a time is natural (API creates sessions by `session_id`). Add session listing + resumption:
```
GET /sessions/                    # list all
GET /sessions/{sid}               # get state
POST /sessions/{sid}/resume       # restart agents
```

### 7f. Docker / Sandbox Support

Per spec.md Phase 4:
```bash
DEVIN_ORCH_SANDBOX_MODE=docker  # wrap devin in Docker
DEVIN_ORCH_CONTAINER_IMAGE=devin-base:latest
```

Use `docker run --rm -v /workspace:/workspace ...` for each agent, non-root, network-restricted.

---

## 8. Pending From dlm-survey Run

### 8a. Exp3 / Exp7 Redesign

The reviewer rejected these (noise never fed to model, unconditional task with no structure). They require:
- **Conditional training** (input → output with noise injected into the input)
- **Structured task** (not uniform-random; use the multi-digit addition task from Exp1/Exp4)
- **Probe targets** that are NOT recoverable from positional embeddings alone

### 8b. Exp2 Fix

The learned policy head learns position (trivially solvable via positional embeddings). Options:
- Option A: Remove learned head, report only heuristic policies (dep_aware vs confidence vs random)
- Option B: Redesign target to use 1-step rollout error (as IDEAS.md originally described)

### 8c. Exp4 FLOP Matching

The aligned training mode uses ~2× forward passes per step (extra probe pass). Either:
- Halve aligned epochs (15 vs 30) to approximate FLOP match
- Drop "matched FLOPs" language and acknowledge the mismatch

### 8d. Larger-Scale Replications

The current experiments used tiny models (~0.3–0.8M params). Before publication:
- Re-run on 10–100M params (MDLM medium class)
- Add variance estimates (3+ seeds per condition)
- Test on real LM benchmarks (not just synthetic addition)

---

## 9. Documentation Gaps

### 9a. README.md — needs verification of all endpoints

Some endpoints described in ARCHITECTURE.md are assumptions from reading `app.py`. Verify with:
```bash
curl http://127.0.0.1:8765/docs  # FastAPI auto-docs
```

### 9b. add requirements.txt or pyproject.toml

No `requirements.txt` or `pyproject.toml` currently exists. It should list:
```
fastapi>=0.100
uvicorn[standard]>=0.23
pexpect>=4.8
pyte>=0.8
openai>=1.0
python-dotenv>=1.0
```

### 9c. Add LICENSE file

The repo has no LICENSE. Depending on intent, add:
- Apache 2.0 (permissive, for research use)
- MIT (very permissive)
- Proprietary / All rights reserved

---

## 10. Smoke Test / CI

### 10a. No CI pipeline currently exists

Add a basic GitHub Actions workflow:
- Run `smoke_test.py` on every PR
- Lint with ruff
- Type-check with mypy (at least orchestrator config schemas)

### 10b. Smoke test should cover controller decision

Currently smoke test covers roles, pipelines, recording. Add:
- Controller JSON parse validation
- Safety gate pattern matching
- Idle detector threshold behavior

---

## 11. Completion Tracker

| Item | Status | Blocked On |
|------|--------|-----------|
| `.env` + OpenRouter wiring | DONE | (infrastructure) |
| Non-interactive devin spawn (`-p` flag) | DONE | (fixed in `build_command`) |
| `--export` traces wired | DONE | (fixed in `build_command` + `control_loop.py`) |
| Smoke test 5/5 | DONE | `pip install pyte` |
| 24-paper lit survey run | DONE | (ran and documented) |
| 7 experiments written | DONE | (smoke-passed) |
| Reviewer adversarial pass | DONE | (found/removed bugs) |
| Exp1 + Exp6 execution | DONE | (results in `RUN_SUMMARY.md`) |
| README.md | DONE | (in-depth) |
| docs/ARCHITECTURE.md | DONE | (module-by-module) |
| docs/OPERATIONS.md | DONE | (runbook) |
| TODO.md | DONE | (this file) |
| **OpenRouter API key** | **BLOCKED** | user action |
| **Scaled 100+ paper survey** | **BLOCKED** | API key + brief v2 |
| **Devin summarizer subagents** | **BLOCKED** | survey run + brief v2 |
| **Paper writing agent** | **BLOCKED** | survey findings + brief v4 |
| **pdflatex compile pipeline** | **BLOCKED** | paper draft + template |
| **Multimodal figure check** | **BLOCKED** | compiled PDF |
| **Requirements.txt** | **PENDING** | (easy, just list deps) |
| **LICENSE file** | **PENDING** | (user choice) |
| **Exp3/7/2 redesign** | **PENDING** | (code fixes) |
| **Larger-scale replications** | **PENDING** | (compute + API key) |
| **CI pipeline** | **PENDING** | (GitHub Actions) |
| **Stuck-session detection** | **PENDING** | (config + code) |
| **Dead-process retry** | **PENDING** | (code) |
| **ANSI strip defense-in-depth** | **PENDING** | (minor) |
| **Safety pattern expansion** | **PENDING** | (easy) |
| **Approval queue API** | **PENDING** | (code) |
| **Session replay** | **PENDING** | (script) |
| **Token tracking** | **PENDING** | (code) |
| **WebSocket/SSE streaming** | **PENDING** | (needs sse-starlette) |
| **Docker sandbox** | **PENDING** | (spec phase 4) |
| **Dev trace recording audit** | **PENDING** | (needs run) |

---

*Last updated: 2026-08-21. See `docs/ARCHITECTURE.md` for module details, `docs/OPERATIONS.md` for runbook, `README.md` for project overview.*