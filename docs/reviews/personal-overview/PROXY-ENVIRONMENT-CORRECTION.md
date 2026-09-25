# Explicit proxy test credential environment — 2026-09-25

Follow-up to `a970a2ec63b9b3285d2dc37bd871739a1047e05a`. This is a **test-harness correction**, not a production authentication change. All production code remains byte-identical to `21395be76f6a923d59e01b3ad5f6495f627c5166`. Independent-agent review is still BLOCKED by the actual exhausted Codex review quota; no separate approval was received.

## Actual failure and confirmed cause

Full validation run36126293053/job108043071485 reached the new packaged-proxy HTTP test and failed with MCP connection closed. Previous overview module database/MCP/browser and all other eight workflows passed at a970, but this full-workflow failure remains a blocking acceptance result, not an ignored flake. Preserve its exact log excerpt in `proxy-environment-ci-first-failure-excerpt.log`.

The SDK stdio launcher does not inherit arbitrary parent environment variables. The existing direct CLI subprocess used process.env, so its HTTP probe received the synthetic bearer; the newly added SDK-launched proxy did not. Its credential lookup therefore could not initialize. The SDK's stderr was intentionally drained, leaving the outer connection-closed exception. The inspected SDK1.29.0 source in verified CI diagnostic artifact10860715490 confirms its normal inherited allowlist and explicit server.env merge. The full diagnostic ZIP SHA256 is `9c2db948f54f99c04ca7e0f624751a4c23ce130b8ddadf5fba319f9010f8f7b8`.

An actual pinned SDK + Node child-process probe reproduced the default environment omitting the synthetic bearer and verified that the explicit corrected environment delivers that bearer, while unrelated synthetic secrets remain absent in both cases. This involved no database, network, user credential or model. Probe output is `proxy-sdk-environment-probe.json`.

## Minimal correction

`test/helpers/client-proxy-options.mjs` constructs the fixture transport options and accepts an optional explicit synthetic bearer. The default stdio fixture gets an empty explicit environment. The authenticated HTTP fixture passes exactly `ULTRABRAIN_KIT_FIXTURE`; the helper never spreads process.env, puts the bearer in arguments, or changes production environment filtering. Invalid supplied fixture credentials fail without echoing their value. The existing SDK safe-default environment behavior remains intact.

`test/client-kit-integration.mjs` uses that helper and explicitly supplies the temporary credential only for the new HTTP-proxy call. All catalogue, count, owner isolation and readonly assertions from a970 remain. Nine new local unit checks cover exact options, explicit environment, malformed values, copy isolation and a real Node child process.

Local full Node regression:2312/2312, exit0, no failures/skips/cancellations. The pinned-SDK environment probe and9 new unit checks pass. The earlier54-file portable suite1753 and683 Python tests remain historical evidence on unchanged production/Python code, not a new run claim. New final-SHA CI is required before accepting this correction; no deployment/merge or independent approval is claimed here.
