# Dashboard Guide

The dashboard is the main way to start, watch, and steer research runs. This guide follows the screens in the order you meet them.

- [Start the dashboard](#start-the-dashboard)
- [Home page](#home-page)
- [Start a new run](#start-a-new-run)
- [The run page](#the-run-page)
- [Responding when a run needs you](#responding-when-a-run-needs-you)
- [The agent page](#the-agent-page)
- [When to step in](#when-to-step-in)
- [Checking that a run is really finished](#checking-that-a-run-is-really-finished)
- [Recovering a stuck or stopped run](#recovering-a-stuck-or-stopped-run)

## Start the dashboard

~~~bash
cd dashboard && npm install && npm run build && cd ..
conda run --no-capture-output -n research-agents \
  python -m uvicorn orchestrator.app:app --host 127.0.0.1 --port 8765
~~~

Open **http://127.0.0.1:8765/**. After rebuilding the dashboard, hard-refresh the browser to load the new version.

The dashboard works on desktops, tablets, and phones. On narrow screens the list of runs moves into a menu (☰) at the top left.

## Home page

| Section | What it tells you |
|---|---|
| **Header** | **API online / API offline / Controller error**. If any run is waiting on you, a **Needs you (N)** button appears and takes you there. |
| **Setup** | The server's readiness checks. When everything passes it shrinks to a single line, "Setup ready". A failed check shows a one-line fix. Only the default agent CLI is required; the others are optional. |
| **Agent CLIs** | Which CLIs (Devin, OpenCode, Codex, Claude Code) the server can find. **Compare CLIs** shows each one's command, default model, and capabilities. |
| **Runs** | Every run, newest first, with a status and the current step (for example "Step 5 of 8 · Experiments"). Search by ID, goal, or CLI, or filter by status. |

The run statuses are:

| Status | Meaning |
|---|---|
| **Needs you** | An approval or an agent question is waiting. |
| **Running** | An agent is working. |
| **Stopped · resumable** | Nothing is running and the run is not finished. Open it and click **Resume run**. |
| **Completed** | Every stage passed review. |
| **Failed** | An agent ended with an error. Check its terminal, then resume. |

## Start a new run

Click **New run**. The wizard has four steps.

### 1. Basics

- **Template:**
  - *Full Research Pipeline:* survey → methodology → experiments → paper, each followed by a critic and a reviewer.
  - *Literature Survey Only*
  - *Experiments + Paper*
- **Research topic:** used to name the run and to title the brief.
- **Run ID:** filled in from the topic. It names the log folder.
- **Workspace folder:** defaults to the run ID, under `runs/`. Agents work there and `PROJECT_BRIEF.md` is written there.

### 2. Brief

- **Goal:** one or two sentences.
- **Constraints:** one enforceable rule per line, for example "Keep peak GPU memory below 6 GB".
- **Project brief:** the full contract every agent reads before acting. The wizard drafts it from the fields above until you edit it yourself.

A useful brief states:
- the research question
- evidence rules, including local SearXNG for search
- datasets and licences
- baselines and metrics
- seeds and leakage checks
- compute and storage limits
- required artifacts
- the target venue
- what would count as failure

### 3. Agents

- **Default agent CLI:** pick from the installed CLIs. CLIs that are not installed are disabled.
- **Each agent:** you can override the CLI and the model, or add an extra instruction. Mixing CLIs is fine; for example, the critic can run on a different CLI from the work stages.

### 4. Review & start

Choose the approval mode:

| Mode | What happens |
|---|---|
| **Manual** | Medium-risk actions, such as installing packages or committing, wait for you. |
| **Autonomous** | The controller may approve low- and medium-risk actions itself. It needs a controller API key in `.env`. |

High-risk actions (deleting files, pushing, publishing, deploying, touching secrets, remote access) always wait for a person, in both modes.

Click **Create and start**. If the server rejects the run, for example because a CLI is not installed or the workspace already has a different brief, the reason appears in the wizard.

## The run page

The top of the page is always visible:

1. **Title and goal:** the run ID, the goal (click **Show full goal** for long ones), the default CLI, and the approval mode.
2. **Status banner:** one sentence saying what is happening, and the main action:
   - **Resume run** when the run is stopped
   - **Stop all** while it is running
   - **Review now** when something is waiting on you
3. **Action needed:** appears only when you are needed. See [Responding when a run needs you](#responding-when-a-run-needs-you).

Below that, four tabs:

| Tab | What's in it |
|---|---|
| **Overview** | **Pipeline**: every stage with its critic and reviewer checks, marked *Done*, *In progress*, *Stopped here*, *Failed here*, or *Not started*. "Sent back 2×" means reviewers rejected that stage twice; hover over it to see the latest reason. **Agents**: one row per agent with role, ID, CLI, model, attempts, and status. Use **Terminal** to watch an agent and **Details** for its full record. |
| **Terminal** | The live screen of one agent, with a picker to switch agents. You can type a line, press Enter, Esc, or Ctrl-C, and pause, stop, or restart the agent. Below it, **Give the agent feedback** offers three ways to deliver a message (see below). |
| **Activity** | A readable history of the run, newest first. **Key events** hides routine noise, **Everything** shows all events, and **Raw JSON** shows exactly what was recorded. You can filter by agent. |
| **Settings** | Run details (ID, CLI, approval mode, workspace), **Start a side task** (run an extra agent for a one-off job without changing the pipeline), and **Remove run**. Removing a run stops its agents and removes it from the server; the logs on disk are kept. |

### Feedback modes

| Mode | When to use it |
|---|---|
| **Send now** | The agent is waiting at its prompt and you want to answer directly. The text is typed into the terminal and Enter is pressed. |
| **Add as guidance for next step** | Default and least disruptive. The terminal is not touched; the controller reads your note before its next decision. |
| **Interrupt and send** | The agent is going the wrong way. This sends Ctrl-C to stop it, then types your message. |

## Responding when a run needs you

The **Action needed** section can show three kinds of item.

- **Approval request:** the controller wants to press a key or send text that the safety rules flag as risky. You see:
  - the risk level
  - exactly what will be sent if you approve (for example "Press Enter")
  - the terminal text it is responding to, such as a command the agent wants to run
  - the controller's reason

  Click **Approve** to run exactly that action once, or **Deny** to dismiss the agent's prompt without running anything. You can add an optional note.
- **Agent question:** the agent printed `AGENT_QUESTION: …`, or the controller escalated because it was unsure or the agent appeared stuck. Type a reply. It is sent straight into that agent's terminal.
- **Controller error:** the controller LLM is failing, for example rate-limited (429) or misconfigured. The controller retries temporary errors on its own. For persistent ones, fix the key or model in `.env` and restart the server.

## The agent page

Open it with **Details** on an agent row. The header shows:
- the agent's role, status, CLI, and model
- the **resumable CLI session ID** (with a Copy button), which is what **Resume run** uses
- the attempt count, how many of those were automatic retries, and start and finish times

| Tab | What's in it |
|---|---|
| **Overview** | Summary, the controller's latest decision, and pointers to the other tabs. |
| **Terminal** | The live screen, while the agent is running. |
| **Output** | Everything the agent printed, with colour codes removed. **Load more** fetches earlier output. |
| **Replay** | Step through the screens the controller saw, with a slider. |
| **Decisions** | Every controller decision with its action, risk, confidence, and reason. You can hide routine waits. |
| **Keystrokes** | Every input actually sent, and whether it came from the controller, a person, or an automatic startup answer. |
| **Feedback** | Notes sent to this agent. |

**Output**, **Replay**, **Decisions**, and **Keystrokes** have an **attempt** picker. Every retry or revision is kept as its own numbered attempt.

## When to step in

Leave agents alone while they search, download, build, or train; interrupting wastes work. Step in when:
- **Action needed** shows an item
- an agent has been idle at its prompt for a long time
- an agent's process failed (status *Failed*)
- you can see an evidence-quality problem, such as an unverified source or a metric that doesn't match the claim

Prefer **Add as guidance for next step** over interrupting.

## Checking that a run is really finished

A run shows **Completed** only after every stage's reviewer printed an exact `APPROVE` marker for it. Before trusting the results, check:
1. **Critic reports:** every stage has one in `outputs/critiques/`, showing real adversarial checks.
2. **Reviewer reports:** every stage has one in `outputs/reviews/`, approving the correct preceding stage.
3. **Artifacts:** the required files exist in the workspace.
4. **Evidence:** claims map to primary sources or recorded metrics.
5. **Failures kept:** failed and negative runs are still recorded.
6. **Paper:** the paper builds and the reproduction commands work.

## Recovering a stuck or stopped run

1. Open the run. The banner says what state it is in.
2. Read the agent's **Terminal** and its latest decision under **Details → Decisions**.
3. If an approval or question is waiting, answer it under **Action needed**.
4. If the run is stopped, click **Resume run**. The active stage's agent continues its previous CLI conversation when one was recorded. Otherwise it restarts that stage fresh, keeping all files and earlier attempts.
5. Use **Restart** on the Terminal tab only after confirming the agent cannot make progress.

Runs stay visible after the server restarts. Running agents are not restarted automatically; click **Resume run** to continue.
