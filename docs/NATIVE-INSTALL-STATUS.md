# Native installation checkpoint — 1 November 2026

The public adapter still reports `installSupported:false`. The latest runtime
check exercised two prepared cancellations in an isolated Vortex application.
It did not install a mod or update the user's installed Vortex.

## Verified result

The Promise/Zone repair and journal ancestor-identity repair are on `main`
through PRs #131 and #132. The maintained graph contains 132 patches over 26
original Vortex 2.9.1 files.

The isolated fixture passed fresh Main and Renderer typechecks and builds.
Inspection matched 26 selected Program inputs, 24 source-map entries and 19
separately pinned fixture overlays. Three output files changed; the other ten
retained their prior hashes, including Preload and the Renderer source map.

One application session then completed both preparation → cancellation → handoff
cycles. Its ten events and joined source captures identify the same frame,
manager, Renderer generation and journal root. Source captures and six journal
records agree with both operations;
each cancellation has two child-terminal observations and six closed SDK pipes.
Neither requested START or acquired an extraction destination. Staging retained
only its existing Vortex tag. A separate read-only audit checked those joins.

Main exited normally with code zero. The owned process group was empty and both
output pipes reached EOF and closed without errors or overflow. This run needed
no close recovery and reported no unknown outcome. Six earlier UNKNOWN operation
tuples remain reserved and unchanged.

Local evidence is retained under `local-state/native-inert-cancel/`:

| Evidence | SHA-256 |
| --- | --- |
| `prep/post-promise-two-cancel-build/BUILD-INSPECTION.json` | `591602126fbafbbc8a33216bdeb7ea6b7fcd3f0597eb9ea7604230b9fbeac074` |
| `root/app-fixture/launch-post-promise-two-cancel/SUPERVISOR-RESULT.json` | `3a03c08d08b45f8704edcef699db9551c39279de54bc01a710e11e91d7194b88` |
| `prep/post-promise-native-result-review/REPORT.md` | `5eea58b7b733567495c7fd7d2001ce8f95d8a5b5e5bcc726e0273b9b4142a625` |
| `root/post-promise-postexit-observer/POSTRUN-CENSUS.json` | `1e17a41ed666d792ca1e8b0edf008741c90dd1689e8e090795ab5a2e19f0710e` |

These ignored local receipts are not included in a fresh clone. Their hashes
identify this checkpoint, not a portable installation permit. The collector's
generic `INSTALLED.json` filename is not evidence of a mod installation.

## Resume here

1. Finish the independent postexit proof in
   `recovery/post-promise-two-cancel-postexit/`. The draft is frozen at PINS
   `d28977def1a1c12379352c6c84dfaef6541b2d7bbbe56e553b53acf606a9ca28`;
   review its `README-PAUSED.md` and latest files before running any helper.
   Recheck the closed process and
   current file census, then read selected values through a verified physical
   database copy. The original database must not be opened by a native inspector.
2. Reconstruct A → B1 → C1 → B2 → C2 from the actual journal and source captures,
   including effective runtime request digests, both v3 terminal records and
   the persisted final anchor. Confirm the preserved settings, profile, downloads
   and absence of installed mod records. This final KV/anchor check has not run.
3. After that gate passes, qualify full installation and successful-operation
   handoff in the isolated host. Preserve the existing C2 history and earlier
   UNKNOWN tuples; do not reset the database or journal to simplify admission.
4. Enable a supported public MCP installation route only after those gates,
   then perform the separate installed-host qualification and release work.

The two new operation IDs are spent. Do not rerun their caller or launcher, or
reuse admission scripts that expect the pre-run empty journal and old database
census. The full goal remains incomplete; no new release was made at this checkpoint.
