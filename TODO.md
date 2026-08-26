# Roadmap

This project is a work in progress. The roadmap below tracks the major capabilities needed for a reliable, agent-agnostic research orchestration platform.

Contributions are welcome. Before starting a large change, open an issue describing the problem and proposed approach so implementation work can be coordinated.

## Current focus

- [ ] Stabilize the core orchestration loop and recovery behavior
- [ ] Complete the provider abstraction for CLI-based agents
- [ ] Improve human-review and approval workflows
- [ ] Add continuous integration and broader automated test coverage
- [ ] Validate the system on reproducible end-to-end research runs

## CLI agent support

Devin CLI is the current reference implementation. The goal is to support any agent that can run in a terminal and expose a controllable process lifecycle.

- [x] Devin CLI reference integration
- [ ] Define a documented CLI-agent adapter interface
- [ ] OpenCode adapter
- [ ] Codex CLI adapter
- [ ] Claude Code adapter
- [ ] Per-agent capability detection
- [ ] Provider-specific resume and trace export support
- [ ] Configurable fallback to another agent when a process fails
- [ ] Adapter conformance tests

## Orchestrator reliability

- [ ] Detect sessions that make no observable progress
- [ ] Add configurable agent and session timeouts
- [ ] Add bounded retry policies for failed agent processes
- [ ] Restore interrupted sessions without losing audit history
- [ ] Validate resumed session identifiers before reuse
- [ ] Add graceful shutdown and restart handling
- [ ] Prevent duplicate execution after reconnects
- [ ] Sanitize terminal output before controller evaluation
- [ ] Add health metrics for agents, queues, and event streams

## Human review and safety

- [x] Manual approval mode
- [x] Immutable human gate for high-risk actions
- [x] Dashboard review queue
- [ ] Approval expiration with safe automatic rejection
- [ ] Browser and system notifications for review requests
- [ ] Reviewer assignment and ownership
- [ ] Approval history with actor, reason, and timestamp
- [ ] Expand destructive-command and credential-access detection
- [ ] Add policy tests for shell, Git, database, and deployment actions
- [ ] Support configurable organization policies without weakening mandatory gates

## Dashboard

- [x] Live session and agent monitoring
- [x] Interactive agent terminal controls
- [x] Recorded run inspection
- [x] Human-review notifications
- [ ] Improve responsive behavior and accessibility
- [ ] Add keyboard navigation throughout the operator workflow
- [ ] Add session filtering, sorting, and search
- [ ] Add a compact view for large numbers of runs and agents
- [ ] Add reconnect and stream-health indicators
- [ ] Add cost, token, and runtime summaries
- [ ] Add a complete session replay view
- [ ] Add visual regression and end-to-end UI tests

## Recording and observability

- [x] Per-session manifests and event logs
- [x] Raw PTY, controller, audit, feedback, and summary records
- [x] Numbered attempts that preserve prior runs
- [ ] Normalize trace exports across agent providers
- [ ] Record controller token usage, latency, and estimated cost
- [ ] Add structured error categories
- [ ] Add deterministic event ordering and replay validation
- [ ] Add optional OpenTelemetry export
- [ ] Document retention and cleanup policies

## Research workflow

- [x] Multi-stage research pipelines
- [x] Independent reviewer gates
- [x] Project briefs written before execution
- [ ] Version and validate pipeline definitions
- [ ] Support branching and parallel pipeline stages
- [ ] Add reusable role and prompt templates
- [ ] Add citation and source-integrity validation
- [ ] Add experiment reproducibility checks
- [ ] Add artifact acceptance criteria per stage
- [ ] Add publication export and PDF validation workflows
- [ ] Publish a fully reproducible example research run

## API and integrations

- [x] REST API for sessions, agents, approvals, and logs
- [x] Server-sent event streams
- [ ] Publish and version the API schema
- [ ] Add generated API documentation examples
- [ ] Add event-stream reconnection and cursor support
- [ ] Add outbound webhooks for approvals and session state changes
- [ ] Add authentication and role-based authorization
- [ ] Add rate limits and request-size limits
- [ ] Add integration tests for live and recorded sessions

## Sandboxing and deployment

- [ ] Define the threat model and supported trust boundaries
- [ ] Add an optional container-based agent runtime
- [ ] Run containers as non-root with constrained mounts
- [ ] Add configurable network restrictions
- [ ] Add per-session CPU, memory, storage, and runtime limits
- [ ] Provide a production deployment guide
- [ ] Add backup and recovery documentation

## Testing and project health

- [ ] Add GitHub Actions for Python and dashboard checks
- [ ] Run unit tests, linting, type checks, and dashboard builds on pull requests
- [ ] Add controller-decision and malformed-response tests
- [ ] Add safety-policy regression tests
- [ ] Add PTY lifecycle and failure-recovery tests
- [ ] Add API contract tests
- [ ] Add browser-level dashboard tests
- [ ] Establish release and changelog conventions
- [ ] Add a contribution guide and code of conduct
- [ ] Select and add an open-source license

## Contribution ideas

Good first contributions are intentionally bounded and should not require access to private credentials:

- Add tests for existing safety rules
- Improve documentation and setup error messages
- Implement search and filtering in the session list
- Add adapter conformance fixtures for CLI agents
- Improve keyboard and screen-reader accessibility
- Add deterministic replay tests for recorded events

When contributing:

1. Open or reference an issue.
2. Keep changes focused and preserve existing API contracts unless the issue proposes a versioned change.
3. Add tests for behavior changes.
4. Do not include API keys, local environment files, generated run artifacts, or private traces.
5. Document user-visible configuration and operational changes.

Completed work belongs in release notes or Git history rather than this roadmap. This file should remain focused on actionable, forward-looking project work.
