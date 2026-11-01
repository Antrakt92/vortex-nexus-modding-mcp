# Sequential native operations

The source executor can prepare another operation after the previous operation
has completed all seven stages and both Main and Renderer releases are confirmed.
It keeps the same application, store, backend, journal and captured SDK instance.
This avoids rebuilding those parts for every mod. Installed-host acceptance and
the public MCP installation command remain separate gates.

## Completion handoff

Renderer calls its internal `handoffNativeExecutorSuccessor()` method after
validating the completed execution result. The fixed preload method sends only
the previous `transportId` and `executionId` on
`persist:native-executor-successor`. Callers cannot supply owners, paths, receipts,
callbacks or reset flags.

Main requires its original WebContents/frame and the completed private transport.
It checks the closed worker observations, terminal census, committed C anchor,
source identities and released writer state. IPC validates the completed result
and reserves history capacity before retirement. After the final checks, Main
and IPC clear only their operation slots in the same synchronous turn. No I/O,
callback or await follows the first clear.

The frozen `native-executor-successor/1` acknowledgement contains exactly:

| Fields | Meaning |
| --- | --- |
| `transportId`, `executionId` | Previous completed execution |
| `operationId`, `nativeJobId`, `requestSHA256` | Previous operation binding |
| `ready:true` | Correlated handoff completed |
| `effectsAllowed:false`, `installationPermit:false`, `nativeAdmission:false` | Source handoff grants no installation authority |

Renderer validates that acknowledgement against its retained completed operation
and current source route. It then clears its five operation fields. The boot
receivers, listeners, store, manager and source identities remain. A new operation
gets fresh opaque reservations and transport/execution/challenge IDs; its target
and archive must independently satisfy the existing admission rules.

## History and failures

Consumed operation/job/request IDs, journal records and the initialized C anchor
are retained. Compact completed-history maps hold at most 4096 entries per
application lifetime, without eviction. They retain identifiers, receipts and
context identities rather than archive bytes or completed transport objects.
Capacity refusal occurs before retirement.

A lost handoff reply does not change a successful installation into a failure.
Renderer retains its completed state and can request the exact historical
acknowledgement. Reconciliation does not repeat START, registration, terminal CAS
or release. Historical replies still require the original frame, epoch and
persistor. Late retired execution IDs and exact retired prepare-byte digests
cannot consume the next operation.

Unfinished, held or uncertain operations are ineligible. A known cancellation
before extraction follows its separate [handoff](NATIVE-EXECUTOR-CANCELLATION.md)
and cannot satisfy the installed-success predicates above. Neither path clears
unknown evidence to permit a retry. If Main released but Renderer refused, that
split remains recorded and a successor is unavailable.

## Verification boundary

The composed tests exercise the actual patched Main, Renderer, Preload and IPC
with one captured SDK and two distinct requests, mods and archive associations.
They check journal progression, retained records, disabled profiles, unrelated
writes, lost acknowledgements and stale requests. SQL, Electron delivery and
physical process observations are explicit test facades. The separate
[physical capsule tests](NATIVE-SDK-CAPSULE.md) cover synthetic ZIP copy/closure.
Neither establishes a complete installation inside an installed Vortex host.
The earlier installed-success source cohort passed the separate
[111-patch qualification](NATIVE-SOURCE-ASSEMBLY.md#sequential-operations-111-patches).

With the reviewed source/dependency and capsule compiler inputs configured:

```powershell
node --test --test-concurrency=1 tools/modding/vortex-agent/native-main-executor-successor.test.mjs tools/modding/vortex-agent/native-renderer-executor-successor.test.mjs tools/modding/vortex-agent/native-executor-successor-ipc.test.mjs tools/modding/vortex-agent/native-executor-successor-preload.test.mjs tools/modding/vortex-agent/native-executor-successor-integration.test.mjs
```
