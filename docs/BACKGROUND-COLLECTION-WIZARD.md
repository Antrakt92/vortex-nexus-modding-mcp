# Background collection wizard

Install Now has passed an authorized live collection test on official Vortex 2.9.1.
Done still needs live acceptance through MCP. Closing a resumed installation through
Windows UI Automation does not establish that gate.

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
- [x] Accept Install Now against a real authorized collection flow.
- [ ] Accept Done through MCP in the same uninterrupted collection flow.

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


## Stock collection version questions

The locally verified `read_collection_dialog({})` and `respond_collection_dialog`
source wiring adds only the stock previous-version question during a retained,
observed collection session. The response requires normal write context, the same
seven collection identity fields, exact `dialogId`, a unique request ID, and
`action: update_current_profile`. It invokes the captured native `closeDialog`
with the fixed Update current profile action and `remember: false`. Other
questions, Update all profiles, generic responses and remembered choices refuse.
The observer is created once per API before server requests, so it does not guess
install events missed before its startup. Read and write source proofs are independent.

This route shares the mutation lock, durable intent, uncertain-outcome interlock
and receipt verification. Success proves only `nativeDialogDismissalVerified`;
`installationCompleted` and disk-deployment proof remain false. Inspect the
original receipt after uncertainty instead of answering again with a new ID.

Stock dialog records expose no incoming archive identity or callback-origin token.
The controller joins an observed native install epoch to one exact retained
session, member rule, finished download and installed old-mod display identities. Same-title candidates are accepted only
when every candidate has the same positive Nexus mod ID and none is a collection;
all candidate IDs are reported as `oldModIds`, without claiming which private
callback record stock selected.
Those bounded joins do not prove private callback origin or target archive identity;
readiness explicitly reports both unverified. This is source/model evidence; a real
response through the installed MCP remains a separate acceptance check.

When the approved installation plan already includes updating the current profile,
agents should handle these recognized questions serially through the named tools.
Use a stable request ID for each dialog, leave remembered choices off, and observe
the next question after each verified dismissal. This standard choice does not
require asking the user again. An unfamiliar question or a held readiness result
requires diagnosis; it does not authorize replaying the installation.


## Stock Download update prompt

`read_collection_update_prompt({})` observes the exact stock prelude from its
genuine `collection-update` event, with a persistent observer initialized before
requests. `advance_collection_update_prompt` accepts normal write context plus
`oldModId`, positive `collectionId`, `collectionSlug`, positive `revisionNumber`
and only `action: download_update`. It clicks the captured fixed Download update
control after independent source admission and immediate native/DOM revalidation.
It exposes no arbitrary selector or generic dispatch.

The shared mutation lock and durable interlock apply. A successful receipt proves
`nativePromptDismissalVerified: true` and retains `installationCompleted: false`.
The prompt provides no target `revisionId` or archive identity; dismissal does not
prove download success or installation. The prelude has local model coverage;
its actual R13 UI automation observation is not live acceptance of these MCP tools.
