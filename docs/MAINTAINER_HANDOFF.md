# Maintainer Handoff and Independent Verification

Last audited: 2026-09-05

This is the cold-start document for a new coding agent or maintainer. Do not trust this summary by itself: reproduce the checks below, inspect the cited files, and compare the working-tree diff before accepting the implementation.

## Outcome

The orchestrator now has two scientific gates after every declared work stage:

```text
work stage -> research critic -> acceptance reviewer -> next work stage
                 | reject              | reject
                 +------ fresh work attempt <------+
```

The critic evaluates the decision process, novelty, assumptions, falsifiability, confounds, executed code paths, and evidence strength. The reviewer remains an independent acceptance gate. Either can reject. Rejections start a fresh work-agent history so a stale `AGENT_DONE` marker cannot be replayed, and a reviewer-rejected revision must pass the critic again.

Local SearXNG discovery is executable and ledgered, remote compute is available through a secret-safe restriction broker, per-agent custom prompts persist across all stages/restores, the dashboard exposes the actual pipeline, and redundant prior checkpoints were removed.

## Start here

From the repository root:

```bash
git status --short
git diff --check
git diff -- orchestrator dashboard/src tests docs README.md .env.example .gitignore
python -m py_compile orchestrator/*.py
python -m pytest -q
cd dashboard && npm run build
```

Expected as of this handoff:

- all Python modules compile;
- 44 pytest cases pass;
- the TypeScript/Vite production build passes;
- Vite emits one known non-fatal Tailwind/Rolldown sourcemap warning;
- exactly two `.pt` checkpoints remain in the two audited run trees.

The runtime's documented environment is the `research-agents` Conda environment. The checks above were also run successfully with the currently active Python environment. Re-run them with `conda run -n research-agents ...` before a production launch.

## Change map

| Area | Primary files | Independent check |
|---|---|---|
| Role graph and gate order | `orchestrator/roles.py` | `test_double_gate_pipeline_order` |
| Gate marker validation and rewind | `orchestrator/control_loop.py` | `test_gate_handoffs_rewind_through_critic` plus smoke pipeline tests |
| Critical research policy | `orchestrator/prompts.py` | Read the critic rubric and paper refusal rules; run prompt tests |
| Persistent per-agent instructions | `orchestrator/session_store.py`, `orchestrator/app.py` | `test_persistent_agent_prompt_survives_restore_and_spawn` |
| SearXNG execution and ledger | `orchestrator/searxng.py` | Ledger test plus live command below |
| Restricted experiment servers | `orchestrator/server_inventory.py`, `servers.example.json` | Inventory/redaction tests plus optional live dry run |
| Safety classification | `orchestrator/safety.py` | Direct SSH/SCP/remote-rsync tests |
| Preflight/health | `orchestrator/app.py`, `orchestrator/config.py` | `GET /preflight` and `GET /health` |
| Dashboard workflow | `dashboard/src/` | Production build, then manual browser walkthrough |
| Research verdicts | `docs/RESEARCH_QUALITY_AUDIT.md` | Re-open every cited run artifact |
| Cleanup policy | critic/experiment prompts and quality audit | Repeat checkpoint inventory command below |

## State-machine invariants

Verify these directly in code and tests:

1. `build_pipeline` inserts `critic` and then `reviewer` after each declared canonical work role.
2. Only one agent may own a role. This is enforced by the API and mirrored in the UI.
3. `AGENT_DONE` is accepted only from the active, matching non-gate role.
4. `APPROVE/REJECT` is accepted only from the active gate and must name the nearest preceding work role.
5. Critic approval advances to reviewer. Reviewer approval advances to the next work role.
6. Either rejection rewinds to the rejected work-role index and calls `restart_agent(..., resume=False)`.
7. Controller-requested transfers cannot bypass validated markers.
8. Existing recorded manifests retain their recorded pipeline; there is no silent migration of historical sessions.

## SearXNG boundary

The literature, critic, and reviewer runtime prompts receive an exact helper command. The helper sends the query to the configured local JSON API and appends one row per discovery result to a workspace-local JSONL ledger. Every row is marked `unreviewed`; snippets are never promoted to evidence.

Live check from a disposable session workspace:

```bash
cd runs/SESSION_ID
python ../../orchestrator/searxng.py \
  "closest prior art for the test idea" \
  --url http://127.0.0.1:8080 \
  --output outputs/literature/search_log.jsonl
```

Then inspect the ledger and independently open primary sources. `GET /preflight` deliberately reports the service unready if SearXNG cannot answer, because external novelty checks must not silently fall back to an unlogged search path.

## Private server inventory and threat boundary

Copy `servers.example.json` to `servers.json`, fill in the host, user, type, authentication, and restrictions, then:

```bash
chmod 600 servers.json
python orchestrator/server_inventory.py --file servers.json inspect
python orchestrator/server_inventory.py --file servers.json run gpu-lab-1 -- nvidia-smi
```

Rules:

- `servers.json` is gitignored and must be mode 0600.
- Authentication may use `identity_file` or `password`.
- Inspection returns only redacted metadata.
- Passwords are supplied to `sshpass` through a file descriptor, never its argument list.
- Only argv matching an owner-declared `allowed_command_prefixes` entry can run.
- The broker changes to the declared remote workdir and invokes GNU `timeout` on the server, with TERM followed by KILL after ten seconds. The SSH wait includes a separate connection/cleanup allowance. GNU coreutils is required remotely.
- SSH host keys must be verified and enrolled by the operator before connecting.
- Command allowlists and workdirs are operational guardrails, not an OS sandbox. Approved Python programs retain their remote account permissions. GPU, storage, process and usage-window restrictions in notes require enforcement by a scheduler, restricted account, container or cgroup.
- Detached workers can escape process-group timeouts; use scheduler job limits for those experiments.
- Immutable forbidden commands are rejected even if an allowlist prefix is overly broad.
- Experiment agents are instructed not to invoke `ssh`, `scp`, `sftp`, `rsync`, or `sshpass` directly; those paths are high-risk in the outer safety gate.
- No real server inventory was supplied during this audit, so a live remote job remains an operator verification step.

Prefer SSH keys. If password auth is configured, `sshpass` must exist or preflight fails.

## Research-quality conclusion

Read `docs/RESEARCH_QUALITY_AUDIT.md` before continuing any prior experiment. The concise verdict is:

- reject/quarantine the original reference sliding-window attention paper direction;
- treat cross-step invalidation as crowded and unproven;
- treat learned memory as non-novel and time schedules as an ablation;
- retain old DLM work only as diagnostics;
- allow TR-KV exactly one frozen, bounded confirmatory cycle;
- do not call either TR-KV draft publication-ready.

The gate threshold is at least 3/5 in novelty, importance, evidence, feasibility, and decisiveness, and at least 18/25 total. TR-KV currently scores 17/25. A new paper is blocked until the frozen five-mechanism grid, held-out task-quality gate, uncertainty, code-path distinction, and claim traceability all pass.

## Checkpoint cleanup

The audit originally found 96 `.pt` files totaling 30,068,880,100 bytes. It permanently removed 94 redundant files totaling 26,028,899,306 bytes. This workspace cannot recover them without an external backup.

The only retained model files are:

```text
runs/reference-window-flow-20260825/outputs/experiments/ce_flow_overfit_1200/checkpoint.pt
runs/reference-window-flow-20260825/outputs/experiments/ce_flow_simple10/checkpoint.pt
```

Verify:

```bash
find runs/reference-window-flow-20260825 runs/dlm-survey \
  -type f -name '*.pt' -printf '%s\t%p\n' | sort
```

Do not restore the invalid CIFAR or superseded full-sequence/multisample checkpoints merely because storage is available. A future experiment should retain the best checkpoint only, unless another checkpoint is required for a declared scientific comparison or exact resume.

## Dashboard verification

Build, launch, and manually confirm:

1. The shell uses the dark Research Control visual system at desktop and mobile widths.
2. Home shows API, controller, Devin, SearXNG, server-broker, running, and waiting status.
3. A full-pipeline wizard defaults to literature, critic, reviewer, methodology, experiments, and writer roles without duplicate roles.
4. Leaving workspace blank resolves to the session ID itself, not `runs/<id>`; the backend already roots it below `runs/`.
5. A session overview shows the full stage progression and distinguishes critic gates from review gates.
6. The Quality Gates page includes both roles and excludes both from work-agent comparisons.
7. Preflight exposes SearXNG and optional server inventory readiness.

## Known limitations and honest non-verifications

- No new TR-KV or paper experiment was run; this change prevents weak work from being promoted and documents the only warranted next experiment.
- No live remote server was available, so only parser, redaction, allowlist, timeout-path code review, and safety behavior were tested.
- A live local SearXNG response depends on the operator's service; unit coverage validates ledger semantics without external network access.
- Historical recorded sessions keep their old reviewer-only pipeline. Start a new session to use the double gate.
- The current remote broker streams command output to the operator process; it does not yet copy result artifacts automatically. Agents must use project-approved commands that write into the declared remote workdir and record hashes when results are returned through an authorized channel.
- The Vite build has a non-fatal sourcemap warning from the Tailwind transform.

## Acceptance checklist for the next agent

Do not declare this handoff verified until all boxes can be supported with direct evidence:

- [ ] Working-tree scope contains no unrelated or secret files.
- [ ] Python compile, all tests, and dashboard build pass.
- [ ] Critic-first and fresh-rewind invariants match code and tests.
- [ ] SearXNG live preflight and one ledger write succeed.
- [ ] `servers.json` is absent or private mode 0600; redacted inspect shows no secret.
- [ ] If remote compute is needed, one allowlisted harmless command succeeds and one disallowed command fails.
- [ ] Exactly two retained checkpoints remain.
- [ ] Research-quality scores agree with the cited artifacts or are revised with explicit contrary evidence.
- [ ] No current paper is labeled final before both experiment gates approve.
