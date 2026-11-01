# Internal executor completion

The prepared Vortex 2.9.1 source now connects a retained prepared operation to
seven internal execution stages. It is part of the
[103-patch/25-source assembly](NATIVE-SOURCE-ASSEMBLY.md), following
[pending preparation](NATIVE-EXECUTOR-TRANSPORT.md) and the
[copy/registration/adoption primitives](NATIVE-EXECUTOR-CONTINUATION.md).
There is no public MCP installation tool or installed-host acceptance claim.

## Source-owned execution order

`ExtensionManager.executeNativeExecutor()` takes no caller inputs. It uses the
exact retained prepared transport, whose pending reservation and Main anchor
acknowledgement already precede Python START. The fixed Main invoke is
`persist:native-executor-execute(transportId)`. Main captures the original
webContents/frame, claims one execution before callbacks and generates a separate
execution ID and nonce/sequence domain from preparation.

| Challenge | Required action before the next stage |
| --- | --- |
| 1 `check-preparation-before-start` | Fresh actual Renderer admission checks; then Main starts the prepared worker, copies and validates its full live copy proof |
| 2 `check-preparation-after-copy` | Fresh Renderer checks; then actual Main tracked registration commits and reads back the record and archive association |
| 3 `adopt` | Renderer adopts the actual canonical observed/2 record and download installed fields, retaining its genuine release ticket |
| 4 `check-adoption-before-close` | Fresh committed/adoption checks; then Main joins worker closure and actual resource-terminal observations |
| 5 `check-adoption-after-close` | Fresh Renderer checks; then Main seals the v2 terminal census and CAS/readbacks its successor anchor |
| 6 `check-adoption-before-release` | Fresh Renderer checks; then Main synchronously releases its retained writer ownership |
| 7 `finalize` | Renderer validates the genuine Main release receipt and synchronously finalizes its retained release ticket |

Failure-only challenge 8 is `hold`. The seven-stage result is emitted only after
both known releases. The 120-second monotonic observation deadline does not cancel
underlying work, grant a lease or authorize retry.

The fixed Preload methods are `executeNativeExecutor`,
`onExecutorExecutionChallenge` and `invalidateNativeExecutorExecution`.
Challenges, responses and negative notifications use separate closed schemas;
no opaque owner, callback, executable, arbitrary path or generic dispatch crosses
IPC. A source-owned invalidation listener reports profile/game ABA during COPY
or SQL without waiting for the next challenge. It can only deny progress.
Original-frame checks exclude sibling-frame responses and invokes.

## Retained ownership and finalization

Main keeps its actual prepared ticket, committed observation, closed process
status, terminal transition, successor anchor and release receipt privately.
After worker closure it uses captured historical proof and closed facts, rather
than requesting a live proof from a dead owner. A genuine Main release receipt
contains the operation/job/request and base/full-record hashes, `released:true`
and `consumedIDsRetained:true`; its durable-consumption and permission flags
remain false.

Renderer captures release method identities at initial admission. Its synchronous
`finalizeNativeExecutorTransportAdoption(id, releaseBytes)` claims once, validates
the exact canonical twelve-field Main receipt, unsubscribes its actual context
listener while gates remain closed, and rechecks state/context and descriptors.
The captured manager finalizer arms and finishes in the same turn; no armed
finalizer crosses an await. It then stamps private completion without checking
owners whose gates have already cleared. Buffered unrelated changes resume
without echoing the adopted database writes.

Main release and Renderer finalization are distinct facts. A changed context,
unsubscribe failure or method drift after Main release leaves **Main released /
Renderer held**. The source retains the known Main receipt; it does not claim to
roll back the commit or re-lock released writers. Unknown commit, closure,
terminal-CAS or ACK outcomes retain evidence and fail closed without replay.

## Journal terminal transition

The journal factory remains exactly the frozen six-method API:
`begin`, `read`, `appendTerminal`, `inventory`, `reservePending`, `provision`.
The new module export
`appendNativeExecutorTerminalAnchored(journal, binding, evidenceBytes, expectedAnchorBytes)`
accepts only an actual journal branded by that module instance. It uses a private
writer path; the public writer methods cannot supply its private token. Writer
activity/reentry is checked before callbacks and cannot coexist with the
anchored transition.

The complete sealed predecessor census B must match the independently retained
Main anchor and contain exactly one unresolved operation matching all five
binding fields: operation ID, native job ID, request SHA, packet SHA and worker
lifetime. Other operations must be historical closed. Only the target terminal
is published. The successor C must retain the root and exact index union/count,
all previous intent/job and other-terminal raw digests, and the target terminal's
exact bytes published by this writer. No unresolved operation may remain.

The returned frozen `native-executor-terminal-transition/1` has ten fields:
`schema`, `rootId`, `previousInventorySHA256`, `inventorySHA256`, `operationId`,
`nativeJobId`, `requestSHA256`, `packetSHA256`, `workerLifetime`, `evidenceSHA256`.
Main checks the tuple/evidence and C inventory, performs the genuine owned B→C
anchor CAS and exact readback, then checks inventory/source closure before release.
This is a point observation, not an atomic filesystem lease or power-loss proof.

[V1 terminal evidence and its historical meaning remain unchanged](NATIVE-EXECUTOR-TERMINAL.md).
V2 `committed_adopted_worker_closed` records completed work while volatile writer
holds remain; it does not assert release. The disk helper alone authenticates
neither the Renderer nor process completion and grants no permission.

## Lifetime and evidence boundary

The closed execution result records both releases but keeps `effectsAllowed`,
`installationPermit`, `nativeAdmission`, `trackedInstallComplete` and
`powerLossPersistenceVerified` false. Successful lower-level release does not
reset the transport, frame, pending or genesis operation slots. Consumed operation,
job and request bindings remain retained. A verified next-operation handoff is a
separate implementation gate; uncertain history is never cleared to admit it.

Graph103 passed fresh Shared/Main/Preload/Renderer TypeScript targets and builds,
52 upstream Main tests without skips, all 25 selected Program sources and 23
runtime maps. The two Shared type sources are Program-only. All six runtime
outputs were rebuilt with eight configs and the lock unchanged; Electron stayed
cold. A new fifteen-file SDK clone changed only the journal and emitted all
fifteen pins, preserving the earlier clone. Qualification receipt:
`local-state/native-completion/recovery/qualification103/QUALIFICATION.json`,
SHA-256 `9b172e396f568d201458ec37f2c5a24a18b0ae1bbcec789b8f3ba1463e6b14f9`.

The final nine-suite completion/journal/graph matrix passed 166 tests without
skips. A separate 31-suite affected-source matrix passed 434 tests without skips;
these suites overlap and are not summed as unique coverage. The 52 upstream Main
tests are a separate qualification check. The composed tests exercise
actual source actors, including fixed Preload
sanitization and all seven stages, with explicit Electron delivery, transactional
SQL and physical relay/process facades. They check buffered-write resumption,
profile invalidation during COPY, lost terminal-anchor COMMIT reply, split
release and sibling-frame isolation. These checks do not launch Vortex or prove
installed loading, a physical seven-stage installation, native ABI compatibility,
power-loss durability or repeat-operation recovery.
