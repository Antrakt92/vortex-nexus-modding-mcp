# Captured native SDK capsule

This component builds and loads executable SDK bytes without reopening the
external SDK source files during execution. It captures the existing fifteen-file
SDK, bundles its twelve JavaScript files into closed Main and relay code, and
adapts the three reviewed Python sources for an in-memory bootstrap. The fifteen raw SDK files
remain unchanged. The prepared [application graph](NATIVE-SOURCE-ASSEMBLY.md)
adds Main/build wiring to this loader and artifact. This is source preparation;
the kit is not installed and adds no public MCP installation command.

## Build and load contracts

The maintained build APIs are:

- `captureNativeSDKSources(sourceDirectory, expectedSourceSHA256)` in
  [native-sdk-capture.mjs](../tools/modding/vortex-agent/native-sdk-capture.mjs):
  captures all fifteen fixed names through bounded, generation-checked reads.
  Its opaque branded capture retains detached bytes; later reads use
  `readCapturedNativeSDKSource(capture, name)` without reopening a source path.
- `buildNativeSDKCapsule(capture, runtimeBindingBytes, compiler)` in
  [native-sdk-capsule-build.mjs](../tools/modding/vortex-agent/native-sdk-capsule-build.mjs):
  uses the already-reviewed workspace's Rolldown function. Its fixed virtual
  resolver admits only captured module names and the fixed builtin list; it does
  not discover packages or install a compiler. It returns a frozen result with
  canonical `artifact`, its `sha256`, Main/relay input lists, relay bootstrap and
  envelope, and `nativeAdmission:false`.
- `loadNativeSDKCapsule(artifactBytes, expectedArtifactSHA256, canonicalRuntimeBindingBytes)`
  in [native-sdk-capsule-load.cjs](../tools/modding/vortex-agent/native-sdk-capsule-load.cjs):
  detaches and validates both byte inputs, the independently expected artifact
  digest, binding and internal hashes before evaluating the closed Main code.
  It returns frozen `artifactSHA256`, `binding` and `modules`. The five fixed
  namespaces expose the actual journal, relay, staging-input and plan functions.

The trusted caller must retain **one Main namespace instance** across startup,
genesis, pending reservation and terminal settlement. Loading a second copy would
create separate journal WeakMap brands, occupied operation slots and consumed-ID
state. A matching JSON receipt cannot bridge those process-local identities.

## Prepared application Main wiring

The two new patches are `native-main-sdk-capsule` and
`native-main-sdk-capsule-build`. The Main build takes three explicit inputs:
`NEXUS_RUNTIME_WORKSPACE`, `NEXUS_RUNTIME_CAPSULE_SHA256` and
`NEXUS_RUNTIME_CAPSULE_LOADER_SHA256`. It reads the artifact and loader from fixed locations
`<workspace>/local-state/native-sdk-capsule/compiled.json` and `loader.cjs`,
validates their independently supplied digests and binding, and emits a closed
artifact literal plus the captured CJS loader in the Main banner. An independent
private banner constant pins the loader SHA; changing only the artifact literal's
loader metadata cannot substitute it. The builder does not accept caller paths
for either file.

The build still verifies the fifteen raw SDK files. Runtime checks use the
captured executable code rather than reopening those files.

Main claims its private loader phase before calling the captured loader. It
retains one validated five-namespace result across startup, genesis, pending and
terminal settlement. Later source checks compare the captured artifact/base64,
raw15 binding, loader function and private digest identities in memory; they do
not re-evaluate code, use SDK `require.cache`, or repeatedly hash SDK directories.
Changed metadata or reentry holds the original attempt without fallback. Physical
journal, executable/core, archive and staging checks retain their contracts.

Ten source cases passed without skips: five direct Main cases and five actual
four-actor compositions, with explicit SQL/process/Electron facades. They include
an absent or renamed SDK tree, post-load code-directory churn, physical journal
drift, strict invalid artifact/binding/loader pins and metadata drift before the
first COPY. An actual Main TypeScript Program check passed with 1,141 sources and
zero diagnostics. Graph105 then passed fresh Main typecheck/build and 52 upstream
Main tests without skips. Seven Main Program/map members were checked afresh;
eighteen non-Main Program members, sixteen maps and four runtime output files
retain their exact Q103 proof. All 25 source outputs and 23 maps were sampled.
The changed Main build input emitted the exact captured loader body, independent
private loader pin, artifact/base64 digest and all fifteen raw SDK pins. Electron
remained cold. This does not prove installed loading or a physical installation.

## Provenance and executed bytes

The binding pins the fifteen original raw source hashes and the explicit
workspace. Build-time adapters additionally pin the reviewed raw Python sources
and the adapted JavaScript sources they understand; changed input requires an
adapter review rather than a best-effort rewrite. Python `originalSHA256` and
`executionSHA256` are separate: the latter hashes the three transformed modules
actually compiled by Python. The artifact also records transformed JavaScript,
compiled Main, relay-code and envelope digests. Its independently retained whole
artifact digest binds the complete generated result.

Repeated builds with the same captured bytes, binding and reviewed compiler are
checked for deterministic output. Raw-source identity alone is not a compiled
artifact pin. Build outputs, capsules and qualification receipts stay in ignored
local state; generated code artifacts are not committed as source.

The CJS loader evaluates trusted compiled code with a private fixed builtin
require list and rejects path/package resolution and dynamic import. This is
not an untrusted-code sandbox: admitted builtins include filesystem and process
capabilities. The expected compiled artifact digest and reviewed build inputs are
the code authority. No caller-supplied source, executable, module name or loader
callback is accepted by the managed runtime protocol.

## Separate child bootstraps

The Node relay uses the fixed reviewed executable and a fixed `-e` bootstrap.
Its first private LF frame carries a digest-bound canonical capsule envelope,
limited to 4 MiB with at most 2 MiB decoded code. The Python child retains its
fixed executable and `-I -S -B -c` bootstrap; its first private LF frame is limited
to 2 MiB and contains only the three named transformed sources and fixed workspace.
Source bytes are not passed through argv or environment variables.

Both bootstraps have fixed ten-second **receive-only** deadlines. The Node timer
is removed before running admitted code; Python validates/hashes and precompiles
all three modules, then disarms its timer under the same lock used by the expiry
callback before any module executes. These timers cannot cancel an executing SDK,
release custody or authorize a retry. Partial input, early EOF, queued trailing
control data, oversized frames and digest mismatch refuse before SDK execution.
The source frame is separate from subsequent READY/request/START messages.

Python compiles the custody, ZIP and worker modules once. The ZIP factory is bound
to the same custody classes; the legacy non-ZIP process backend refuses instead
of loading an unpinned sixteenth sibling. Synthetic `__file__` values serve only
diagnostics. Workspace/work/journal paths come from the explicit bound context.

Only CODE lookup changes. Physical Node/Python executable/core verification,
Windows ABI and zlib checks, journal ancestry/census/anchor checks, archive
identity/bytes/hash, staging roots, exclusive output custody and CopyProof
validation retain their physical contracts. Capsule loading grants none of
those data-path permissions.

## Checks and remaining gate

The fresh five-suite matrix passed **46 tests without skips**. It includes the
actual reviewed Rolldown build and production Main loader (journal branding and
constants), a real Node relay READY then abort with exit zero and all three pipes
closed without SDK source files, and real Python 3.14.8 READY then inert abort with
exit zero, runtime hashes, all three executed-source hashes and all three pipes
closed. No START, archive access, game access or staging operation occurred.
These are capsule/bootstrap acceptance checks, not a physical mod installation.

The build integration tests use explicit reviewed inputs:

```powershell
$env:VORTEX_CAPSULE_BUILD_SOURCE = 'C:/Task/reviewed-vortex-build-workspace'
$env:VORTEX_CAPSULE_BUILD_SDK = 'C:/Task/reviewed-sdk'
$env:VORTEX_CAPSULE_BUILD_BINDING = 'C:/Task/pinned-runtime-binding.json'
node --test tools/modding/vortex-agent/native-sdk-capsule-build.test.mjs

# Also supply the pinned original-source export for application build-patch checks.
$env:VORTEX_NATIVE_SOURCE_ROOT = 'C:/Task/pinned-vortex-originals'
node --test tools/modding/vortex-agent/native-main-sdk-capsule-build.test.mjs
```

The source workspace must already contain the reviewed compiler/dependencies.
These inputs do not authorize an install or a package-manager download. Omitting
inputs skips those integration cases, which must not be reported as acceptance.
The 46-case component matrix predates application Main wiring and remains its
own no-START proof. The new application source has separate graph105 Main build qualification;
installed-host acceptance remains outstanding. The
[internal completion route](NATIVE-EXECUTOR-COMPLETION.md) is prepared source,
not a deployed capsule or public installation permission.

Graph105 qualification receipt:
`local-state/native-capsule-main/recovery/qualification105/QUALIFICATION.json`,
SHA-256 `deb36e910f52fcff592110ca92690c86625b4e988a1b73685080e53a59c1f325`.
Its capsule artifact SHA-256 is
`bb59ae71c1adec6799a2de6aa26dcfa531dc5e01a28ba63c95c9e270c9d68f41`.
Raw SDK15 bytes are unchanged; prior SDK clones and qualification evidence remain
preserved. Non-Main projects were not rebuilt for this two-input Main change.

The final combined source matrix passed 497 tests without skips, including the
component checks and the new Main/build/four-actor cases. The separate upstream
Main suite passed 52 tests. Source actor tests use explicit SQL/process/Electron
facades; the component READY/abort checks do not exercise extraction or copying.

## Physical capsule ZIP checks

`native-sdk-capsule-native.test.mjs` separately exercises the real bound staging
SDK over new, task-owned filesystem directories. It builds a capsule with no SDK
source directory at its runtime workspace, prepares a pending job, explicitly
sends START, extracts a generated compressed ZIP, copies two files and verifies
their hashes against the plan and CopyProof. Release must observe exit zero and
all three pipe closures for both the Node relay and Python worker.

A second physical case cancels after preparation without START. It checks the
absence of target/work output after release and closure of both processes. A
separate regression ensures an identity-probe failure cannot lose the already
spawned child before the SDK receives it. All three checks passed without skips.

Each attempt retains its capsule bytes, canonical runtime binding, request,
helper/test/compiler/source pins, process identity and outcome under ignored
`local-state/owned-zip-relay-tests/run-*`. Existing identity-checked fixture
retirement is a failure-only cleanup route; it is never normal release or an
installation permit. Successful attempts leave pending journal history intact:
filesystem copying alone supplies no Vortex commit/adoption or terminal anchor.

Use the reviewed compiler/SDK/binding inputs above, then explicitly opt in:

```powershell
$env:VORTEX_CAPSULE_NATIVE_TEST = '1'
node --test --test-concurrency=1 tools/modding/vortex-agent/native-sdk-capsule-native.test.mjs
```

These checks create no Vortex mod record, use no installed game/staging paths and
do not start Vortex or a game. They qualify physical SDK preparation/copy/closure,
not the complete application installation or repeated-operation handoff.
