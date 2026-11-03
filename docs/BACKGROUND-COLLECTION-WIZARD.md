# Background collection wizard

Resident implementation is locally built, installed and model-tested. Live acceptance of
Install Now/Done remains pending; an idle DOM read does not establish that gate.

The official Vortex 2.9.1 collection extension exposes session inspection, but
not its exact Install Now/Done transitions as extension APIs. A renderer extension
can inspect its own DOM without taking over the desktop. The maintained bridge
will use only fixed collection-wizard controls, not generic selectors, JavaScript
evaluation, OS input, React internals or changes to Vortex's ASAR.

Verified live: the installed official application allowed a read-only extension
to inspect its renderer document while the window remained hidden and unfocused.
Native mod/profile/download/settings digests and publisher state were unchanged.
The wizard was idle: that result does not prove identity binding or a click.

Implementation checklist:

- [x] Source-bound DOM inspection with fixed modal, card, profile and footer shape.
- [x] Pure identity/session policy and native metadata projection.
- [x] Observe collection lifecycle events and bind a new owner to its query modal.
- [x] Expose read readiness and one guarded transition through MCP.
- [x] Use the shared mutation lock, durable intent and uncertain-outcome interlock.
- [x] Verify integrated source/model behavior and malformed/concurrent scenarios.
- [x] Package/install the resident integration and verify normal tool discovery.
- [x] Retire reconciled task-only probes, preserving their final evidence.
- [ ] Accept Install Now/Done against a real authorized collection flow.

Initial scope: Cyberpunk 2077, reviewed Vortex 2.9.1 sources, a newly observed
collection owner, and unambiguous Install Now/Done branches in that same flow.
Existing owners without an observed lifecycle event, profile-creation/switch
confirmation, optional/failure footers, unknown dialogs and incomplete sessions
must refuse. A matching display name/revision label alone is never identity proof.
Resume is not supported: stock Vortex resumes immediately rather than presenting
the Install Now query. A completed Done receipt arms a fresh idle epoch without
restarting Vortex; uncertain operations keep the shared interlock.

## Agent entrypoints

Call `read_collection_wizard` with no arguments. It returns only curated identity,
phase and hold reasons. `status: ready` means the observed binding passes the
local policy; `writesAvailable: false` records that asynchronous preflight has
not yet approved an action. The read performs no action or network lookup. It
verifies sources even while idle, before starting a collection, through a separate
admission cache. Concurrent reads cannot replace a prepared action's source proof.

Call `advance_collection_wizard` with the normal live game/profile/path and
filesystem pins, a unique request ID, exact `modId`, `archiveId`, positive numeric
`collectionId`, `revisionId`, `revisionNumber`, and `action: install_now|done`.
Only the fixed native wizard button is clicked. No arbitrary selector, script,
event, pointer/keyboard input or window activation is exposed.

Install Now requires the exact embedded `download.modInfo.nexus.revisionInfo`
consumed by stock InstallDriver, Nexus authentication and a matching installed
game version. Missing embedded metadata holds; a new network response would not
prove what the driver's private cache consumes. Rules with equivalent references
hold because stock replacement semantics would make augmentation ambiguous.
The controller rechecks native context, DOM element identity and source/file
generations immediately before clicking. Waiting polls native session metadata;
it does not repeatedly hash the host or scan staging/game files.

Success confirms a new matching native session (`started`) or the same completed
session moved to history with its finish modal closed (`finished`). A click,
disappearing button or timeout alone is never success. On transport loss/error,
inspect `reconcile_operation` using the original request ID; do not invent a new
ID or issue another click to bypass uncertainty. The session plan runner does
not include these wizard actions.

## Local source admission

The official host and known extensions use maintained source pins. Unknown
loaded extensions refuse. A maintainer may review additional task-helper source
closures and record their relative files and SHA-256 pins in
`<runtime>/local-state/vortex-agent-build/collection-wizard-reviewed-helpers.json`
using schema `collection-wizard-reviewed-helpers/1`, `reviewed: true`, the exact
reviewed `appAsarSha256`, and `helpers: [{folder, files: [{path, sha256}]}]`.
`files` are plugin-relative paths. A helper that imports code or immutable
configuration outside that folder must also declare its complete reviewed
`externalSources: [{path, sha256}]` closure using exact absolute local paths.
Include the immutable configuration/source graph and its transitive imports;
pinning only six launcher files does not close external code. Unknown fields,
relative external paths, UNC paths, conflicting pins and changed generations
refuse. External sources use the same chunked raw-filesystem hashing/cache and
immediate generation checks as installed sources; they are never executed by
source admission. Mutable request/result files are not executable source inputs.
This private file is not an MCP parameter. Observed hashes alone are not a code
review. Do not add credentials, runtime state or this local manifest to Git.

Main-window state uses the official preload window getters. The old
`@electron/remote` package can exist even when its IPC handlers are absent; it is
not an admitted way to read the current window in this host.

Successful transition acceptance does not prove final archive/staging/deployment
bytes or gameplay. Those remain the caller's separate lifecycle verification.
The agent never grabs mouse/keyboard input or enables a debugging port. Native
Vortex dialogs can still require attention; unknown prompts are not acknowledged.
