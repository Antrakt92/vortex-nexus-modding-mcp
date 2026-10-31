# Background owned-ZIP worker

`owned-zip-worker-client.mjs` runs one fixed Python guardian. That process
acquires the archive lease, drives the [ZIP decoder](OWNED-ZIP-EXTRACTOR.md)
locally and retains its handles across extraction and copying. Reading status
does not advance the decoder.

The original factory writes its own scratch directories. A separate staging
factory can prepare the plan's existing parent and publish one new destination;
it has been exercised only in own synthetic staging fixtures. Neither factory
registers a Vortex mod, imports a tracked archive, enables or deploys anything.
The public MCP installation operation remains disabled. Managed use still needs
the source-bound coordinator and durable startup/discovery gate.

## Fixed scope and runtime

The first accepted runtime is standalone Windows x64 Node 24.20.0 and the reviewed
`C:/Python314/python.exe` build of Python 3.14.8. Executable/core hashes are pinned.
Its zlib is built into `python314.dll`, version `1.3.1.zlib-ng`; no separate zlib
extension is claimed. Electron is not accepted by this coordinator. A runtime
change needs new admission and qualification.

Python starts with fixed `-I -S -B` arguments and only the required SystemRoot
environment entry. There are no executable, script, argv, callback or backend
options. The guardian seals the three fixed Python sources and its runtime files
read-only before its ready response. Those seals remain until release or process
death. This is not an attestation of every Python/Windows library.
The coordinator hashes admitted files through one open descriptor in 64 KiB
chunks, reads at most the admitted size plus one byte and rejects changed file
generations. A size check does not authorize an unbounded whole-file read.

The separate archive binding requires explicit `win-file-id128/1` parent/file
identities. Node `dev:ino` context labels must not be converted into that domain.
The original factory's output paths derive from the maintained source checkout:
`local-state/owned-zip-worker-work/<operationId>/Extract` and `Final`.
The coordinator checks the scratch ancestry without creating directories. The
guardian opens or exclusively creates the fixed parent directories relative to
retained native handles, refusing reparse points even after coordinator preflight.
The operation directory and outputs are created exclusively. Embedded game and
staging paths do not authorize writes there. A real staging target still needs
native admission, shared exclusion and registration.

The staging factory keeps `Extract` and its proof file in the same owned work
directory, but derives the final parent/leaf exclusively from
`plan.context.stagingPath` and `plan.package.expectedModId`. It does not accept a
second caller-selected output path. Plan fields remain data, not native authority.

## Prepared staging parent

`createOwnedStagingZipWorker(requestBytes, archiveBindingBytes)` uses the existing
SDK lifecycle and permanent journal. It rejects the intersection of IDs unsupported
by native v2 registration before spawning; case variants of reserved download
IDs also refuse. This early check does not replace parsing the complete native
registration request in the future coordinator.

After ready, the SDK checks the plan's Node filesystem identity, then sends one
read-only destination preparation request. Python walks and retains the native
parent chain and returns its `win-file-id128/1` observation. The SDK checks the
Node identity again while that chain remains held. These are separately bound
identity domains; neither is cast into the other.

The version-2 START packet includes the exact returned destination tuple. Its
digest is reserved by the existing executor journal before START delivery.
Python checks it against its retained token and parent handle. Handoff creates
the new leaf relative to that handle without reopening the parent path. Existing
targets, including case aliases, refuse without merging or overwriting files.

After successful copying, the guardian creates `CopyProof.json` exclusively
through its held operation-directory handle. The bounded proof binds worker,
request and packet identities, native destination directory identity and every
verified source/destination file identity, byte count and SHA-256. The SDK reads
at most the admitted four-MiB limit, verifies exact bytes/hash, schema, ancestry
and the complete expected payload before accepting `copied`. Status exposes only
the compact proof metadata; `copyProof()` returns a detached full snapshot while
the copied worker still has live custody. Cancellation, release, errors or actual
child exit invalidate this live accessor, even before the last pipe closes.

The destination becomes visible before copying completes. This is not atomic
directory publication. Restart-before-discovery reconciliation remains required
before this component can operate on managed Vortex staging. EOF and partial
failure do not delete, retry or register that directory.

## Intent and job reservation

`createNativeExecutorJournal({root})` reuses the immutable operation intent, then
reserves `jobs/<nativeJobId>/binding.json`. The default root is
`<runtime>/local-state/vortex-agent-build/native-install-executor`.

The reservation binds the original request digest, operation/job IDs, actual
worker lifetime nonce and exact start-packet digest. Duplicates refuse; a failed
second reservation does not delete the first intent. Fresh reads require
independently retained request/job/packet bindings and check ancestor identities
again after record discovery and final reads.

`reserved`, `intent_only`, `reservation_only` and `not_observed` are observations.
Every result retains unknown dispatch state, reconciliation required, no replay,
no effects permit and unverified power-loss persistence. Missing records do not
prove that nothing happened. Never erase or reroot the ledger to retry. This is
not the native manager's consumed-ID registry or global UI-install lock.
File flush/readback and process-exit tests do not prove power-loss survival.

## Coordinator lifecycle

`createOwnedZipWorker(requestBytes, archiveBindingBytes)` is inert. Its `start()`
admits the runtime/sources, checks the private child's nonce/PID/creation time,
publishes both journal bindings, then attempts exactly one start-packet write.
Only one worker may occupy a coordinator module at a time.

| Method | Behavior |
| --- | --- |
| `status()` | Copies cached bound observations without I/O |
| `waitFor(phase, timeoutMs)` | Waits passively; timeout preserves ownership and never restarts or kills work |
| `cancel()` | Reserves cancellation before delivery; stops future steps and retains partial output |
| `handoff()` | Once only, in the same Python process; copies the frozen payload through original handles to Final or the prepared staging destination |
| `release()` | After completed work or acknowledged cancellation, closes borrower, ZIP owner, parent and runtime guard, then observes child/stdio closure |
| `inspectIntent()` | Reads original journal bindings without resuming work |
| `copyProof()` | Staging factory only: returns the checked full manifest while copied custody remains live; no additional pipe command or filesystem effects |
| `retireInert()` | Explicit retirement of that exact retained child only before a start-packet write attempt; refuses active/uncertain work |

NDJSON frames have fixed schemas and size limits. The coordinator permits one
pipe write in flight and at most three queued controls. Cancellation supersedes
an unsent handoff. The guardian's input queue holds at most eight commands; its
latest-status slot prevents a blocked status writer from blocking the pump.
Status sequences may have gaps.

For an operational error, acknowledge cancellation before release. The original
failure remains visible. Releasing during a pending handoff refuses immediately;
historical extraction success cannot authorize closing active copy work.

Decoder pumping uses bounded chunks. Archive admission and each existing
`OwnedFileTransfer.transfer()` call remain synchronous inside the guardian.
Handoff cancellation is observed between files, not necessarily between 64 KiB
writes. Chunk sizes are not a wall-clock deadline or throughput claim.

## Disconnect and failure

Losing a status consumer does not dispose the coordinator or guardian. Controller
pipe EOF is different: it stops further work and holds custody without automatic
release or exit. A severed pipe cannot be repaired by launching another worker or
reopening paths. Controller reconnection/recovery is not implemented here.

Guardian death can release HANDLEs. Cached completion fields cannot reconstruct
custody. The coordinator records `CUSTODY_LOST`, refuses handoff and preserves
the no-replay journal. Tests deliberately retire their own quiescent held process;
this is not an automatic active-worker termination or recovery API. Survival of
a coordinator/OS job/boot is not established by the EOF test.

`workerTerminal` separately observes the actual Python child and its three exact
pipes through `child-terminal-observer.cjs`. The historical `childClosed` event
alone cannot resolve `waitFor('closed')`; all owned pipe close facts must also be
observed. A successful release additionally requires normal process exit.
Neither observation establishes descendant termination or power-loss durability.

Terminal history and bounded startup census are documented in
[Executor terminal history](NATIVE-EXECUTOR-TERMINAL.md). The SDK still reserves
one intent/job pair; only the future actual coordinator may append completion
after registration, adoption, physical closure and release have all succeeded.

The SDK also provides `prepare(mainAnchorBytes)` and `startPrepared()` for the
explicit pre-START boundary. Preparation retains the exact packet and native
parent, reserves the journal once through `reservePending`, and returns a compact
receipt. It does not send START or create an output directory. The application
must acknowledge the new main anchor before invoking `startPrepared()` on that
same owner. Journal history, sources and the actual Python process are checked
again before the one-shot START attempt. The legacy SDK `.start()` remains an
own-fixture compatibility composition; managed integration must use the explicit
[relay boundary](OWNED-ZIP-RELAY.md).

Cancellation before `startPrepared()` begins may abort the known-inert Python
child and join its actual process/pipes. Its journal reservation remains unresolved and
cannot be replayed. Once START has been attempted, even an unknown response
forbids the inert-abort and retirement routes.

## Local qualification

```powershell
node --test tools/modding/vortex-agent/native-executor-journal.test.mjs
$env:VORTEX_OWNED_ZIP_WORKER_TEST = '1'
node --test tools/modding/vortex-agent/owned-zip-worker-client.test.mjs
```

The suites use own archives and scratch. They exercise autonomous extraction,
same-handle copy, explicit release, cancellation under START backpressure,
observer timeout, EOF custody, guardian loss, competing reservations, partial
records, source growth and ancestor replacement before and after preflight. They
are not live Vortex or performance tests.
