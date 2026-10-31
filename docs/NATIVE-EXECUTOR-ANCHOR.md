# Main-private executor anchor

The prepared Vortex source changes store one executor-history anchor in the
actual selected `LevelPersist` backend. The fixed KV key is
`nativeExecutorAnchorV1`. It is excluded from ordinary hydration and enumeration;
ordinary reads, writes and removals cannot address it or its `###` descendants.
This includes a serialized descendant supplied as one path segment.

This is the database storage boundary for
[executor history](NATIVE-EXECUTOR-TERMINAL.md). Application startup, runtime
binding, provisioning and installation coordination remain separate work. No
installation MCP endpoint or installed Vortex update is added here.

## Value and acknowledgement

The value is the same canonical, three-field UTF-8 document consumed by
`reservePending`:

```js
Buffer.from(JSON.stringify({
  schema: 'native-executor-anchor/1',
  rootId: trustedRootIdentity,
  inventorySHA256: trustedCensusDigest
}));
```

`snapshotNativeExecutorAnchor(bytes)` copies and validates at most 1 KiB. The
schema, key order, root identity and lowercase SHA-256 are fixed. Whitespace,
duplicate fields, malformed UTF-8, extra fields and shared buffers are refused.

`readNativeExecutorAnchor()` returns detached canonical bytes, or `null` only
when the fixed query observes no row. Descendants, duplicate rows, malformed
values and query errors produce a fixed HOLD error. They cannot turn into an
absent anchor or Vortex's `DataInvalid` database-repair path. The query returns
only an exact-key boolean and bounded ASCII HEX for the UTF-8 value. The reader
validates the HEX before reconstructing bytes. This avoids both an unbounded
projection and loss of a leading BOM in the reviewed driver's VARCHAR decoding.

`writeNativeExecutorAnchor(backendOwner, sqlOwner, registry, expectedBytes,
nextBytes)` requires the actual retained backend and SQL owners. `expectedBytes`
is canonical bytes or `null` for an absent predecessor. The method performs a
fixed-key compare-and-swap in one owned transaction, then exact readback after
COMMIT. The acknowledgement binds the predecessor/value hashes, root and census;
it does not authorize installation or prove power-loss durability.

An absent predecessor is a storage operation, not permission to initialize a
journal. The actual coordinator must prove exclusive fresh-root provisioning
before using it. Likewise, it must verify the legal census transition before
supplying a successor. These methods do not authenticate arbitrary supplied
hashes or inspect the filesystem journal themselves.

## Main ownership and failure

The main persistor binds the write to its existing opaque reservation, actual
backend, SQL owner and registry. It claims the attempt before parsing or awaiting
the queue, detaches input bytes, and checks the same ownership before and after
the actual backend acknowledgement. Successful anchor storage retains the
reservation for the later operation.

Concurrent registration, release or ordinary mutation cannot pass as an idle
anchor window. A failed write retains the original error and held state. An
unknown COMMIT response is not rolled back or retried. A pre-COMMIT rollback is
joined without replacing the original failure. Malformed input and wrong owners
do not produce an acknowledgement.

The main initialization wrapper checks the exact ready owner and selected
backend around the strict read. The reserved namespace is also blocked before
legacy convenience helpers can swallow an error or create a hydration entry.
Normal unrelated hives keep their existing persistence route.

## Remaining application work

The application must bind the same runtime workspace as the installed adapter,
check its journal before renderer cleanup/discovery, and acknowledge pending
history before START. A source-owned build-time runtime binding must include the
SDK source closure; inherited environment, cwd and renderer path claims cannot
select a replacement journal.

An unconfigured integration can remain unavailable while ordinary Vortex starts.
An existing anchor with a missing runtime binding, missing journal, mismatched
history or unresolved operation must stay held. Provisioning and normal/cancelled
terminal transitions still need their actual coordinator paths.

Source-derived transactional tests, real database qualification and installed
application acceptance are distinct checks. The prepared patch and its storage
acknowledgement cannot establish the latter two by themselves.

## Qualification — 31 October 2026

The corrected main sources passed the dependency-aware TypeScript target, the
actual Rolldown build and all 52 retained upstream main tests. All seven main
source entries matched the actual TypeScript Program and runtime source map.
The unchanged renderer/preload/shared evidence was retained explicitly; those
targets were not rebuilt for this main-only change. All 24 assembled source
outputs, the lockfile and compiler configuration matched their pins.
The broader source sweep passed 451 checks; six IPC checks initially lacked two
pinned support originals and passed after those inputs were supplied. No test
expectations or production code changed for that fixture correction.

An owned native fixture passed five LevelDB scenario groups: absent-to-present
and subsequent CAS with reopen, stale CAS rollback, corrupt BOM/descendant
refusal, a real COMMIT followed by an injected lost acknowledgement, and ordinary
alias/bulk protection. A sixth group used a separate DuckDB memory table to
check NULL-key filter semantics. Each LevelDB readback/reopen oracle transported
raw bytes through HEX too, preserving the corrupt BOM for comparison.

The fixture used the reviewed inputs from
[native transaction qualification](NATIVE-LEVEL-PIVOT-TRANSACTIONS.md). Its anchor
SQL ran on the real backend connection; Singleton bootstrap and query-system
setup I/O remained explicit facades. It does not qualify native constructors,
application startup, source-coordinator ordering or installation. Injecting a
lost reply after an actual COMMIT is not a native commit-I/O or power-loss test.

For the maintained source-backed checks, point the fixture variable at the
reviewed official source cache containing the pinned commit:

```powershell
$env:VORTEX_EXTENSION_ADMISSION_REPO = 'C:/reviewed/vortex'
node --test tools/modding/vortex-agent/native-executor-anchor-storage.test.mjs tools/modding/vortex-agent/native-main-executor-anchor.test.mjs
```

Without that source input, integration cases are explicitly skipped.
