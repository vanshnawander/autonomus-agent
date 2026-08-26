# Dashboard Operator Guide

## Start

~~~bash
conda run -n research-agents python -m pip install -r requirements.txt

cd dashboard
npm install
npm run build
cd ..

conda run --no-capture-output -n research-agents \
  python -m uvicorn orchestrator.app:app --host 127.0.0.1 --port 8765
~~~

Open http://127.0.0.1:8765/.

## Create A Project

Select **Start Research Session**:

- **Preset**: use the full pipeline for survey, method, experiments, paper, and reviews.
- **Session ID**: unique identity under logs/.
- **Workspace**: relative directory below the configured runs/ root.
- **Goal**: concise outcome for controller and handoffs.
- **Constraints**: one enforceable requirement per line.
- **Project brief**: complete contract saved before work starts.
- **Approval mode**: manual approvals or autonomous.
- **Agents**: role/ID mapping; retain a reviewer for publication work.

A useful brief states the falsifiable question, primary-source and local-SearXNG policy, datasets and licenses, baselines, ablations, metrics, seeds, leakage checks, Conda/GPU/storage limits, required artifacts, venue, and rejection criteria.

The workspace cannot be absolute or escape the configured root. Different existing PROJECT_BRIEF.md content is never overwritten.

## Approval Modes

**Manual approvals** keeps a person responsible for medium-risk confirmations while the controller continues to guide Devin.

**Autonomous** lets the configured OpenRouter controller execute low- and medium-risk actions. It requires a key in private .env.

Both modes stop for high risk. No UI option can approve destructive commands, secrets, publishing, pushes, deployments, or similarly consequential external actions.

## Monitor

- **Pipeline**: active stage and reviewer gates.
- **Live terminal**: current Devin PTY.
- **Events**: lifecycle, questions, approvals, retries, and handoffs.
- **Approvals**: unresolved decisions.
- **Controller**: structured decisions, risk, and rationale.
- **Audit**: actions actually executed.
- **Attempts**: immutable retries and revisions.
- **Feedback**: context, immediate, or interrupt input.

Avoid continuous intervention while an agent is searching, downloading, building, or training. Intervene for a pending approval, explicit question, repeated idle state, failed process, or evidence-quality problem.

## Verify Completion

1. Every stage has an exact validated marker.
2. Every reviewer approved the correct preceding stage.
3. Required workspace artifacts exist.
4. Claims map to primary sources or immutable metrics.
5. Failed and negative runs remain recorded.
6. Manifest, events, handoffs, and numbered attempts exist under logs/<session-id>/.
7. Paper build and reproduction commands pass.

## Recover

1. Read the terminal and latest controller decision.
2. Check Approvals and the latest Audit attempt.
3. Prefer context feedback over interruption.
4. Restart or resume only after confirming the process cannot progress.

Recorded sessions remain visible after service restart, but live control loops are not reconstructed automatically.
