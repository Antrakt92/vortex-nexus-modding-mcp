# Internal executor preparation transport

The source assembly includes a fixed renderer/preload/Main path for preparing one
reviewed native job. This is internal application source. It is not exposed by
the public MCP adapter or extension registration API, and it cannot issue START.
An installed application update and native acceptance remain separate gates.

## Order and authority

1. Copy the request and archive metadata bytes before asynchronous work. Main
   validates its actual readiness, pinned SDK and supported request contract.
   This preflight does not provision history, reserve the mod or create a worker.
2. Main issues a fresh challenge bound to the request, archive, job, game, profile,
   mod, manager scope and renderer generation. The actual renderer manager acquires
   exclusion and target ownership, then waits for the previous persistence ACK.
3. The fixed response channel accepts only the captured WebContents and exact
   originating frame. Matching IDs or a copied frame object are insufficient.
   Main reserves the genuine mod owner only after renderer admission.
4. A second challenge checks the same renderer ownership before Main prepares the
   private pending journal and commits its successor anchor with CAS/readback.
   Preparation may create an inert worker in a qualified native host; it is not
   a read-only operation. The current composed tests use a relay facade.
5. A third check confirms the same renderer owner. The result contains only the
   closed preparation projection, without owner tokens or the private relay.
   `effectsAllowed`, `installationPermit`, `nativeAdmission` and
   `powerLossPersistenceVerified` remain false.

The request and archive hashes, challenge identity, round and stage must match at
each response. Supported profile IDs retain the parent admission contract,
including leading `_` and `-`, and its reserved-name refusals. Preload snapshots
closed data without invoking accessors and observes native promises without
trusting an arbitrary thenable. Renderer challenge-response errors use a fixed
code. Preparation-invoke failures retain Main's primary error through the
existing wire-error path.

A foreign duplicate invoke cannot stop the genuine flight. A duplicate from its
actual owner, frame loss, invalidation, malformed response or observation deadline
holds the operation. The 30-second monotonic deadline ends observation; it is not
a lease or permission to retry. Late underlying work stays observed, ownership
is not refunded, and a late pending journal remains subject to reconciliation.

## Verification boundaries

The integration suite executes the patched renderer, preload, IPC and Main
actors with actual source admission, SDK parsing, journal and anchor logic.
Electron, DOM, transactional storage and relay preparation are explicit fixtures.
It does not launch Vortex, a game or a native child.

Combined source tests that create SDK workspaces must run with
`node --test --test-concurrency=1`, using the reviewed source/dependency environment.
This avoids fixture interference; it does not prove concurrent native acceptance.
The individual suites still exercise controlled reentry, invalidation, late work,
wrong-frame responses and duplicate requests.

One attempted parallel matrix passed 89 cases and failed seven. The SDK guard
retains generation snapshots of every ancestor directory. Creating another
fixture workspace under a shared ancestor changes that snapshot and causes HOLD.
A separate causal check changed one sibling and confirmed that exact ancestor
drift without journal, relay or START effects. This is also an availability
limitation for runtime workloads: unrelated ancestor changes can abort a job.
The guard has not been weakened to make the tests pass. Safe retained native
custody/source provenance must resolve this before enabling an installer.

## Remaining installation work

- Connect START, copy proof, registration, renderer adoption, worker closure,
  terminal journal evidence and terminal anchor CAS/readback to the actual
  coordinator, then execute the source-owned release sequence.
- Define verified handoff for a new operation after known completion. Current
  transport lifetime slots are one-shot; clearing them after an unknown outcome
  would permit unsafe retries. Consumed IDs and durable history must remain.
- Close a proven inert cancellation with its own terminal outcome and anchor
  transition. An unresolved pending journal is not successful cancellation.
- Resolve ancestor-generation availability without losing source/path integrity.
- Prove native constructors, ABI, emitted source parity and the complete workflow
  in an isolated application before updating the installed host.
- Implement local ZIP import as a separate guarded contract. The first reviewed
  family remains tracked, new and disabled; this transport does not add import.

Keep the ordinary MCP installation refusal until these gates pass. No installed
Vortex, managed staging directory or game file was changed by this source work.
