# Candidate evidence checker — 2026-09-26

Base: ddc75d0e5688289fe1722e616f8503269b293a4d, tree37458e3bf1e31dcc6b2118fedaa06731fe89b106. The supplied bundle restores the exact tracked tree, including four upstream gitlinks; its local history is reconstructed, not remote ancestry. Publication must use the real remote parent, not force-push this local history. Main and earlier PR heads are unchanged.

## Complete implementation

Standalone Node CLI, constrained GitHub GET collector, pure evaluator, structured formal-review receipt checker, fixed nine-workflow policy, paginated current-attempt jobs/reviews and collection reobservation. The default has no trusted reviewers. Formal approval must be by a configured non-PR-author on the exact head and bound base, with session, scope, findings and executed-test attestation. GitHub comments, emoji, draft requests, quotas, old approvals and green CI cannot create approval. merge_authorized is always false. This checker assists, not replaces, repository acceptance.

No runtime memory interface, applied migration, upstream lock, client package, n8n integration or user service changed. The fixed API token is only sent in the Authorization header to api.github.com using GET without redirects, retries, logs or downloads. The diagnostic workflow has only read permissions. Receipt test commands are data and never executed. Caller-supplied transports/evidence do not authenticate their own origin. The candidate tree comes from Git metadata, not a runner checkout attestation. Base/stack acceptance, branch protections, actual reviewer independence/session/test execution and deployment remain human-verification boundaries.

## Separate implementation-assistant review

No second reviewer agent executed these tests. Initial115-minus-four-review-tests suite111/111 passed. A separate adversarial pass found three issues (3/3 expected failing probes): only choosing max run ID could hide a newly failed rerun of an older run; the head/base checks could use different PR association entries; cancellation after collection but before CLI stdout could still emit success. Fixes inspect every relevant current-base run/attempt, bind both SHAs in the same association, and recheck cancellation before output.

A further chronology probe found that numeric review IDs were used as submission order. Pending reviews acquire IDs before submission. A lower-ID review submitted later must supersede an earlier approval. The second red run was4tests/3pass/1fail; sort decisive reviews by validated submitted_at with ID as tie breaker. Raw failures from both runs are retained as deterministic gzip. Four assertions are regression examples, not four claims of remotely exploitable vulnerabilities.

Other checks cover full pagination and duplicate IDs, capped HTTP bodies, rate/permission refusal, no URL following, SHA/repository/PR binding, reviewer allowlists and author exclusion, request_changes/dismissal, current-attempt jobs, snapshot changes, strict receipt shape/duplicate keys, credential/error non-disclosure, frozen request selection and actual CLI subprocess behavior. No remaining blocking implementation issue was identified by the implementer. This is not proof of zero defects or independent approval.

## Executed locally

Ordinary Linux uid1000, Node22.16.0: final full Node2810/2810, no failed/skipped/cancelled tests, exit0. New115 tests are included. Earlier full2809/2809 is before the additional chronology regression and fix, not final evidence. The original command launcher returned a tool transport timeout while its detached test continued; the separately captured process exit and full TAP establish completion, not the launcher status. New YAML parses. Actual Node CLI --help is exercised; native fetch request/stream and collector response fixtures are explicitly synthetic.

An actual online CLI attempt failed with candidate_http_failed; an independent hostname resolution probe for api.github.com exited2. Do not count this as live integration. New candidate-evidence CI invokes the fixed baseline PR29 with read-only GitHub credentials, tests the actual online collector, and requires missing-reviewer configuration to stay blocked. Its completion must be read from the final SHA CI rather than inferred. No local full Python, PostgreSQL, Windows, user services or model run was performed.

## Release gate

Independent-agent review NOT APPROVED; keep a separate draft PR. A self-review, new directory, test process, valid JSON attestation or green workflow does not create an actual independent reviewer. A genuine reviewer must inspect this complete final SHA and record real session, findings, tests and verdict. Old-stage bot quota failures are not a new-stage approval. Final full tree, patch replay and remote CI observations are recorded in the handoff report. No merge or user deployment.
