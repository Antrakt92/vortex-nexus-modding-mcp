# Executor terminal history and startup inventory

`native-executor-journal.mjs` extends its existing permanent operation/job
reservations with immutable terminal history and a bounded, read-only inventory.
It does not implement an installer, recovery executor, discovery permission or a
source coordinator. The existing `begin` and `read` result shapes remain unchanged.
Neither consumed index is deleted or refunded after a terminal is recorded.

## Internal API

```js
const journal = createNativeExecutorJournal({root});
journal.appendTerminal(originalBinding, canonicalEvidenceBytes);
journal.inventory();
journal.inventory({expectedRootId});
journal.inventory({expectedRootId, expectedInventorySHA256});
```

`originalBinding` has exactly five own data fields: `operationId`, `nativeJobId`,
`requestSHA256`, `packetSHA256` and `workerLifetime`. Each must match the original
intent/job reservation. Accessors and proxies are refused. No caller-supplied
path, SQL or callback is accepted.

Evidence is compact canonical UTF-8 JSON with these exact keys and order:

```json
{
  "schema": "native-executor-terminal-evidence/1",
  "outcome": "committed_adopted_closed",
  "fullRecordSHA256": "64-lowercase-hex-digits",
  "registrationObservationSHA256": "64-lowercase-hex-digits",
  "adoptionObservationSHA256": "64-lowercase-hex-digits",
  "workerClosureObservationSHA256": "64-lowercase-hex-digits",
  "releaseObservationSHA256": "64-lowercase-hex-digits"
}
```

The placeholders above describe the format; they are not valid digest values.
The evidence is limited to 8 KiB. Duplicate keys, extra fields, malformed UTF-8,
unsupported outcomes and permission booleans refuse publication.

Only a future actual source-bound coordinator may call the writer after known
registration/readback, renderer adoption, physical worker closure and coordinated
release acknowledgement. This module records hashes and a historical assertion;
it does **not** independently verify those observations or authenticate their
producer. Calling this API with claimed hashes cannot authorize installation.
There is no MCP writer or generic native dispatch added by this component.

## Disk and publication

The new record is `terminals/<operationId>/terminal.json`, separate from the
unchanged `operations/<operationId>/intent.json` and
`jobs/<nativeJobId>/binding.json`. It contains the original five-field binding,
root/job/terminal directory identities, fixed evidence fields and the canonical
evidence digest. It contains no raw plan, credentials or observation paths.

Publication reuses `immutable-records.mjs`: exclusive new directory, flushed
temporary file, no-overwrite hardlink publication and exact byte readback after
writer close. The writer revalidates both original indexes and performs a final
full inventory. A pending file, extra name, changed ancestor, failed readback or
partial publication stays held. Nothing is removed to retry. A second writer
refuses even if its proposed evidence matches; use inventory to reconcile a lost
publication acknowledgement.

File flush/readback is process-level evidence, **not** proof of directory-entry
or database durability across power loss. `powerLossPersistenceVerified` remains
false. Unknown release acknowledgement must be reconciled against the original
operation/committed record/worker evidence before any terminal is written. A
missing terminal does not authorize repeating installation or clearing IDs.

## Inventory and root anchor

Inventory uses bounded `opendir` scans of all three indexes, derives request
digests from the actual canonical request, validates cross-index bindings, and
rechecks all initial file generations and directory identities/names. The caps
are 1,024 operation identities and 32 MiB of aggregate bounded record reads.
Overflow is incomplete/HOLD, never truncation reported as a complete census.

A missing root returns `complete:false`, `observedRootId:null` and
`startupHoldRequired:true`. It is never created by a read. A present empty root
can be observed as empty, but a root-ID match alone still requires a startup
hold. There is no initialization fallback.

Complete observations include `observedInventorySHA256`: the hash of fixed-schema
canonical JSON containing the observed root ID, sorted index names and sorted
operation rows. Each row binds the operation/job/request/packet/worker identity
and canonical intent, job-binding and terminal-record digests (or explicit null
for an absent counterpart). A partial or unstable census returns no census hash.
The seal therefore changes when a pending entry disappears even if other closed
entries and the same root directory remain.

Both optional expected values must come from independently retained trusted
**main state**, not from a journal file or an automatic read-and-echo fallback.
`historySealVerified` is true only if both root identity and complete census
match. Without both anchors `startupHoldRequired` remains true, even when every
visible operation is closed. An externally anchored matching empty census may
describe an initially clean root; a root ID alone cannot establish that.

The future source-bound coordinator must persist the root and census anchors
**including every newly reserved pending operation before its START**, compare
them on startup, and update the trusted census after each known terminal transition. It must verify the authorized
transition rather than blindly bless whatever a new read happens to contain.
That main-state persistence/transition integration is not implemented here.

`rootIdentityVerified:true` and `historySealVerified:true` mean comparisons with
the supplied anchors succeeded. They are not signatures or proof that those
anchors were trustworthy. No anchor is bootstrapped from a missing/recreated
journal. The same reader additionally refuses disappearance of jobs it
previously observed. This component creates no key, separate ledger or signature
framework and claims no independently authenticated history across restarts.

Only a coherent terminal plus both original indexes produces
`state:"historical_closed"`. Intent-only, reservation-only and missing-terminal
operations remain unresolved. Malformed, pending, orphan-terminal, unexpected or
changing data makes the entire inventory incomplete and discards partial closed
results. Closed history therefore need not hold a fully anchored startup forever,
while unresolved history still holds it before discovery. Actual startup wiring
remains a separate coordinator/source integration gate.

Results are sanitized IDs/digests/counts. `historicalOnly:true` accompanies
`independentCompletionVerified:false`, `currentStateVerified:false`,
`discoveryPermit:false`, `canReplay:false`, `effectsAllowed:false` and
`installationPermit:false`. A stable before/after census is a point observation,
not an OS lock or a universal atomic filesystem snapshot. Nothing here is a
current game-state, global-quiescence or restart-recovery permission.

## Local checks

```powershell
node --test --test-timeout=15000 tools/modding/vortex-agent/native-executor-journal.test.mjs tools/modding/vortex-agent/native-intent-journal.test.mjs tools/modding/vortex-agent/plan-journal.test.mjs
```

Tests use retained own scratch directories and controlled I/O faults. Child
process races concern only the test's own Node children. They do not launch
Vortex, access a user database or establish physical installation acceptance.
