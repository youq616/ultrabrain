# Personal-status receiver review and publication gate

Base commit: `1a1c74474a057d2e60eac83a6b8e190792d234e0`; base tree: `8d53706a1bb5cea1961afbaa84e8a28643db12d1`.

Recovered the previously unsubmitted source checkpoint without asking the user to repeat implementation or configure credentials. ZIP SHA-256: `75d955ee65ca87510158a8291d877c9358eab3a307e08baa23b78488565be6f0`; patch SHA-256: `9f9527ea8d0c4bea1d08c8d7229668b691fbdf71dd073b5bf2bc4b5d010708c9`. Reconstructed base and checkpoint Git index trees exactly, including four upstream gitlinks. The checkpoint tree was `8636f07d576c6aef53b0ab83dd4f173957ad3e0e`. No original implementation is inferred from a verbal summary.

## Receiver findings and corrections

The restored checkpoint reran successfully: 497 JavaScript and 255 Python tests. A separate adversarial implementation review then identified a real contract mismatch that those tests missed: the existing live-services harness accepts `systemctl show` success or a complete not-found result with exit5, but the new parser rejected5 and allowed generic1/3/4 whenever any unit was absent. As a result, the optional-Worker case could be called unavailable for recognized absence, or reported successful after a generic failing command. This was reproduced with bounded synthetic responses and a real child process returning5, **not** a live-manager reproduction.

The parser now accepts only an actual integer exit status0, or5 with a complete four-unit inventory containing explicit inactive/not-found evidence. It rejects generic failures even when the optional Worker is absent, plus unknown exits, truncated output and contradictory absence evidence. The old code4 absence fixtures were corrected to the existing repository contract, not generalized to accept any failure. Nine new receiver test methods cover these paths, property/record order and privacy-safe stderr. On the checkpoint, they produced nine failing assertions including subtests; after repair, all52 status-specific Python methods pass. Strict integer type validation is defensive parser hygiene, not claimed to fix an externally reachable privilege exploit.

The implementation assistant performed this review in a separate pass. It is **not** a different reviewer Agent and is not sufficient for merge. The final candidate must also receive an actual independent agent review; final SHA, reviewer identity/outcome and all current CI results belong in the PR acceptance record. Historical checkpoint review text is preserved with an explicit historical label.

## Actual execution on the repaired source

- Node.js22.16.0:497 tests pass,0fail,0skip.
- Python3.13.5:264 tests pass, including52 status/process/review tests.
- CLI and live integration JavaScript syntax, Python AST and Bash syntax checks pass.
- Running the actual Node CLI as the ordinary Linux test account returns exit3/manager_unavailable in this container. It creates no ULTRABRAIN_HOME and starts no services. This result is **not** a live systemd success.
- Existing disposable-runner personal-services integration contains six added status observations (absent/minimal/failed Worker/recovered Worker/restart/stopped target). Current-candidate live user-systemd CI is mandatory; do not reuse the baseline's successful service tests.

No current database, model provider, user workspace or production service is needed for this status implementation. No shell interpolation, arbitrary unit selector, remote bus, raw journal, ExecStart, Environment or credential field is added. Model/capture permission, existing service plans/installer, original migrations, upstream locks and MCP surfaces are unchanged.

## Scope and non-claims

Observes fixed conventional local user units only. Unit state is not application readiness, and fixed names do not verify installation binding. Reports remain explicitly `application_ready:not_checked` and `installation_binding_verified:false`. Worker requirement is only a diagnostic choice; it cannot enable capture/model calls. Properties may change during or after the observation. Failures never become a successful empty inventory. A trusted OS, systemctl and same-account manager remain trust assumptions. No independent-agent approval, live-systemd success, zero-defect guarantee or Personal V1 completion is predeclared here.
