# Cancel a prepared executor operation

The source executor can cancel a healthy prepared operation before extraction
starts. It closes its existing workers, records cancellation and releases its
Main and Renderer reservations. The installed adapter still reports
`installSupported:false`; these internal methods are not public MCP commands.

The current graph has 132 patches over 26 Vortex 2.9.1 files. Source
composition, combined cancellation tests and full application compilation have
passed. Installed-host acceptance remains unfinished.

For the isolated runtime result and the remaining postexit checks, see the
[installation checkpoint](NATIVE-INSTALL-STATUS.md).

## Protocol

`ExtensionManager.cancelNativeExecutorPrepared()` takes no arguments. Its fixed
preload route sends the retained `transportId` on `persist:native-executor-cancel`.
Main creates a separate `cancellationId` and challenge sequence. No owner, path,
callback, receipt or reset flag comes from the caller.

| Round | Required action |
| --- | --- |
| 1 `prepare-inert-release` | Renderer reserves its actual release ticket; Main cancels and joins the relay and Python worker. |
| 2 `check-inert-after-close` | Renderer rechecks its absent target; Main appends the cancellation record and commits/readbacks anchor C. |
| 3 `check-inert-before-main-release` | Renderer checks again; Main verifies C and releases its unregistered persistence reservations. |
| 4 `finalize-inert-release` | Renderer validates Main's acknowledgement, unsubscribes while held, rechecks and synchronously releases its own reservations. |
| 5 `hold` | Negative notification only. It cannot release, reset or retry anything. |

An operation that attempted START, COPY, registration, adoption or cancellation
cannot enter this branch again. Profile/game changes, including a change back to
the original profile, stop progress. Unknown results remain held. Closed message
validators reject extra fields, accessors, proxies and non-native Promise replies.

## Worker and journal evidence

`observeRelayInertCancellation(owner)` recognizes its own relay through a private
WeakMap. It requires no explicit START attempt, no Python START or acquired output
directory, successful cancellation/release and both child exits with all six pipes
closed. Caller status JSON cannot replace this observation. Preparation may open
custody parents; this is not a claim that preparation performs no filesystem work.

Terminal evidence v3 records `prepared_no_start_cancelled_worker_closed`. It has
no installed-record, registration or adoption fields. The six-method journal
factory ABI is unchanged. Its branded anchored writer verifies pending census B,
unchanged prior records and the complete successor census C. Main performs the
owned anchor compare-and-swap, exact readback and fresh C checks before release.
These are point observations, not a filesystem lease or power-loss guarantee.

Main uses unregistered release capabilities; Renderer uses its reserved absent
target and READY flush owner. Both finish all callback-capable checks before
opening their nested writers. Buffered unrelated changes survive. Cancellation
creates no mod record or download `installed` association. Retained finalizers
from earlier operations cannot invalidate the next operation.

## Failure and the next operation

Main and Renderer release are distinct facts. Failure after Main release leaves
that release recorded while Renderer stays held; it cannot undo the commit or
reacquire the old Main reservations.

A Renderer observer can reject on a fixed HOLD notification before the original
Main invoke error arrives. Main and IPC retain their original failure. If the
final invoke reply is lost after local finalization, the result remains unknown
and another operation is refused. A deadline does not stop the underlying work.

Known completed cancellation uses
`handoffNativeExecutorCancellationSuccessor()`. Its separate acknowledgement can
be read again after a lost handoff reply, under the original frame, epoch and
persistor identity. This repeats no cancellation, journal update or release.
Startup C, consumed IDs and the same captured SDK remain. The next operation
receives new reservations and must pass admission independently. Compact history
is capped at 4096 entries without eviction; uncertain attempts are never removed
to make space.

## Verification scope

Combined tests exercise actual Main, Renderer, Preload and IPC source, including
two distinct cancellations in one lifetime, retained records, lost handoff
acknowledgements, profile changes, lost COMMIT replies and split release. SQL,
Electron delivery and process facts in those tests are explicit facades. Separate
[physical capsule tests](NATIVE-SDK-CAPSULE.md) cover real Node/Python closure on
synthetic ZIPs. Neither proves this complete flow in an installed Vortex host.

The separate application qualification passed all four project typechecks and
builds, plus 52 upstream Main tests without skips. Inspection matched 25 selected
TypeScript Program sources, 23 runtime-map entries and all six rebuilt bundle/map
outputs. Configs and lockfile were unchanged; the new captured SDK changed only
the journal and relay sources. The earlier SDK clone and capsule remain preserved.
No application was launched during qualification.
