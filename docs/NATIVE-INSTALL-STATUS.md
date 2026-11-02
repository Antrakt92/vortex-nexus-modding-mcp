# Native installation checkpoint — 2 November 2026

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

A separate postexit reader then verified a byte-for-byte physical copy of the
closed fixture database. It checked 20 selected profile/settings/download values,
the instance identity, the disabled automation-start default and the persisted
final anchor. The original database was never opened by a native inspector;
its complete file census was identical before and after the read.

The reader reconstructed A → B1 → C1 → B2 → C2 from both effective runtime
requests, the source captures and all six journal records. The persisted anchor
matched C2. Both operations were closed with no unresolved current journal row;
the six older UNKNOWN tuples remain reserved in their separate history ledger.
No installed mod record, fixture-profile mod-state entry or download-installed
link was present, and staging still contained only the existing tag. These checks qualify
the isolated prepared-cancellation flow, not installation or crash durability.

Local evidence is retained under `local-state/native-inert-cancel/`:

| Evidence | SHA-256 |
| --- | --- |
| `prep/post-promise-two-cancel-build/BUILD-INSPECTION.json` | `591602126fbafbbc8a33216bdeb7ea6b7fcd3f0597eb9ea7604230b9fbeac074` |
| `root/app-fixture/launch-post-promise-two-cancel/SUPERVISOR-RESULT.json` | `3a03c08d08b45f8704edcef699db9551c39279de54bc01a710e11e91d7194b88` |
| `prep/post-promise-native-result-review/REPORT.md` | `5eea58b7b733567495c7fd7d2001ce8f95d8a5b5e5bcc726e0273b9b4142a625` |
| `root/post-promise-postexit-observer/POSTRUN-CENSUS.json` | `1e17a41ed666d792ca1e8b0edf008741c90dd1689e8e090795ab5a2e19f0710e` |
| `recovery/post-promise-two-cancel-postexit/RESULT.json` | `3a8369ed168393d309ae0706a71975a8f52ceada8213d6a320410095c092963a` |
| `recovery/post-promise-two-cancel-postexit/SOURCE-BEFORE.json` and `SOURCE-AFTER.json` | `1a478e80d6366d65a86b8d892682ed31112f7ac045be7996d382d3179dbe9451` |
| `prep/post-promise-postexit-result-review/AUDIT.json` | `de6a65be016ed7951fb555d64453e6a1bd0d44c72734a6c74704930a02145a98` |

These ignored local receipts are not included in a fresh clone. Their hashes
identify this checkpoint, not a portable installation permit. The collector's
generic `INSTALLED.json` filename is not evidence of a mod installation.

## Next gates

1. Qualify full installation and successful-operation handoff in the isolated
   host. Before any START, add a narrowly scoped source capture of the actual
   copy, registration, adoption and closed-worker observations. The existing
   cancellation capture cannot prove those installation phases.
2. Run the two synthetic installs only after fresh no-replacement admission,
   source/build checks and root approvals. Preserve the existing C2 history and
   earlier UNKNOWN tuples; do not reset the database or journal to simplify admission.
3. Verify staged payloads, installed records, download associations, terminal
   records and the final persisted anchor independently after process closure.
   Keep all profile flags and game/deployed files unchanged.
4. Enable a supported public MCP installation route only after those gates,
   then perform the separate installed-host qualification and release work.

The postexit packet and its reader are spent evidence, not commands to rerun.
Retain its original read intent, verified copy and results. A new installation
attempt needs new reviewed operation identifiers and admission, preserving all
prior history.

The two new operation IDs are spent. Do not rerun their caller or launcher, or
reuse admission scripts that expect the pre-run empty journal and old database
census. The full goal remains incomplete; no new release was made at this checkpoint.
