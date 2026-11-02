# Native installation checkpoint — 2 November 2026

The public adapter still reports `installSupported:false`. Two synthetic
installations and their successor handoffs completed in the isolated Vortex
application. Independent checks verified their stored records, staged payloads
and Windows file identities. The user's installed Vortex was not changed.

## Two-install result

The supervisor retained `failed-closed` with reason
`RUNTIME_FIXED17_UNCHANGED`. Its final runtime check omitted four expected SDK
outputs: one `CopyProof.json` and one extracted payload for each operation.
The SDK retains these files after releasing its workers. The failed receipt
has not been rewritten, and neither installation was replayed.

Main exited with code zero, its owned process group was empty and both output
pipes reached EOF and closed without errors or overflow. There was no UNKNOWN,
recovery close or force cleanup. The source collector recorded both
prepare → execute → handoff cycles in twelve events.

A separate forensic reader copied the eight closed database files and opened
only that verified copy in READ_ONLY mode. It checked 36 selected values,
including both installed records and download associations, and reconstructed
C2 → B3 → C3 → B4 → C4 from the twelve journal files and actual source captures.
The stored anchor matched C4. The original database census was identical before
and after the read; no native inspector opened the original database.

The runtime contains exactly 33 files: 17 unchanged SDK/capsule inputs, twelve
journal files and four capture-bound SDK work products. Both staged payloads
match the expected archive members. Profile mod-state entries for either fixture
target remain absent; automation stays disabled and the fixture game files remain
unchanged. The six earlier UNKNOWN tuples and two prepared-cancellation records are preserved.

A separate observer used `GetFileInformationByHandleEx(FileIdInfo)` to compare
five full Windows identities: staging, both mod directories and both payload
files. All matched the copy proofs. It rechecked payload bytes while holding
the native handles and closed every handle before reporting success. These
checks do not equate Node/Python stat projections with Windows FileIdInfo.

This establishes the observed installation data and physical closure for these
two synthetic packages. It does not turn the failed supervisor result into a
passed run, enable a public installation API, qualify the user's installed host
or prove crash durability or gameplay behavior. The reader and observer each
retain `fullInstallationAccepted:false`.

The corrected runtime guard subsequently checked the same retained 33 files.
It required exact directory membership and ordinary single-link files across
all 33 leaves, rather than ignoring the SDK work directory. Eight explicit
FileIdInfo queries checked the four work products before and after reading their
held descriptors. Database, staging and fixture game bytes stayed unchanged.
The validator did not execute Vortex or its SDK, open the original database,
rewrite the failed receipt or replay either installation.

The exact guard is retained as
[`tests/fixtures/native-runtime-work-products.py`](../tests/fixtures/native-runtime-work-products.py).
Its [18 portable tests](../tests/test_native_runtime_work_products.py) exercise
the actual function bodies with filesystem and Windows API facades, including
the old guard accepting hardlinks and the corrected guard rejecting them.
Full-module loading is inert and needs no Windows imports. These modeled tests
are separate from the eight actual native observations above.

Local evidence under `local-state/native-inert-cancel/`:

| Evidence | SHA-256 |
| --- | --- |
| `prep/full-install-build-draft/BUILD-INSPECTION.json` | `0afbac384f271acc3953e8a5c1482f75957a88596ec8a95704c487a647bd622c` |
| `root/app-fixture/launch-full-install-execution/SUPERVISOR-RESULT.json` | `5f7ca1bf8d2aa6e5871ca83d8604eaf70798c26749642f3dfc8703b62b841d45` |
| `recovery/full-install-failed-postexit-draft/RESULT.json` | `b6afc1153cf745e04280ec51e9881e1319c7430f5a24f712b7178bbbb6680026` |
| `recovery/full-install-failed-postexit-draft/SOURCE-BEFORE.json` and `SOURCE-AFTER.json` | `28b0c0d7d15ea4c57bb0f1ffdaac6fe1c107c99d2d585bd1f5a7ad8a02535971` |
| `prep/full-install-forensic-result-review/AUDIT.json` | `e552f07005e92c225bebb9c99c18000c1a93b83b6f64ee2f4f6c4ea7d66e94ce` |
| `recovery/full-install-failed-native-id-draft/RESULT.json` | `e486729ceb41aa6158cdca422b224a629493f4161f4413b4e893ed49d88afb3c` |
| `prep/full-install-forensic-result-review/NATIVE-FIVE-AUDIT.json` | `ab8764f3a110876af29a10953dde3d575020951f3ed0bc82abfd8944baf90ec1` |
| `bridge/full-install-work-current-validator/RESULT.json` | `7f0d6d9865effae83367d9053db35789688616949a730da3682c23a9e9d26262` |
| `prep/current-runtime-validator-result-review/REVISION2-PINS.json` | `970d076b88ade4d572cdb215f8617ac81bee6d6e138ebf379a14c610d7bd2acf` |

These ignored local artifacts are not part of a fresh clone or a portable
installation permit. Model tests passed for the reader, execution evidence,
failed-source gates and native-observer controls. The database-copy and native
identity results above come from the separate actual executions.

## Prepared-cancellation checkpoint (earlier run)

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

1. Add the production source-owned intake, durable public-request-to-operation
   mapping and real tracked-archive identity producer. The isolated fixture's
   fixed descriptors and private capture hooks cannot serve as those producers.
2. Qualify the production build and supported public MCP path, preserving the
   combined execution, database, payload and native-identity checks. Keep the
   original failed receipt and spent operation history.
3. Perform separate installed-host qualification and release work before
   advertising installation support. Keep profile flags, deployment owners and
   game files protected.

Both installation requests are spent, as are the earlier cancellation requests.
Do not replay their callers or launchers, reset their journals, delete their
intents or reinstall the fixture targets to obtain a green result. The original
reader, verified copy and native observation are retained evidence. Any later
operation needs its own reviewed admission and must preserve this history.

The full goal remains incomplete. No new release or installed-host update was
made at this checkpoint.
