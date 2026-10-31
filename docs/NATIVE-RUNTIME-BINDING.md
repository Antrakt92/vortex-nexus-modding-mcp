# Native executor runtime binding

The prepared application and standalone ZIP relay must use the same SDK and
history directory. A renderer request, current directory or inherited environment
must not select a different journal after an interrupted operation.

The main build reads `NEXUS_RUNTIME_WORKSPACE` explicitly. Without it, the native
integration is unconfigured. With it, the build records a closed
`native-executor-runtime-binding/1` tuple containing the normalized workspace,
fixed Node executable digest and hashes of the fifteen fixed SDK files under
`tools/modding/vortex-agent`. It reads those files without executing them.
The tuple is embedded through the main Rolldown configuration; changing the
runtime SDK requires a matching application rebuild.

The bound relay accepts canonical tuple bytes and checks its physical source
directory and hashes before starting its fixed child. The child receives the
validated workspace in its restricted environment. The parent environment is
unchanged. The journal uses the fixed derived path
`local-state/vortex-agent-build/native-install-executor`.

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

File hashes and ancestor generation checks are bounded point observations, not
an operating-system source lease or protection against privileged modification.
Source tests and a main build do not prove installed Electron loading or a
successful native mod installation.

The actual coordinator still needs exclusive initialization, a verified pending
anchor before Python START, registration and renderer adoption, joined worker
closure, and a terminal anchor update. Known pre-START cancellation also needs
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
