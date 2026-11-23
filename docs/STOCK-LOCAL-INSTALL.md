# Install a new local ZIP through MCP

`install_local_archive` installs one new own-local Cyberpunk ZIP through the
official Vortex installer. It leaves the mod disabled and does not deploy it.
The extension stays installed; agents do not generate a temporary plugin or
restart Vortex for each mod.

This path supports the reviewed **official Vortex 2.9.1, 2.10.1 and 2.11.0** packages
and extension sources. It does not require a Vortex fork, application patch or UI automation.
The stock event/callback approach was investigated from
[Doodlebot](https://github.com/doodlum/vortex-doodlebot/tree/3b78fdfba1d1d07858908fffea53b32d46033df1).
Its automatic dialog and FOMOD responders are not included.

## Before installation

1. Read `health` and retain the active game/profile, three canonical paths and
   `filesystemIds`. Keep the same context; never switch profiles to fit old pins.
2. Call `read_local_install_readiness`. This verifies the actual running package
   path and the loaded extensions against reviewed source hashes. A new host or
   unknown/changed extension refuses installation until its sources are reviewed.
3. Prepare the own ZIP, record its exact size and SHA-256, and choose one stable
   `requestId`. The filename must use ASCII letters, digits, dots, underscores or
   hyphens, begin with a letter/digit, end in lowercase `.zip`, and fit 120 characters.
   Its basename becomes the expected Vortex mod ID.

The ZIP validator checks CRCs, paths, sizes, link attributes and duplicate names
without extracting files. Limits are 64 MiB compressed, 256 MiB uncompressed and
4,096 entries. Supported file roots are:

- `archive/pc/mod/`
- `r6/scripts/`
- `r6/tweaks/`
- `red4ext/plugins/`
- `bin/x64/plugins/cyber_engine_tweaks/mods/`

FOMOD, Vortex override instructions, unsupported ZIP extra fields and files
outside those roots refuse. This first path is for our ordinary build ZIPs;
it is not a general installer for every Nexus archive.

## Install, verify, enable and deploy

Call `install_local_archive` with the normal write pins plus:

| Field | Value |
| --- | --- |
| `requestId` | Stable operation ID, 8 to 80 letters/digits/underscores/hyphens |
| `archivePath` | Absolute path to the approved own ZIP |
| `size` | Exact archive byte count |
| `sha256` | Lowercase SHA-256 |

The tool refuses an existing mod/directory name, an already tracked archive or
any metadata match. Reuse the existing tracked/native workflow for those cases;
renaming a package is not a recovery procedure or permission to replace a mod.

Installation imports the ZIP once, checks the imported copy, then calls native
`start-install-download` with `allowAutoEnable:false`. Original and imported
archive generations remain pinned. An awaited native hook rechecks context,
sources and metadata before installation. It rejects foreign installs/removals
and prevents a later metadata match from reaching native replacement selection.

Success returns the exact `modId` and `downloadId`, an installed-record check,
`enabled:false`, and a count of payload files whose staged hashes were verified.
Existing mod records and all profiles must remain unchanged. The original
operation intent covers both native stages.

After success, review the mod's resources and priority, then use the existing
`set_mods_enabled` / reviewed enable plan and one final `deploy_mods`. Verify
deployment owners, protected bytes and staging/game hardlink identity separately.
An installation receipt is not deployment or gameplay proof.

For several new own ZIPs, use the existing
[reviewed plan](NO-RESTART-WORKFLOW.md): exact install steps first, then explicit
activation and at most one final deploy. Each step retains its original receipt.
An uncertain installation stops later installs, activation and deployment; inspect
the original attempt before preparing any remaining work.

The CLI fallback uses the same tool and credentials:

```powershell
node tools/modding/vortex-agent/bridge.mjs --call read_local_install_readiness '{}'
# Pass the reviewed JSON arguments to --call install_local_archive.
```

## Progress and waiting limits

While the call is running, call `reconcile_operation` with its original request
ID to read `installDiagnostics`. Poll at most once per second. The observation
includes the current phase, `waitReason`, elapsed milliseconds, remaining budget,
exclusive `phaseTimes` and metric call counts/durations. Nested metrics overlap;
do not add them together as total installation time. Diagnostics contain fixed
labels and numbers, without raw host state or authenticated URLs.
Context-check counts include inexpensive preparation checks as well as full
process checks. They are not a count of PowerShell invocations. Fresh process
checks remain at native effect/permission boundaries and before completion
publication; no earlier observation of process absence is reused.

The work budget is 240 seconds, starting after the mutation lock is acquired
(the lock itself waits at most 30 seconds). Host/source and metadata waits are
capped at 30 seconds each; native callbacks at 120 seconds each. Every wait also
uses the remaining work budget. The bridge transport allows 300 seconds.
Synchronous file/process checks cannot be interrupted by a JavaScript timer;
the budget is checked at operation boundaries. Durable receipt finalization is
not canceled or raced against a timeout.

Success and guarded failures include a final diagnostic snapshot. Reconciliation
reports `installDiagnosticsSource` as `live`, `retained` or `unavailable`, with
separate `diagnosticsIssues`. A small immutable `.diagnostics.json` sidecar may
retain the final observation alongside the original receipts. Missing or corrupt
diagnostics do not invalidate a completion, prove success, clear an interlock or
authorize a retry. Older operations remain valid without diagnostic records.
Before the attempt exists (including lock contention), diagnostics are unavailable.
An unavailable observation does not mean Vortex is idle or the operation failed.

## Refusal or lost response

Keep the original request ID and call `reconcile_operation`. It reports matching
download records, the expected mod's observed state and the original receipts.
It never clears the interlock or replays installation. A native timeout does not
cancel Vortex. Failed/uncertain native work remains held, including its in-memory
guards, until explicit reconciliation and an authorized restart when needed.

`nativeMayContinue:true` means the adapter cannot rule out native work after
losing acknowledgement; it does not report current native activity. If completion
was already published but marker cleanup failed, the error is
`COMPLETION_PUBLISHED_CLEANUP_PENDING`. Inspect the published completion and
remaining markers; the adapter does not manufacture a contradictory failure.

Do not replay with another ID, change the workspace or delete a marker. A
pre-effect refusal can be corrected without pretending a native attempt ran.
Coordinate other chats and manual Vortex work during managed operations; this
tool does not claim atomic protection against arbitrary outside writers.

## Verify while the ordinary Vortex host is stopped

Use the native fixture when an unresolved collection operation makes launching
the ordinary profile unsuitable. The fixture starts the official Vortex
executable with isolated user data, a synthetic game and a separate authenticated
MCP listener on port 3702. The game executable in the fixture is a text
placeholder. The runner never opens the ordinary profile.

Start from the already verified adapter build in a separate workspace. Set
`NEXUS_WORKSPACE` to that build workspace and obtain the exact official Vortex
executable SHA-256 and installed Cyberpunk Support folder and index digest from
the reviewed local package and admission records. Then run:

```powershell
node tools/modding/vortex-agent/native-fixture.mjs --run --stopped-ordinary `
  --ordinary-workspace $ordinaryWorkspace --ordinary-manifest $ordinaryManifest `
  --vortex-exe-sha256 $vortexExeSha256 --support-extension $supportExtension `
  --support-index-sha256 $supportIndexSha256 --mcp-local-archive --with-existing-mod
node tools/modding/vortex-agent/native-fixture-verify.mjs $fixtureRoot
```

Supply the absolute ordinary deployment-manifest path and the workspace holding
the unresolved operation. Keep the fixture and ordinary workspaces disjoint.
The runner checks the admitted app.asar and support source, confirmed stopped
state and inactive ordinary MCP port before and after launch. It samples the
fixture process identity during the run and compares the ordinary unresolved
operation and deployment manifest against their initial file pins. Leave any
failure receipt in place for inspection and close a remaining fixture only
through its verified native shutdown path.

For a coordinated own-archive plan, add `--own-local-plan`. For modeled
collection candidate assessment on the stock host, use
`--candidate-assessment` instead. These exercise disposable fixture data. They
do not establish installation, deployment or Done acceptance for the user's
collection.

On 2026-11-16 the adapter bundled for source release 0.9.0 passed the
stopped-ordinary fixture on official Vortex 2.9.1 with Cyberpunk Support 0.13.2.
Authenticated health, local install readiness and collection-session readback
succeeded. One ZIP was installed disabled, enabled and deployed, then disabled
and restored. A separate two-ZIP plan installed both disabled and used one final
deployment. The independent verifier checked the deployed owners, hashes,
hardlink identities, rollback, eleven durable completion records and clean
fixture shutdown. The ordinary deployment manifest and unresolved R13 marker
retained their file identity and bytes. The single tiny ZIP took 5.6 seconds
inside the guarded installer. The ordinary collection and Nexus downloads were
outside this run.

A separate run passed candidate assessment for compatible records, exact
conflicts, installer choices, ignored conflicts and pending profile changes.
The verifier confirmed the assessment preserved fixture state. During the run,
the process monitor resamples only a proven change within the owned fixture
process tree. Unrecognized processes or unverifiable identities fail the check.

## Verify official Vortex 2.10.1

The 2.10.1 admission manifest pins the signed Windows release installer,
the matching installed executable and ASAR, and the reviewed file closure
of all 122 bundled extensions. Cyberpunk Support 0.13.3 has separate pins.
The original 2.9.1 manifest still applies to that exact version.

The fixture can run alongside an ordinary Vortex instance. Use the same
fixture command with `--host-version 2.10.1` in place of
`--stopped-ordinary`, supply the exact 2.10.1 executable and support pins,
and omit `--ordinary-manifest` so the runner reads the active manifest path
from authenticated ordinary health. Keep the build in a separate workspace.
The runner independently compares the ordinary process cohort, profile, mod
inventory, deployment manifest, and unresolved operation if one exists.

The 16 November 2026 official-host run installed a synthetic ZIP disabled,
refused a duplicate, enabled and deployed it, then restored the original
bytes and hardlink identity. A two-ZIP plan kept both new mods disabled until
activation, deployed once and restored both original files. The independent
verifier confirmed eleven durable completions, matching deployed owners and
clean fixture shutdown. The ordinary active collection, deployment manifest
and unresolved operation marker were preserved.

The native dialog read identified a startup error outside the reviewed
installation questions and left its queue intact. The official 2.10.1
collection wizard and prompt transitions still require live acceptance.

On 2026-11-21, the stopped-ordinary mode also passed on official 2.10.1 with
no pending ordinary operation. The verifier checked authenticated profile, mod,
download, lifecycle and fingerprint reads before activation. Stock Vortex writes
the local `installed.gameId` and `installed.modId` association on the download
record after installation. Completion accepts that association only for the
verified installed mod and continues rejecting Nexus metadata.

The built HTTP dialog test can use the official 2.10.1 installation as its
source pin. Set `VORTEX_NATIVE_DIALOG_2101_APP_ASAR` to its `resources/app.asar`
and run `node --test tools/modding/vortex-agent/wire.test.mjs` with the built
artifact and prepared vendor tree. This test exercises modeled Cancel, Ignore
and Update current profile callbacks through the compiled MCP and its receipts.

## Verify official Vortex 2.11.0

The [2.11.0 admission manifest](../tools/modding/vortex-agent/stock-vortex-2.11.0-admission.json)
applies to own-local Cyberpunk ZIP installation. It pins the signed Windows
release installer, exact executable and ASAR, and the reviewed executable
closures for the official bundled extensions. Cyberpunk Support 0.13.3 retains
its reviewed bytes. The manifest also covers the exact installed Unity 1.0.7
and Far Cry 6 1.2.4 extensions, whose installers and relevant listeners are
scoped to their own game IDs. An unlisted extension or changed source refuses
installation. Collection controls retain their separate version scope.
See [native questions](NATIVE-DIALOGS.md) for 2.11.0 dialog admission and the
optional paired Cancel probe.

Use the paired fixture command above with `--host-version 2.11.0` and the
executable and Cyberpunk Support pins from the new manifest. The independent
verifier binds the fixture to the reviewed executable, ASAR and source
manifest, then checks disabled installation, deployment and restoration.

The 23 November 2026 paired run on the official 2.11.0 host verified one-ZIP
and two-ZIP plans, collision refusal, eleven durable completions, deployed
hardlinks and restoration of original files and identities. The fixture
closed normally. The ordinary active profile, mod projection, process
cohort and deployment manifest were preserved.

## Verification boundary

On 2026-11-03, an isolated instance of official Vortex 2.9.1 passed:

- direct native `start-install`, confirming Doodlebot's underlying event approach;
- the actual bundled MCP tool: import, disabled installation, enable/deploy and
  disable/deploy, checked through bytes, manifest ownership and hardlink identity;
- preservation of an existing disabled mod's record, all profile flags, staged
  bytes and file identity, plus collision refusal before effects;
- five durable completions, clean fixture exit and unchanged ordinary Vortex
  profile/mod inventory/deployment manifest/process identity.

The synthetic direct install took about 0.22 seconds. The curated import/install
request in the initial empty fixture took about 6.3 seconds including its guards.
These are individual tiny-fixture observations, not collection benchmarks.
No real collection install, Nexus update, interactive installer or gameplay
acceptance is established by those tests.

The adapter's legacy `install_download` remains disabled. `health.installSupported`
retains that general-install meaning; use `read_local_install_readiness` for this
narrower capability. Source release, native extension activation and client tool
rediscovery are separate checks.
