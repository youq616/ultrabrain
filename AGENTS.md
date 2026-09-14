# Ultrabrain project rules

## Scope and priority

Deliver a working personal Linux Agent memory service before adding further enterprise features. Keep the project-managed PostgreSQL and existing upstream locks. Preserve the separate Windows qbrain project. A tool name, a plan, or an added file is not a working integration.

## Collaboration contract (user instruction, 2026-09-13)

- The repository-side assistant performs all work it can perform itself: code inspection, implementation, schema repair, Linux/CI testing, documentation, commits and push. Do not transfer these tasks to the user's Windows computer merely because it is available.
- Delegate only work that genuinely requires the user's device, installed clients, local credentials, interactive approval, administrator privileges, or actual deployment environment.
- When local work is necessary, give exactly ONE self-contained prompt in ONE continuous paragraph. Do not split it into numbered sections, multiple prompts or separate instruction blocks. State the target commit, safeguards, actions and required evidence in that paragraph.
- Any script, patch, configuration template or other handoff file must first be committed to this GitHub repository. The same single-paragraph prompt must specify the exact ref/path, how to retrieve it and how to use it. Do not rely on an expiring chat attachment as the sole handoff.
- Do not ask the user to install WSL, build PostgreSQL or rerun Linux tests when repository-side Linux/CI execution can resolve the issue. Windows-only client integration and administrator actions may still need local execution.
- Never request secrets in chat or commit credentials, database contents or personal transcripts. Do not overwrite dirty worktrees, force-push, reset user changes, or alter running user services without explicit authorization.
- Report only actual commits and executed test results. Distinguish unit tests, real PostgreSQL/MCP tests, Windows/WSL compatibility, simulated model outputs and actual client integration. Preserve first-failure evidence. Do not describe pending tests or unconnected modules as passed or complete.

## Engineering gates

Use one canonical personal-memory contract and an authenticated server-derived source/principal boundary. An agent_id is a label, not proof of identity. Keep applied migrations immutable; repair with an explicit follow-up migration. Never expose previously unscoped legacy rows by guessing their owner. Test real schema/store compatibility and MCP tools/list/call paths, not just object normalization. Main must not receive unvalidated application changes; an isolated documentation-only rule change is allowed.

## Mandatory independent subagent review (2026-09-14)

Every implementation phase requires a separate reviewer agent before acceptance or merge to main. A fresh directory, self-review pass, CI job or test runner is not a separate reviewer. Never present the implementation assistant's own findings as independent-agent findings.

The reviewer must independently inspect code and affected repository boundaries. Record the full reviewed commit, actual reviewer session/run identity, concrete file/line findings, executed test evidence and verdict. Fix blocking issues and obtain another review of the corrected commit; approval of an older commit does not cover later changes. No response, a review request, emoji reaction or green CI is not approval.

Use an available repository-side independent reviewer first. If no actual execution path is available, keep the implementation in a development branch/draft PR with review PENDING and main unchanged. Delegate only the missing independent review through the one-paragraph local-agent handoff above; do not require a production install, WSL, secrets or duplicate Linux CI. Never fabricate reviewer identities, results or approvals.

## Code Review Rules

Check explicit capture consent, automatic scopes, server-derived identity, workspace and destination binding, revocation/cancellation before transmission, immutable event replay, journal durability, acknowledgement validation, bounded retries and crash recovery. Assistant observations are not user-confirmed facts. No implicit reading of transcript files, tools, attachments, secrets or hidden reasoning. A client queue is not server acceptance. Preserve original migrations, upstream pins, other Agent configuration and permission boundaries. Distinguish synthetic hook tests from actual client engines and real-model quality.
