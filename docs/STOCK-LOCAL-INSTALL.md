# Install a new local ZIP through MCP

`install_local_archive` installs one new own-local Cyberpunk ZIP through the
official Vortex installer. It leaves the mod disabled and does not deploy it.
The extension stays installed; agents do not generate a temporary plugin or
restart Vortex for each mod.

This path supports the reviewed **official Vortex 2.9.1** package and extension
sources. It does not require a Vortex fork, application patch or UI automation.
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
| `requestId` | Stable operation ID, 8–80 letters/digits/underscores/hyphens |
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

The CLI fallback uses the same tool and credentials:

```powershell
node tools/modding/vortex-agent/bridge.mjs --call read_local_install_readiness '{}'
# Pass the reviewed JSON arguments to --call install_local_archive.
```

## Refusal or lost response

Keep the original request ID and call `reconcile_operation`. It reports matching
download records, the expected mod's observed state and the original receipts.
It never clears the interlock or replays installation. A native timeout does not
cancel Vortex. Failed/uncertain native work remains held, including its in-memory
guards, until explicit reconciliation and an authorized restart when needed.

Do not replay with another ID, change the workspace or delete a marker. A
pre-effect refusal can be corrected without pretending a native attempt ran.
Coordinate other chats and manual Vortex work during managed operations; this
tool does not claim atomic protection against arbitrary outside writers.

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
