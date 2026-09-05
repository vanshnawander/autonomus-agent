# Research Quality Audit

Date: 2026-09-04

## Scope and standard

This audit evaluates the retained research artifacts in `runs/reference-window-flow-20260825` and the older `runs/dlm-survey` work. It asks whether an idea is distinct, important, supported, feasible, and testable—not whether a file exists or a training loss decreased.

Scores use the critic gate's 0–5 rubric:

- novelty;
- importance;
- current evidence;
- feasibility under the declared resource contract;
- decisiveness of the proposed experiment.

An idea is eligible to advance only if every category is at least 3 and the total is at least 18/25. Scores describe the evidence currently on disk; they are not forecasts of what future work might show.

## Verdict

No existing paper artifact is publication-ready. The original reference sliding-window attention direction should remain quarantined. Token-Routed KV (TR-KV) is the only direction worth one more tightly bounded experiment cycle, but it currently scores below the advancement threshold because the frozen five-mechanism baseline grid and held-out task-quality evidence are incomplete.

Do not present any current draft as a finished paper.

## Idea portfolio

| Direction | Novelty | Importance | Evidence | Feasibility | Decisiveness | Total | Decision |
|---|---:|---:|---:|---:|---:|---:|---|
| Reference sliding-window attention for flow/diffusion | 2 | 2 | 1 | 3 | 1 | 9 | Reject |
| Cross-step cache invalidation | 2 | 3 | 1 | 3 | 2 | 11 | Defer |
| Learned reference/memory token | 1 | 2 | 1 | 3 | 2 | 9 | Reject as central claim |
| Time-dependent attention schedule | 1 | 2 | 1 | 4 | 2 | 10 | Keep only as ablation |
| Token-Routed KV (TR-KV) | 3 | 3 | 3 | 4 | 4 | 17 | Conditional; one decisive cycle only |
| DLM shortcut/diversity diagnostics | 2 | 2 | 2 | 4 | 3 | 13 | Diagnostic, not a paper claim |

## Evidence behind the verdicts

### Reference sliding-window attention

The mechanism is too close to ordinary local/global attention to support the novelty language used in the early artifacts. More importantly, the executed CIFAR setup entered or approximated the full-attention recovery regime, so it did not isolate the claimed sparse/reference mechanism. The one-dimensional raster window is also poorly matched to the two-dimensional image structure, and a class token is an impoverished stand-in for the reference information the motivating story requires.

The run's own closeout and review artifacts quarantine this evidence. A successful optimization trace in this regime would not validate the paper's stated mechanism.

Relevant retained records:

- `runs/reference-window-flow-20260825/outputs/literature/ideas.md`
- `runs/reference-window-flow-20260825/outputs/session_closeout.json`
- `runs/reference-window-flow-20260825/outputs/reviews/rcba_amendment_review.md`
- `runs/reference-window-flow-20260825/outputs/methodology/rcba_novelty_overlap_audit.md`

### Cross-step cache invalidation

This is a plausible systems question but sits in a crowded neighborhood of diffusion caching and reuse methods. The current artifacts do not establish a defensible distinction from closest prior art or show a task where the proposed invalidation rule produces an important quality/latency frontier. It may be revisited only with an explicit overlap table and a falsifying baseline suite.

### Learned memory and time schedules

A learned memory/reference token is already a common architectural device and cannot carry the paper by itself. A time-dependent schedule may be useful operationally but is an ablation or implementation choice, not a sufficient central contribution.

### TR-KV

TR-KV has the best current case because the later work reframed the question around a measurable systems/correctness mechanism and produced a more discriminating protocol. It still lacks the complete, frozen confirmatory grid and held-out OCR/task-quality preservation evidence required for a positive paper claim.

Before promotion, the experiment executor must run the exact five-mechanism protocol in `outputs/DECISIVE_TRKV_EXPERIMENT_PLAN.md`, retain raw outputs and failures, show that each mechanism executes a distinct code path, recompute metrics independently, and enforce a held-out quality gate. Post-hoc protocol changes reset the evidentiary status to exploratory.

### Older DLM work

The confidence-shortcut and diversity-controlled experiments are useful toy diagnostics. The older review correctly caught broken or weak experiment paths. They do not yet support a general method or publication claim and should not be merged into TR-KV merely to enlarge the story.

Relevant retained record:

- `runs/dlm-survey/experiments/REVIEW.md`

## Paper audit

The current TR-KV drafts are short, provisional summaries rather than publication-ready manuscripts:

- `runs/reference-window-flow-20260825/outputs/paper_trkv_draft.md`
- `runs/reference-window-flow-20260825/outputs/paper_trkv_draft_v02.md`
- `runs/reference-window-flow-20260825/outputs/reviews/trkv_draft_audit.md`

Blocking issues:

1. The central result is not backed by a completed frozen confirmatory grid.
2. Held-out OCR/task-quality preservation is incomplete.
3. Novelty remains conditional on a closest-prior-art overlap audit.
4. Uncertainty and independent-seed evidence are insufficient for the intended claim.
5. The draft cannot satisfy claim-to-artifact traceability for every quantitative statement.

The correct output until these pass is a gap report, not another polished paper-shaped draft.

## Checkpoint retention decision

Only checkpoints used by the surviving corrected diagnostics should remain:

- `outputs/experiments/ce_flow_overfit_1200/checkpoint.pt`
- `outputs/experiments/ce_flow_simple10/checkpoint.pt`

The first supports the corrected one-example cache/trajectory diagnostics. The second supports the multi-example diagnostic evaluation. All invalid CIFAR best/final checkpoints and superseded large overfit/multisample intermediates are scientifically redundant because their conclusions are quarantined, their runs are superseded, or both. Metrics, configs, logs, reviews, and source code remain the durable scientific record.

## Required next decision

Run exactly one bounded TR-KV confirmatory cycle. If it misses the frozen task-quality, correctness, or efficiency thresholds, record the null result and stop the direction. If it passes, the critic must rescore it at 18/25 or higher before the reviewer can authorize paper writing.
