# Captured native SDK capsule

This component builds and loads executable SDK bytes without reopening the
external SDK source files during execution. It captures the existing fifteen-file
SDK, bundles its twelve JavaScript files into closed Main and relay code, and
adapts the three reviewed Python sources for an in-memory bootstrap. The raw SDK15
and the [103-patch application graph](NATIVE-SOURCE-ASSEMBLY.md) remain unchanged.
The application Main path is **not yet wired to this loader or build artifact**;
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
```

The source workspace must already contain the reviewed compiler/dependencies.
These inputs do not authorize an install or a package-manager download. Omitting
inputs skips those integration cases, which must not be reported as acceptance.
Application Main wiring, a new source/build qualification and installed-host
acceptance remain separate work. The [internal completion route](NATIVE-EXECUTOR-COMPLETION.md)
still describes the existing application-source generation, not a deployed capsule.
