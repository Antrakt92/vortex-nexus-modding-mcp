# Native executor runtime binding

The prepared application and standalone ZIP relay must use the same SDK and
history directory. A renderer request, current directory or inherited environment
must not select a different journal after an interrupted operation.

The prepared Main build reads `NEXUS_RUNTIME_WORKSPACE`,
`NEXUS_RUNTIME_CAPSULE_SHA256` and `NEXUS_RUNTIME_CAPSULE_LOADER_SHA256` explicitly.
Without configured runtime binding, native integration remains unavailable.
Configured builds retain the canonical `native-executor-runtime-binding/1` tuple:
normalized workspace, fixed Node executable digest and original hashes of the
fifteen fixed SDK files. They validate the independently pinned capsule and
loader at the fixed workspace-relative locations
`local-state/native-sdk-capsule/compiled.json` and `loader.cjs`.

The [capsule build](NATIVE-SDK-CAPSULE.md) captures source bytes once, then emits
closed Main/relay bundles and three transformed Python modules. The application
build embeds the artifact literal and captured loader code. A separate private
banner constant pins the loader hash independently from the mutable artifact
metadata. Changing runtime source, artifact or loader requires a matching reviewed
build; ambient environment or a renderer request cannot select a replacement.

Main validates and loads exactly one private capsule namespace, then checks its
retained artifact, raw15 binding, loader identity and exports in memory. The
prepared capsule route uses no physical SDK require/cache fallback or repeated
full SDK source scans. The journal still uses the fixed derived path
`local-state/vortex-agent-build/native-install-executor`; its physical ancestry,
root identity, census and database anchor remain independently checked.

The older direct standalone bound-relay route still checks its physical SDK
layout and hashes. The new capsule child route instead executes the captured
code and receives only the validated workspace in its restricted environment.
Neither mutates the parent environment. Actual executable/core seals, archive
and staging custody and request scope remain physical checks in both routes.

The path resolver's pure core has no import-time environment lookup. Existing
adapter callers retain their configured environment/compiled-workspace behavior
through `paths.cjs`; importing a journal with an explicit root does not first
resolve an unrelated ambient workspace.

## Startup classification

The application checks the selected persistence backend before backup import,
key healing, persistence IPC initialization and creation of its main window.
An absent configuration and absent anchor leave native installation unavailable
while ordinary startup can proceed. A configured workspace with neither anchor
nor journal is uninitialized; this read does not create a journal or anchor.

An existing anchor requires its matching configured history. Missing, unreadable,
corrupt, mismatched or unresolved history requires reconciliation before startup
continues. A matching closed census is historical evidence only. It does not
authorize an installation, prove current mod state or permit replay.

Failures use the ordinary `NATIVE_EXECUTOR_STARTUP_HOLD` error with a bounded
`reasonCode`: binding, anchor read, root observation, source closure, SDK loading,
history scan or reentry. Raw filesystem errors and paths are not included.
The gate follows backend selection and its ordinary multi-user flag setup; it
does not claim that database construction or all ordinary startup writes are
side-effect free.

Deleting or rolling back both trusted database state and its entire history
together cannot be distinguished from an earlier state using these records alone.
Preserving the trusted main database remains a recovery requirement.

## Acceptance boundary

Build-time file hashes and data-path ancestor generation checks are bounded
point observations, not an operating-system lease or protection against
privileged modification. The capsule's private expected artifact digest and
builtin allowlist load trusted compiled code; they are not an untrusted-code
sandbox.
Source tests and a main build do not prove installed Electron loading or a
successful native mod installation.

The [main-owned initialization bridge](NATIVE-EXECUTOR-GENESIS.md) provisions and
persists the first empty census under genuine ownership. The prepared
[completion coordinator](NATIVE-EXECUTOR-COMPLETION.md) now connects
a verified pending anchor before Python START, registration and Renderer
adoption, joined worker closure and a terminal anchor update. Its capsule Main
wiring is source-prepared and Main-build-qualified, with unchanged non-Main
outputs retaining their Q103 proof; installed acceptance remains separate.
Known pre-START cancellation also needs
its own proved terminal transition. Local ZIP import remains a separate missing
operation. None of these steps is authorized by a startup classification.

## Checks

`native-runtime-binding.test.mjs` covers the canonical tuple, copied SDK layout,
hostile environment and captured readiness hashes. Its real own-archive
Node/Python pre-START fixture requires `VORTEX_BOUND_RELAY_TEST=1` and the pinned
Windows toolchain. It never uses an installed Vortex session.

`native-main-runtime-binding.test.mjs` and `native-executor-startup.test.mjs`
require the reviewed official source fixture for their integration cases, using
the same source/dependency inputs as the
[anchor source checks](NATIVE-EXECUTOR-ANCHOR.md#qualification--31-october-2026).
Missing optional inputs are reported as skips, rather than native acceptance.

The new Main capsule source cases cover removed/churned SDK code paths while
retaining physical journal-drift refusal, strict build-pin failure and one-time
namespace loading. These source cases and the 46-case capsule READY/abort matrix
have separate scopes; neither exercised a physical installation. Graph105 passed
fresh Main typecheck/build and 52 upstream tests without skips. Seven Main
Program/map entries were fresh, eighteen non-Main Program entries and sixteen
non-Main source-map entries were retained from Q103, and all 25 source outputs matched. Four non-Main
runtime files stayed exact; Electron remained cold. The qualification receipt is
`local-state/native-capsule-main/recovery/qualification105/QUALIFICATION.json`,
SHA-256 `deb36e910f52fcff592110ca92690c86625b4e988a1b73685080e53a59c1f325`.
This does not claim fresh builds of the unchanged Renderer, Preload or Shared
projects, an installed kit or native installation acceptance.
