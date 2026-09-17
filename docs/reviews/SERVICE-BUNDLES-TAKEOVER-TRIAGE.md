# PR #8 service-bundles follow-up

Date: 2026-09-17. Reviewer: `/root/remote_state_audit`. Read-only comparison; no branch, PR, service or user configuration was changed.

Compared main `a5e76f7ab2af4dddb1f72d8a95ab02d2f32593f6` with PR #8 head `1d02a629c8093cfdc50a09ea9cb2720d9d02fea6`. PR #8 forked from `445d22c465f634829a27c9e91f1f7dc61b3d14e7`; main subsequently accepted service plans in [PR #7](https://github.com/youq616/ultrabrain/pull/7) and fixed-name service observations in [PR #9](https://github.com/youq616/ultrabrain/pull/9).

## Decision

Do not merge PR #8's generator wholesale. Its basic product purpose is already implemented by main: private inactive exports, integrity verification, owner console, separately authorized periodic consolidation and documented manual activation. Its remaining differences are optional scheduling/deployment policies, not a missing end-to-end installer.

The next useful implementation phase is **reviewed-plan deployment and rollback for main's fixed personal unit set**. Neither branch provides this transaction. Keep PR #8 intact as a design reference until its optional timer policy is accepted or explicitly deferred.

## Capabilities that remain distinct

| Capability | PR #8 implementation | Main implementation and significance |
|---|---|---|
| Periodic execution policy | `Type=oneshot` worker plus `.timer`; `OnActiveSec=30s`, `OnUnitInactiveSec=interval`, `Persistent=false`, worker `Restart=no`, 600-second start limit. | `Type=exec` resident worker uses `--loop --limit 1 --interval`; processes a batch immediately, then sleeps after it. Both already schedule authorized queued work. A timer would offer process teardown between batches and separate timer controls; it is not necessary to establish periodic processing. |
| Work per batch | Configurable `--limit` from 1 to 4. | Service generator fixes limit to 1. The underlying existing worker can already accept a limit; this is a service-plan option gap only. |
| Unit naming and database dependency | Configurable `--name` prefix and `--database-unit`; no personal target. | Fixed target, console, worker and database names. PR #8 could coexist under other names, but neither implementation proves the chosen database unit belongs to the intended installation. |
| Automatic offline preflight | Calls runtime preflight while rendering and emits `ExecStartPre` for console and worker. | Plan generation permits not-yet-installed paths and does not call preflight; docs require explicit preflight/health before deployment. Port/actual database/client readiness is unproven by either offline check. |
| Self-contained verification settings | Pinned manifest embeds render settings, so verification needs directory plus expected manifest hash. | Verification re-renders from the same CLI options and expected plan hash; the exported manifest contains unit hashes, not the full settings. Main additionally supports reviewing the plan before export. |
| Extra namespace directives | Emits `PrivateUsers`, `PrivateTmp`, `ProtectSystem=strict`, `ProtectHome=read-only` and constrained write paths for the personal units. | Personal units deliberately do not promise a filesystem namespace sandbox. PR #8's directives are a distinct host-compatibility/security choice, not a verified portable capability. The pre-existing database unit remains separately hardened. |

Sources: [PR #8 generator](https://github.com/youq616/ultrabrain/blob/1d02a629c8093cfdc50a09ea9cb2720d9d02fea6/scripts/personal-services.py) lines 56–134, 149–214, 220–240; [main generator](https://github.com/youq616/ultrabrain/blob/a5e76f7ab2af4dddb1f72d8a95ab02d2f32593f6/scripts/personal-services.py) lines 45–120, 292–338; [existing worker loop](https://github.com/youq616/ultrabrain/blob/a5e76f7ab2af4dddb1f72d8a95ab02d2f32593f6/scripts/personal-worker.mjs) lines 36–43.

## Installation, activation and rollback are still manual

Both personal-services CLIs only create/verify inactive files. PR #8 exposes `render` and `verify`; main exposes plan, `--output` and `--verify`. Neither calls systemctl, installs a personal unit, changes enablement, switches old/new exports, or rolls back an interrupted deployment. Both documentation sets instruct the operator to link/start/stop and switch directories manually. Main's separate [install-service.py](https://github.com/youq616/ultrabrain/blob/a5e76f7ab2af4dddb1f72d8a95ab02d2f32593f6/scripts/install-service.py) has `--enable`, but its unit inventory is **database and MCP only** (lines 80, 97–111), not personal target/console/worker. PR #8 did not change that file.

Main's [personal-status](https://github.com/youq616/ultrabrain/blob/a5e76f7ab2af4dddb1f72d8a95ab02d2f32593f6/scripts/personal-status.py) is an observer, not a deployment verifier. It uses four fixed names (lines 18–19), expects console/worker `Type=exec` and active/running (147–153), and explicitly returns `installation_binding_verified:false` and `application_ready:not_checked` (184–190). PR #8's default console `Type=simple`, idle oneshot worker, timer and missing target would therefore be incompatible with these status expectations. Custom names also fall outside its allowlist.

## What a new phase should implement

Extend the accepted main contract, preserving its default console-only plan and separate model consent:

1. Bind a reviewed plan hash and exact exported inventory to an explicit deployment operation; inspect existing links, drop-ins, selected installation and unit state before proposing writes.
2. Refuse unknown/conflicting unit ownership and preserve operator customizations. Keep the existing database/MCP units outside personal-unit replacement.
3. Provide a bounded first-install/update action and a durable rollback receipt that can restore the previous links/enablement after partial failure. Activation and model scheduling must remain separately explicit.
4. Verify the resulting installation binding and actual requested services. Distinguish manager activity from console/database/MCP readiness, and expose failure without relabeling it success.
5. Exercise failures and rollback on disposable real user-systemd CI and obtain a fresh independent review. No need to move these repository-side tasks onto the user's Windows machine.

A later timer option can be designed within that contract if desired. It must adapt target stop behavior, status semantics, missing-model behavior and double-scheduling prevention; importing PR #8 verbatim would not provide those integrations.

## Existing branch defects and regressions to avoid

PR #8 is still a conflicting draft, with its original inventory-race finding unresolved: it lists expected files before reading, then never rechecks inventory after those reads (lines 169–173). Main already checks inventory again, timestamps and each observed file identity after all reads (216–254), and refuses export into known systemd unit search paths (152–208). Replacing main with PR #8 would lose these protections.

Main also fixes runtime environment arguments, `GBRAIN_HOME`, `--no-env-file`, and clears Python injection variables (55–60). PR #8 instead uses the repository as its working directory, lacks `--no-env-file` and does not clear `PYTHONPATH/PYTHONHOME` (71–89). Its automatic preflight must not be assumed to compensate for those differences.

The historical PR #8 service CI failed with a suppressed-detail `systemctl --user exit 1`; this report does not assign an unproven root cause. The old P1 review objected to CI enabling linger. **Current main's disposable CI also contains `sudo loginctl enable-linger`** ([workflow](https://github.com/youq616/ultrabrain/blob/a5e76f7ab2af4dddb1f72d8a95ab02d2f32593f6/.github/workflows/personal-services.yml), line 38), so this behavior must not be reported as absent or already corrected on main.

## Verification performed for this comparison

Read both exact generator revisions, the existing worker implementation, status implementation, legacy installer, current/branch deployment docs and integration fixtures. Executed both pure render functions with synthetic absolute paths and identical authorization settings: main produced target + exec console + exec loop worker; PR #8 produced simple console + oneshot worker + timer with startup preflight. The render probe exited 0 and did not generate files, query a manager, connect a database or start services. This comparison does not claim a new live service test or a new CI pass.
