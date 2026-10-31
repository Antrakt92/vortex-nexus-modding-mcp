# Fixed Node relay for the ZIP worker

`owned-zip-relay-client.mjs` starts one fixed standalone Node entrypoint. The
runner dynamically imports the ZIP SDK after its ready/start handshake, then
uses the existing Python guardian. This is an internal process bridge, not an
install MCP tool or an installed Vortex coordinator.

The only modes are `scratch` and `staging`. Executable, script, argv, backend and
callback overrides are absent. The executable is the reviewed Windows x64 Node
24.20.0 at `C:/Program Files/nodejs/node.exe`, checked against its pinned SHA-256.
The child environment contains only SystemRoot and the configured runtime
workspace; it does not inherit NODE_OPTIONS or NODE_PATH. SDK Electron refusal
remains in force.

The physical runtime closure contains fourteen fixed source files: the SDK and
its data/I/O modules, the Python components, the terminal observer, and both relay
modules. Their hashes are checked separately from Vortex's application ASAR and
the resident adapter ledger. These are source point observations, not an OS-wide
code lease or a sandbox against privileged file modification. A packaged host
still needs its own code/layout/loading qualification.

## Operations and transport

```js
const relay = createOwnedZipRelay(requestBytes, archiveBindingBytes, 'staging');
await relay.start();
await relay.waitFor('extracted');
await relay.handoff();
const proof = await relay.copyProof();
await relay.release();
```

This example describes the component lifecycle on an authorized own fixture.
Calling it with claimed plan data does not authorize managed installation.

The factory is inert. START binds the canonical dispatch, archive data, mode,
operation/job IDs and renderer generation to one relay lifetime. The existing
SDK remains the single writer of operation/job reservations; main must not call
`begin()` a second time for the same operation. Controls are fixed typed messages,
never arbitrary task or filesystem calls. Timeouts preserve ownership and do not
start another child or change request IDs.

Strict JSON lines reject duplicate keys, malformed UTF-8, wrong binding/nonces,
stale sequences and oversized frames. Status has a 64-KiB cap. Full copy proof has
a separate four-MiB-plus-envelope cap, fixed schema and one essential output slot;
status backpressure cannot replace that response. Sequence numbers are assigned
when selecting the next write. Source and stderr reads also have explicit bounds.

`copyProof()` validates the complete expected payload, native identities and the
SDK metadata binding. Reconstructing the fixed Python canonical JSON encoding
must reproduce both its exact byte count and SHA-256. The checked snapshot is
detached before return and may be read again from the cache while custody remains
live. Cancellation, release, timeout or loss of either process boundary prevents
a late response from restoring a live proof.

## Two process boundaries

The parent observes the actual Node child and its exact stdin/stdout/stderr
objects as `relayTerminal`. The SDK independently observes Python and its three
pipes as `sdk.workerTerminal`. Neither a fulfilled wrapper nor a single `close`
event substitutes for both observations. Actual `exit` invalidates live copy
proof before waiting for the last pipe to close.

Normal release joins Python, then Node and their owned pipes. EOF or controller
loss stops further work and leaves uncertain custody held. It does not authorize
automatic release, force termination, cleanup, replay or another worker. The
tests have a separate, reviewed retirement path for their own deliberately held
fixtures; that helper is not part of the production relay.

## Remaining managed integration

The relay currently starts the SDK's journal reservation and START path as one
component operation. Before managed use, add an explicit pre-START boundary so
the actual main coordinator can persist the newly reserved pending census anchor
before file effects. An observation after START cannot satisfy that ordering.

The application coordinator must also bind the actual main reservation, renderer
manager/fence/flush owners, active game/profile and filesystem roots. Only its
actual registration result may drive adoption. It must preserve the runtime
workspace across code updates and reconcile pending history before startup,
cleanup or discovery. The existing read-only readiness IPC is not an effects
channel.

Those application, durable-transition and installed-host gates remain open.
Own synthetic staging acceptance does not prove a real ZIP installation through
Vortex, deployment, crash recovery or power-loss durability.

## Local checks

```powershell
node --test tools/modding/vortex-agent/owned-zip-relay.test.mjs
$env:VORTEX_OWNED_ZIP_RELAY_HELPER_TEST = '1'
$env:VORTEX_OWNED_ZIP_RELAY_TEST = '1'
node --test tools/modding/vortex-agent/owned-zip-relay.test.mjs
```

Native checks use only fresh own archives and model staging directories. The
default run leaves them explicitly skipped; it does not establish native
acceptance. A retained Python-produced proof can additionally be supplied through
`VORTEX_OWNED_ZIP_RELAY_PROOF` for the canonical byte/digest regression.
