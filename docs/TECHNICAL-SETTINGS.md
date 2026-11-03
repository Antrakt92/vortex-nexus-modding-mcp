# Compare source-bound Vortex settings

`tools/modding/vortex-agent/technical-settings.cjs` is an offline, pure comparison
module for a reviewed native helper or release preflight. It performs no reads,
writes, network calls or Vortex dispatches. It does not grant permission to switch
profiles, change preferences or activate a helper.

```javascript
const settingsPolicy = require('./technical-settings.cjs');
const result = settingsPolicy.compare(beforeSettings, afterSettings, {
  appAsarSHA256: independentlyVerifiedAppAsarSHA256,
});
// result: { equal: true, changedTimestampPaths: [...] }
```

The caller must supply the freshly verified Vortex application source pin. A
copied constant or version label is not independent source verification. Unknown
pins fail closed with `UNSUPPORTED_SETTINGS_SOURCE`. Both snapshots must contain
all eight admitted tools and finite, nonnegative safe-integer timestamps.
Missing nodes, missing timestamps, malformed data and non-JSON values outside the
explicit discovery exception below fail with
`INVALID_TECHNICAL_SETTINGS`. Other differences fail with
`TECHNICAL_SETTINGS_CHANGED`. Errors contain no settings values.

`normalize(settings, options)` returns a new comparison projection. Never write
it back to Vortex, persist it as the full settings baseline, or use it instead of
retaining the original baseline. It omits these exact timestamp leaves:

| Game | Tool under `gameMode.discovered.GAME.tools.TOOL.timestamp` |
| --- | --- |
| assassinscreedunity | assassinscreedunity-customlaunch |
| cyberpunk2077 | REDprelauncher.exe |
| cyberpunk2077 | V2077-game-exe-modded |
| cyberpunk2077 | V2077-tools-redMod |
| farcry6 | farcry6-customlaunch |
| farcry6 | farcry6-modinstaller |
| farcry6 | farcry6-savemanager |
| witcher3 | witcher3_DX12 |

For those same eight tool objects only, an own enumerable data property
`hidden: undefined` compares as an absent property. Explicit `hidden: false` or
`hidden: true` is retained and remains strict; changing between absence and either
boolean still fails. Accessors, non-enumerable properties and undefined values at
any other path still fail. Paths are matched by components, not joined strings.
This exception affects only the comparison copy and never edits native settings.

All other settings remain strict, including tool paths/arguments, user
preferences, all profile pointers, other games' settings, unknown tools and
unknown timestamp fields. The exported `paths` and `source` records are frozen;
there is no caller-supplied wildcard or ignore list. Key order is immaterial;
array order and values are compared strictly. The JSON validator rejects
accessors, hidden/symbol fields, cycles, sparse arrays and values that JSON
serialization would omit or coerce, except the eight undefined discovery fields
described above.

## Source and admission boundary

The policy preserves the eight-path admission from the reviewed
`tool-timestamps.cjs` recovery module (SHA-256
`a50d4f9f8da135e214542ef89dd970c3c38c569dd2a4ae7b12c4cac43cb7b0a7`).
That review bound the application archive to SHA-256
`ec3a29d58ea65a1ca84e456742c894a19efe96920a6710063d221d451a26d59a`.
Its source-map evidence identifies:

- Startup: `417-index.ts:925-971` to `399-GameModeManager.ts:281-296`.
- Rediscovery: `425-discovery.ts:464-508,525-553` to
  `399-GameModeManager.ts:596-606`.
- Settings reducer: `421-settings.ts:82-104`.

Vortex rediscovery refreshes these timestamps. They also affect custom tool UI
ordering; they are not universally disposable metadata. The admission covered
the observed eight refreshes with all other settings and full profiles equal.
This reusable implementation strengthens input validation and requires the
source pin explicitly. It does not establish that every deployment on every
Vortex version has harmless settings churn. Extending the path list, accepting
missing tools or supporting another source pin needs fresh source and snapshot
review, plus negative regression coverage.

On 3 November 2026, a native descriptor-only capture found exactly eight new
own enumerable `hidden: undefined` properties at the listed tools, with valid
unchanged-shape timestamps and no other JSON-shape failures. The saved baseline
had no own `hidden` properties. Installed source explains the difference:
`403-settings.ts:35-40` supplies the discovery result without an outer visibility
field; `421-settings.ts:100-104` assigns
`hidden: payload.hidden || old.hidden`, which can produce an own undefined field.
The exact embedded source SHA-256 pins are respectively
`20a5789912b14894951932cdd6990b95240374047e3d5ef9615ca727f43afe7a` and
`8ad122e6f9fba490bd0d91a6929590c976b019e3ba6a8995581fedf8d75b4488`.
The application archive pin above remains mandatory. This observation admits
only those eight fields; it is not a general undefined-value filter.

Profile-switch pointer changes need the task's separately reviewed policy before
this comparison; this module never masks those pointers. A helper whose freeze
guard also checks settings must use the same admitted policy at each comparison
boundary. Updating one guard while leaving another full-settings digest strict
can reproduce a false block. Retain full original digests for provenance;
do not compare a full digest with a projected digest or reinterpret a previously
failed receipt as success.

The existing [single-package helper preparer](NATIVE-HELPER-PREPARATION.md) has
no supported settings-policy integration point. It is unchanged. A reviewed
task binder that consumes this module must copy and pin it with the other runtime
modules, update its exact materialization map, and run its own code-contract
checks. Existing attempted/completed helpers stay frozen. This module is not a
new permanent adapter endpoint and does not require a host restart or install.

```powershell
node --test tools/modding/vortex-agent/technical-settings.test.cjs
```

These checks prove pure comparison behavior only. No native host load, live
settings acceptance, deployment or gameplay claim follows from them.
