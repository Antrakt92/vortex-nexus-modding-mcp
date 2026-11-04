# Read native preflight observations

Adapter 1.1.0 adds `read_native_preflight`. It reads the active context, native
deployment-target table, actual application version, updater state and a bounded
extension lifecycle projection. It does
not install mods, change settings, check for updates or restart Vortex.

```powershell
node tools/modding/vortex-agent/bridge.mjs --call read_native_preflight '{}'
```

The MCP input is exactly `{}`. Extra fields are refused. The permanent extension
must contain the new tool; source edits or a provenance-only sync do not load it.
After one verified adapter upgrade, these reads need no temporary extension or
host restart. A client with an older tool list can use the bridge command and
refresh its MCP discovery separately.

## Returned observations

- `context`: active game/profile, canonical game/staging/download paths and their
  filesystem identities, using the same Node `dev:ino` format as health.
- `appVersion`: `{available:true,value:...}` from the application's native getter.
  The static `health.targetVortexVersion` field is not a live version observation.
- `deploymentTargets`: up to 32 `{typeId,path,sameAsDefault}` entries. The default
  type ID is the empty string. Preserve aliases: ENB and DInput can name the same
  game directory even when no installed mod uses those types. Equal paths do not
  establish ownership, source admission or permission to install.
- `updater`: `{available:true,state,sequence}` from its native status getter.
  Only the fixed state and sequence are returned; messages, release notes, URLs,
  release payloads and history are omitted.
- `staging`: metadata for the fixed `__vortex_staging_folder` file. A missing tag
  reports `nativeInitializationRequired:true`: Vortex normally waits for an
  initialization dialog for an existing untagged folder. Use `list_dialogs` to
  inspect actual pending dialogs; this prediction does not prove one is open.
  A present tag leaves initialization unknown (`null`), since contents and
  ownership are not inspected. `readinessVerified` is always `false`.
- `extensions`: complete, bounded `stateRows` from `app.extensions` and
  `loadedRows` from `api.getLoadedExtensions()`. State rows contain the exact
  `stateKey` and only `path`, `version`, `enabled`, `remove` and `bundled` cells.
  Cells distinguish `{present:false}`, `{present:true,type:"undefined"}` and
  `{present:true,value:...}`. Loaded rows contain the effective `name` as
  `effectiveId`, plus path and dynamic cells. Static built-ins may lack a path.
  Descriptions, authors, extension callbacks, arbitrary `info` and account data
  are not read or returned.

  `pendingRemovalKeys` names every own `remove:true` entry, including orphan
  entries without a path. `pendingRemovalCount:0` is returned only with
  `available:true,complete:true`; missing APIs/data, unsafe values, more than
  1,000 state or loaded rows, or observed drift return
  `available:false,complete:false,code:...,pendingRemovalCount:null` without rows
  or a manufactured empty queue. Defined non-boolean removal flags are invalid.
  Metadata fields use own enumerable data descriptors; getters and proxies are
  refused. Extension IDs are limited to 192 characters, paths to 1,024 and
  versions to 80. Unknown shapes are incomplete observations, not omissions.

  The source-reviewed lifecycle distinguishes persisted state keys from loaded
  effective IDs (`info.id || folder basename`). Do not replace either with the
  other. This read does not scan extension folders or parse `info.json`: join a
  separately verified disk census before assessing task-helper ID/path collisions.
  Duplicate loaded IDs are retained. The application updater observation is
  separate from this extension removal queue.

The fixed native calls are `window.api.app.getVersion()` and
`window.api.updater.getStatus()`. Each has a two-second wait budget and an explicit
deadline check. Late rejection is observed; the tool never retries a getter.
JavaScript event-loop blocking can delay timer delivery, so this is not a
hard real-time guarantee.

Context and the complete canonical target table are sampled again after awaits.
The curated extension projection is sampled before and after those awaits;
changes report `NATIVE_PREFLIGHT_EXTENSIONS_CHANGED` and overall `partial`.
Transient changes between samples are not excluded; this is not an atomic snapshot.
Drift refuses the entire observation. A missing, rejected, malformed or timed-out
getter produces `{available:false,code:...}` and overall `status:"partial"`.
Missing updater data never becomes `idle`; missing version data never becomes the
static health label. Unsafe target tables refuse rather than silently omit rows.

## Limits

`status:"ok"` means the requested metadata was available and matched the final
samples. It does not mean a lifecycle operation is approved. In particular, an
observed `staged` updater needs review before a separately authorized shutdown.
An observed missing staging tag can therefore accompany `status:"ok"`. An unsafe,
unreadable or changing tag reports `tagStatus:"unknown"` and `status:"partial"`.
The tag is sampled before and after native calls without reading its contents,
creating files or answering dialogs. Initialization of a real staging folder
requires its own reviewed native workflow.
The response always states:

```json
{
  "snapshotAtomic": false,
  "nativeEffects": false,
  "shutdownPermit": false,
  "sourceAdmissionVerified": false
}
```

These are point-in-time observations, without a queue lease or ownership lock.
An empty extension removal queue does not rule out duplicate-ID retirement during
startup, prove all extension changes absent, or grant permission to restart.
Readonly extension projection has no application ASAR/version admission gate;
each native write retains its separate source and host requirements.
The tool does not hash payloads or inspect arbitrary target directories. A native
capture still needs fresh source, physical baseline, process/root/temp identity
and independently reviewed exact target bindings. See the
[capture contract](READ-CAPTURE-PREPARATION.md) and
[authorized restart procedure](AUTHORIZED-RESTART.md).

## Local verification

Run the producer and serialization tests, then the built HTTP/stdio wire tests
and package-provenance checks. The wire fixture supplies its own native window;
only a call through the installed Vortex adapter establishes runtime availability.
Test coverage includes foreign-realm plain objects, hostile descriptors/proxies,
all updater states, withheld private fields, timeouts and context/map drift.
