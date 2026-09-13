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
