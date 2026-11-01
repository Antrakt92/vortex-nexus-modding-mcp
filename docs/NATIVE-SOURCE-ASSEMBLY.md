# Assemble the reviewed Vortex source patches

`native-source-series.mjs` applies the fixed sequence of 95 reviewed patches to
25 original files from Vortex `v2.9.1`, commit
`c80326367cbe6d96621ad6cf4a5488ef49bac110`. It replaces manually composing separate
patch chains before compilation. It does not change an installed application or
make native installation available through MCP.

## Inputs and result

Import the function from `tools/modding/vortex-agent/native-source-series.mjs`.
Pass a plain or null-prototype object whose keys are exactly
`NATIVE_SOURCE_PATHS` and whose values are original `Buffer` or `Uint8Array`
bytes. Obtain those bytes from an independently verified official source export;
the function does not discover or read an application installation.

```js
import fs from 'node:fs';
import path from 'node:path';
import {
  assembleNativeSources, NATIVE_SOURCE_PATHS,
} from '../tools/modding/vortex-agent/native-source-series.mjs';

const originals = Object.fromEntries(NATIVE_SOURCE_PATHS.map(file => [
  file, fs.readFileSync(path.join(verifiedSourceRoot, file)),
]));
const {sources, receipt} = assembleNativeSources(originals);
```

The library copies all input bytes before reading its fixed patch packet. It
rejects accessors, proxies, extra keys, shared/resizable backing stores and
inputs exceeding 2 MiB per file or 8 MiB in total. Original, intermediate and
final source hashes, patch/manifest hashes and cross-file prerequisites must
match the pinned series. Patch application requires exact offsets and context;
it has no fuzzy matching or hash-refresh mode.

The fixed graph combines the 33-patch mod-management/transfer packet with the
62-patch persistence packet. The latter includes renderer target admission and
acknowledged diffs, main/preload/shared IPC, backend reservations and managed SQL
ownership, the main build's runtime binding and startup history classification.
Both runtime packet directories have separate closed inventories;
test-only adapters are excluded. A cross-file companion must already have been
applied with its exact patch and intermediate output hashes. Cross-packet
companions name one of the same two fixed packet IDs; they cannot add a source
root. The series manifest is bounded to 96 KiB before opening its contents.
Later patches may
then advance that companion source to its pinned final output.

The result contains a frozen source map and deeply frozen receipt. Reading a
source property returns a fresh mutable byte copy; changing it cannot change
another read or the retained result. The library performs no output writes,
compiler invocation, registration, event dispatch or installation.

## Compilation remains a separate gate

An assembly receipt records `preparedOnly:true`. Its `nativeAdmission`,
`effectsAllowed`, `typecheckVerified`, `nativeAcceptanceVerified` and `installed`
fields remain false. An exact source hash is neither a successful typecheck nor
native runtime acceptance.

The series includes three compatibility repairs found by the full renderer
typecheck: accept Bluebird through `PromiseLike` in the private add-mod result
and purge-operation signatures, and convert an unknown deployment rejection with
the existing `unknownToError` helper before notifying its callback. The first two
changes affect only types. The last preserves the recorded original failure and
the callback's at-most-once behavior.

Use a complete isolated official workspace, its pinned package manager and frozen
dependency graph for compilation. Build the renderer's workspace prerequisites,
then run its actual TypeScript and webpack targets without changing compiler
options or substituting declaration stubs. Bind the check to all ten resulting
source hashes. Preserve baseline errors separately from errors introduced by the
patch series. Never use an installed Vortex directory as the build output.

Keep dependency materialization separate from execution. In pnpm 11,
`verifyDepsBeforeRun` can automatically invoke an install; explicit installation
flags do not automatically constrain a later invocation. Inherit reviewed pnpm
settings in nested build commands and fail on unexpected dependency drift. An
install with scripts disabled does not mean a later automatic install also has
scripts disabled. Retain any failed attempt and its reason before retrying.

For pnpm 11, general inherited settings use the `pnpm_config_` prefix. Keep
`pnpm_config_ignore_scripts=true` and
`pnpm_config_verify_deps_before_run=error` in nested build commands. The pinned
11.10.0 checker also fails when both hook lists are undefined after an
`--ignore-pnpmfile` install. If independently verified hook/config candidates are
absent, a normal explicit frozen install with scripts disabled lets pnpm record
its own empty hook list. Do not edit its state metadata or disable dependency
verification to conceal this failure.

The packet's file-generation checks detect observed changes. They do not lock
the complete workspace against another writer. Hashes identify the pinned
inputs; they are not signatures or protection from a process that can rewrite
the library itself.

## Local checks

```powershell
node --test tools/modding/vortex-agent/native-source-series.test.mjs
$env:VORTEX_NATIVE_SOURCE_ROOT = 'C:/Task/verified-original-source'
node --test tools/modding/vortex-agent/native-source-series.test.mjs
```

The first command covers portable input and packet checks. The second also
exercises exact original-source assembly and output isolation. The fixture root
must contain all 25 original files, not their patched replacements. Earlier
partial fixtures are incomplete for this graph and are refused.
Neither command proves compilation, host loading or a successful mod install.

## Renderer qualification — 31 October 2026

The original complete official workspace passed its dependency-aware renderer
typecheck and webpack build. Applying the first 17 patches exposed the three
type errors above. The complete 20-patch series then passed the same targets:

```text
pnpm exec nx run @vortex/renderer:typecheck --skip-nx-cache
pnpm exec nx run @vortex/renderer:build --skip-nx-cache
```

The check used Node 24.20.0, pnpm 11.10.0, TypeScript 6.0.3 and webpack 5.108.4.
The official lockfile and compiler configuration were unchanged. Both targets
built their seven prerequisite tasks. All six final source hashes matched both
the actual TypeScript Program and webpack's source-map contents. The adapter's
combined local suite passed 843 tests without failures or skips; the primitive
deployment rejection regression failed before its repair and passed afterward.

These are renderer compilation checks in an isolated source export, using the
upstream default development build. They do not qualify a signed application
package, native addon ABI, main-process startup, installed-host loading or mod
installation. No application was started or replaced. The official source
workspace's dependency audit also remains separate: its pinned graph reported
210 advisories, including six critical records, during this qualification.
Successful compilation does not resolve those advisories or establish runtime
safety. Source receipts therefore continue to leave native admission disabled.

The subsequent 21-patch series adds
[startup cleanup ownership](NATIVE-STARTUP-CLEANUP.md). It passed the same
dependency-aware TypeScript and webpack targets with unchanged official
configuration and lockfile. All six final source hashes again matched the actual
Program and webpack map contents. Its combined adapter suite passed 850 tests
without failures or skips. The installed archive still matches the six official
original sources; none of these prepared application changes is loaded there.

## Transfer packet — 31 October 2026

The 28-patch / ten-source graph adds joined staging transfer callbacks,
exclusive copy collision refusal, cleanup-error preservation, staging Settings
ownership/context checks and report-only interrupted-transfer warnings. The two
download warning/cleanup patches are included in the exact runtime packet. The
separately pinned upstream test adapter remains outside that packet.

The expanded graph passed the actual renderer TypeScript and webpack targets
with the original compiler configuration and lockfile unchanged. All ten final
source hashes matched both the TypeScript Program and webpack source-map content.
This qualifies the renderer source build; it does not qualify main/preload
rebuilds, installed loading or native installation.

The six upstream transfer tests passed with a separately pinned mock adapter for
Node's copyFile callback. The original mock lacked that export and two tests
failed before the adapter. All original bytes and assertions are preserved
outside its fs-mock insertion. The source-backed callback suites passed 55 tests;
two additional checks verify the test adapter's pins and insertion-only boundary.
The TypeScript wrapper could not print Unicode to its CP1252 console after
writing its successful compiler result; that failed wrapper attempt was retained.
No compiler configuration or expectation was relaxed. See
[transfer bounds](NATIVE-STAGING-TRANSFER.md).

## Downloads Settings owner — 31 October 2026

The 29-patch / ten-source graph adds whole-operation ownership to Downloads
Settings after the destination-cleanup safeguard. It captures the global download
pattern and resolved paths before normalization, checks context/marker readback,
and joins the returned transfer, tag, elevation and reporting tails. The original
telemetry wrapper is source-tested; diagnostic failures cannot release started
work early or replace its primary failure.

All 18 new source-backed cases passed, together with the previous 55 transfer
cases. The exact graph passed its 14 checks. The full renderer TypeScript and
webpack targets passed with unchanged compiler configuration/lock, and all ten
final source hashes matched the actual Program and bundle map. Only Downloads
Settings changed from the qualified 28-patch renderer. The unchanged upstream
transfer tests retain their separately recorded six-case acceptance.

This is source/build qualification. Native child completion, physical custody,
main persistence acknowledgement, background download writers and installation
remain separate gates. The installed Vortex application was not replaced.

## Persisted transfer admission — 31 October 2026

The 30-patch / ten-source graph checks persisted transfer markers in
every registered install manager before reserving native exclusion and when
checking an issued owner. An unresolved or unreadable marker refuses admission.
Uncertainty observed after reservation permanently invalidates that owner;
clearing a marker cannot revive it. Reentrant state reads also preserve this hold.
See [manager exclusion](NATIVE-MANAGER-EXCLUSION.md).

All 13 marker regressions, 13 existing manager tests and 15 source-graph checks
passed without skips. Independent review reproduced and verified the repair of
a nested state-read case that previously allowed its outer check to return.
The final source passed actual TypeScript and webpack targets with unchanged
compiler configuration and lockfile. All ten final sources matched both the
TypeScript Program and renderer source map. The earlier build of the defective
draft was retained as superseded, not used as final acceptance.

These checks qualify prepared renderer source only. They add no marker reset,
owner release, native dispatch, registration, filesystem custody or installation
permit. The installed Vortex application remains unchanged.

## Complete source recipe — 31 October 2026

The 49-patch / 22-source graph includes both runtime packets. Prerequisites may
cross source files within a packet: for example, event-handler ownership depends
on an earlier InstallManager bridge. Their exact patch hashes and application
order are checked separately from each source's input/output chain. Test adapters,
SQL data files and unchanged build-control sources are not patched runtime nodes.
The original ten-file fixture is retained as historical input; it must
not be silently mixed with already-patched sources to satisfy the larger graph.

Every final modified source is byte-identical to its previously qualified
Program input: 12 renderer, seven main, one preload and two shared sources.
Twenty appear in runtime source maps; the two shared type-only files do not.
The prior qualification also observes the unchanged renderer `stateDiff.ts`.
All 19 assembly tests passed with the 22 original files supplied, without skips.
They include independent exact patch application, legitimate cross-file
prerequisites, intermediate companion outputs, rejected missing/changed/additional
packet entries and a Git CRLF-to-LF roundtrip across both packets. The combined
assembly and managed SQL/source-intake suite passed 69 tests without skips.

This comparison binds the assembled bytes to the existing checks, not to a new
complete build. Those checks retain their original execution scope and dates;
the assembly receipt continues to report `typecheckVerified:false`.

Before packaging or host acceptance, build the selected complete candidate with
its actual native dependencies and qualify its startup and lifecycle behavior.
A deterministic source recipe does not establish native module compatibility,
registration, release or a successful installation.


## Passive store binding — 31 October 2026

The 51-patch / 23-source graph adds passive Redux store binding and its actual
renderer startup call. It reuses the prior runtime packets and fixed companion
checks. The source tests cover safe startup refusal, real enhanced Redux stores,
descriptor/root drift and reentry without a repeated collection traversal.
The combined store-binding, assembly and managed SQL/source-intake run passed
103 cases without failures or skips.

The composed renderer passed the actual TypeScript and webpack targets with all
eight compiler/build configuration and lockfile pins unchanged. Fourteen renderer
sources matched the new Program and runtime map, including the unchanged
state-diff control. Ten main/preload/shared inputs retain their separate unchanged
baselines. All 23 graph outputs match the qualified source tree. This is a
renderer development-build check; the main/preload/shared targets were not rerun
and no installed application was changed. See the [store-binding boundary](NATIVE-ADOPTION-BOUNDARY.md#renderer-target-fence).


## Main initialization readiness — 31 October 2026

The 52-patch / 23-source graph adds the production main readiness attempt after
query-owner binding. The current SQL fixture initializes through the actual
production entry. Exact predecessor controls reproduce late-init rebinding and
stale factory adoption; the repaired generation/captured-backend checks prevent
both. Passive observers settle on invalidation without canceling raw SQL work.

The combined source suite passed 122 cases without skips. The actual main
TypeScript target, direct build and 52 upstream unit cases passed with unchanged
compiler configuration and lockfile. Seven main inputs matched the new Program
and main runtime map. Seventeen renderer/preload/shared inputs retain their prior
unchanged baseline; those targets were not rebuilt. All 23 graph outputs matched
the qualified tree. No installed application was changed and no readiness result
grants queue, SQL, filesystem or installation authority. See the
[readiness contract](NATIVE-ADOPTION-BOUNDARY.md#main-initialization-readiness).


## Renderer and manager startup readiness — 31 October 2026

The 55-patch / 24-source recipe adds ExtensionManager's exact load-attempt
observation, the renderer producer call and the specific mod-management once
completion. Manager startup belongs to the lifecycle packet; the ExtensionManager
and renderer producer layers belong to persistence. Their fixed inventories now
contain 31 and 24 patch pairs respectively. No packet discovers optional scripts.

Nineteen new source-backed cases passed, including exact predecessor controls and
actual APIProxyHandler/Bluebird doOnce behavior; the combined run passed 141 cases
without skips. Controlled external dependencies and prototype fixtures do not
establish full ExtensionManager construction or native startup. The actual renderer
TypeScript and webpack targets passed with unchanged configurations/lockfile.
Fifteen renderer inputs matched the fresh Program/map; ten main/preload/shared
inputs retained unchanged baselines. All 24 graph outputs matched the qualified
tree. This adds no installed-host, global-idle, persistence-flush or installation
permit. See the [startup boundaries](NATIVE-ADOPTION-BOUNDARY.md#renderer-and-manager-startup-readiness).


## Source-bound core readiness observation — 31 October 2026

The 61-patch / 24-source recipe retains the actual static mod-management module
namespace from its existing loader result, adds gated access to its existing
manager and composes it with the fixed main/preload readiness observation. Packet
inventories contain 32 lifecycle and 29 persistence patch pairs. This adds no
second module load or publicly mutable extension-API authority.

The combined source suite passed 191 cases without skips. All four projects
passed their actual TypeScript and build targets, with 52 upstream Node tests
also passing. Fresh Programs contain all 25 selected inputs; new runtime maps
contain 23 (excluding the two shared type-only sources). Root independently
verified all 24 graph outputs, configuration/lock pins and six runtime output/map
hashes. Cold Electron/test adapters remained unchanged.

The source-level deadline counterexample is retained separately: a timer-only
renderer guard accepted after a 5010 ms event-loop stall. The repaired monotonic
guard rejects the late result while retaining one underlying logical operation.
These source/controlled-fixture checks do not qualify native IPC transport,
ExtensionManager construction or installed loading. Readiness replies keep all
native/installation authority false; see [observation scope](NATIVE-ADOPTION-BOUNDARY.md#core-readiness-observation).

## Isolated Electron IPC check — 31 October 2026

Three fresh Electron 44.2.0 SDK applications exercised the assembled main handler,
the upstream IPC wrapper/preload exposure and the renderer reply validator over
actual `ipcRenderer.invoke`. The owned primary window received the exact reply;
a second window was refused before waiting for backend readiness. During a
same-URL reload, the original main handler recorded its context refusal before
the retained readiness promise was completed; the new frame then received a
valid reply. All three cases passed, with zero mutation calls and normal app
exit. Their owned process jobs reached zero active processes before release.

The fixture used hidden windows, separate temporary profiles and the application's
`nodeIntegration:true` / `contextIsolation:false` preload branch. The SDK's 73-file
inventory matched its retained checksums. Backend readiness and persistence were
controlled facades: this checks native transport and frame invalidation, not full
Vortex startup, installed native modules, registration or installation. The
installed application was unchanged. Request filtering and a dead-loopback proxy
are fixture controls, not OS-wide network isolation.

## Renderer persistence hold — 31 October 2026

The 62-patch recipe adds an owned renderer flush-and-hold boundary. Its final
acknowledgement leaves later changes buffered until explicit release, instead of
immediately scheduling ordinary writes into a reserved main backend. The runtime
packets contain 32 lifecycle and 30 persistence patch pairs.

Twenty new source-backed cases passed, including the predecessor counterexample,
old-writer and callback reentry, bounded detached payloads, late timers and
release followed by immediate reacquisition. The combined affected suite passed
229 cases without skips. The actual renderer TypeScript and webpack targets
passed with all eight configuration/lock pins unchanged. Fifteen renderer inputs
matched the fresh Program and runtime map. Ten main/preload/shared inputs and
their unchanged outputs retain their previous qualification; those projects
were not independently rebuilt. All 24 assembled outputs matched the qualified
tree. Electron's npm SDK directory and path marker remained absent.

This is prepared middleware and development-build qualification. Restoring main
write availability before local release remains the coordinator's responsibility;
the hold does not implement registration, crash reconciliation or installation.
See the [hold contract](NATIVE-ADOPTION-BOUNDARY.md#renderer-persistence-hold).

## Owned registration write — 31 October 2026

The 64-patch recipe adds a one-shot owned Level registration method and its main
queue entry. Runtime packet inventories now contain 32 lifecycle and 32
persistence patch pairs. Only `LevelPersist.ts` and `ReduxPersistorIPC.ts` changed
from the qualified 62-patch source.

Twenty-two new source-backed cases passed; the combined affected run passed 251
without skips. Five separate real-LevelDB cases executed the actual patched Level
method: successful record/marker commit and reopen, existing target refusal,
disabled profile-reference refusal, rollback after an injected post-INSERT error,
and committed readback after an injected lost COMMIT reply. SQL-owner identity
was facaded in those native cases; full Singleton, main and renderer construction
were not exercised.

The actual main TypeScript target, direct build and 52 upstream Node tests passed.
Seven main inputs matched the fresh Program and runtime map; 18 other Program
inputs and their unchanged outputs retain their earlier qualification. All 24
graph outputs and eight configuration/lock pins matched. A private test-intake
adapter changed the upstream singleton mock from a plain object to a class shape
with an unavailable native checker that throws. All 31 Level test bodies and
assertions remained unchanged. Electron's npm SDK directory and path marker
remained absent.

This qualifies minimal database registration, not the complete tracked install.
Archive association, filesystem custody, renderer adoption, durable recovery and
release remain separate [registration gates](NATIVE-ADOPTION-BOUNDARY.md#next-implementation-gates).

## Tracked registration and renderer adoption — 31 October 2026

The 68-patch recipe extends the fixed Level/main registration path and adds
renderer adoption in the root reducer and persistence middleware. The runtime
packets contain 32 lifecycle and 36 persistence patch pairs. All 24 assembled
outputs match the qualified source tree.

The combined affected suite passed 291 cases without skips. Ten separate cases
ran the patched Level method against fresh own LevelDB directories: nominal
registration, matching optional download ID, changed metadata, an existing
installed marker, a disabled profile reference, duplicate download hash/name,
another mod's archive reference, rollback after INSERT, and a lost COMMIT reply.
The final case retained the committed rows while refusing replay. SQL ownership
was facaded; these cases did not construct the full Vortex runtime.

Main TypeScript, direct build and all 52 upstream tests passed. Renderer
TypeScript and webpack passed. Seven main and fifteen renderer sources matched
fresh Program and runtime-map inputs; three unchanged preload/shared Program
inputs retain their prior qualification. The total is 25 Program inputs and 23
runtime-map inputs. All eight configuration pins, the lockfile and both preload
outputs remained unchanged. Electron's npm SDK and path marker remained absent.

The initial main typecheck found four possibly undefined array indices. Guarded
local variables repaired them without changing SQL or compiler configuration;
the failed input and log were retained. The existing 22 registration cases and
54 renderer cases also passed against the newly composed runtimes.

This adds internal registration/adoption primitives. It does not establish
archive custody, a source-bound coordinator, crash recovery, hold release, two
sequential installs or installation through MCP. See the
[current contract](NATIVE-ADOPTION-BOUNDARY.md#tracked-registration-and-renderer-adoption).

## Successful registration release — 31 October 2026

The 75-patch recipe adds a successful tracked-registration release across query,
SQL pool, backend and main owners, then renderer persistence, root and manager.
Runtime inventories contain 33 lifecycle and 42 persistence patch pairs. Seven
runtime files change from the qualified 68-patch recipe; no new source file is
introduced into the application graph.

The combined affected suite passed 325 cases without skips, including 32 new
release/cycle cases. Two joined cases pass actual main results into the actual
Redux adoption path. The same component instances register and release two
different mods; the first record survives, committed records are not echoed,
and buffered settings are written once through the reopened main persistor.
Discarding a main release observation does not implicitly open renderer gates.
These cases model transport and database storage, not physical IPC or Vortex.

A separate native fixture executed the four composed main classes against a
real own LevelDB backend. Two registrations and releases used the same component
instances and connection; ten download metadata rows became 18 and then 26, and
fresh reopen preserved all 26. A real COMMIT followed by an injected lost reply
left 13 rows on reopen and refused release/replay. Backend SQL was real; pool
bootstrap and the five query-setup calls used controlled facades. This does not
qualify full native pool construction, physical renderer transport, a published
payload or power-loss durability.

Independent review found and repaired delayed-finalizer scheduling and
nonwritable-manager-field failures. Regressions require every gate to stay closed
when an armed timer expires, pending work appears without an armed timer, or any
of the three manager fields cannot be cleared. Main reentry and nonwritable-field
failures are also covered. No failed owner is reset to admit another operation.

Main TypeScript, direct build and 52 upstream tests passed. Final renderer
TypeScript and webpack passed. Seven main and fifteen renderer sources matched
fresh Program and runtime-map inputs; three unchanged preload/shared Program
inputs retain their earlier qualification. All 24 graph outputs, eight configs,
lockfile, test-intake pins and preload outputs matched. Earlier candidate inputs
and checks were retained separately. Electron's npm SDK and path marker remained
absent throughout qualification.

This qualifies internal successful release, not the full installation workflow.
The source-bound coordinator, physical staging/worker binding, durable terminal
reconciliation and installed application acceptance remain required. See the
[release contract](NATIVE-ADOPTION-BOUNDARY.md#successful-registration-release).

## Main executor anchor — 31 October 2026

The 78-patch graph adds three main-source changes for
[private executor-history storage](NATIVE-EXECUTOR-ANCHOR.md). A fixed KV is
excluded from ordinary hydration and mutation. An actual retained main/backend/
SQL reservation performs its strict CAS transaction and readback; it retains
the reservation for subsequent work. Failed or unknown writes stay held.

Canonical input checks now compare original bytes for the anchor and both
registration descriptor versions. The native driver was observed to strip a
leading BOM from VARCHAR results, so the anchor query transports bounded HEX
and validates reconstructed bytes instead. Ordinary NULL-key corruption retains
its prior visibility/error behavior rather than being hidden by the key filter.

The final main TypeScript target, Rolldown build and 52 upstream tests passed.
Seven main Program/map entries matched the final sources; eighteen unchanged
renderer/preload/shared Program entries and their outputs retained prior evidence.
All 24 graph outputs, eight configs, lockfile, intake and official main build
inputs matched. Six owned native scenario groups passed with the explicit
backend/facade scope recorded in the anchor contract.

Application runtime binding, first provisioning, startup reconciliation and the
coordinator's pre-START ordering are not connected by these storage patches.

## Runtime binding and startup history — 31 October 2026

The 81-patch graph adds the main Rolldown build input and two application
changes for the [fixed runtime and startup gate](NATIVE-RUNTIME-BINDING.md).
All 25 original-to-final source chains passed exact assembly checks. The main
TypeScript target and its seven prerequisites passed; the subsequent SDK-only
release-phase repair reused that check with identical application source and
compiler inputs. A fresh main build embedded the final fifteen-file SDK tuple,
and all 52 retained upstream main tests passed.

Seven main sources matched the actual TypeScript Program and fresh runtime map.
The build script was verified separately as an executed build input, not counted
as a TypeScript Program member. Eighteen unchanged renderer/preload/shared entries
and their outputs retained their prior evidence. The lockfile and eight compiler
configurations were unchanged. The emitted tuple also passed the actual copied
SDK's canonical codec through Node's synchronous ESM loader.

The source suite passed 462 checks without skips. The bound relay passed seven
checks, including a real own-archive Node/Python prepare and joined inert cancel.
The legacy relay passed 23 checks after a deterministic regression exposed and
fixed premature outer `released` reporting before worker process/pipe closure.
Historical failures and uncertain fixture journals were retained.

These checks do not start or replace Vortex. Electron loading, native constructor
acceptance, coordinator initialization and installation remain separate gates.

## First history initialization — 31 October 2026

The 83-patch graph adds a genuine owner-bound main hold and the
[initialization bridge](NATIVE-EXECUTOR-GENESIS.md). The journal exclusively
provisions a new root under an existing ordinary parent. Main persists and
verifies its empty anchor through actual retained ownership; an initialized
startup reuses its captured journal. Unknown results retain the reservation.

The fresh main TypeScript target, its seven prerequisites, Rolldown build and
52 upstream tests passed. All 25 graph outputs, seven main Program/map entries,
the emitted SDK15 tuple, eight compiler configs and the lockfile matched.
Eighteen unchanged renderer/preload/shared entries retained earlier evidence.

The source sweep passed 477 of 479 checks. Two builder fixtures used the shared
system temporary directory, whose unrelated activity changed an ancestor's
metadata. Moving those fixtures to an isolated task directory preserved every
production guard and assertion; all eleven builder checks then passed, including
under controlled concurrent temporary-directory activity. The original failures
were retained rather than reported as a clean first sweep.

Journal/path checks passed 79 cases. The worker/relay matrix passed 62 checks;
two optional helper/retained-proof fixtures were not enabled in that run. Eight
archive-hash checks passed, including real own-file custody. Staging now binds
its download directory in Node's identity domain and checks SHA-256 plus MD5
through one held native archive handle before extraction. Full native identities
remain separate from Node filesystem labels.

No Vortex application was started or replaced. Pending transition coordination,
renderer ownership transport, terminal ownership and native host acceptance are
still required before an installation endpoint can be enabled.

## Renderer admission and pending preparation — 31 October 2026

The 87-patch graph adds four source changes. The renderer acquires actual
manager exclusion, reserves the requested target and waits for the previous
acknowledged persistence flush before issuing an opaque admission token.
A source-owned store listener detects profile/game changes, including a change
away and back while an acknowledgement is pending. The main frame lease pins
the bound window, frame and persistence source and remains held after invalidation.

Main preparation checks genuine reservation ownership against the exact game
and mod. Pure SDK validation rejects inconsistent or unsupported metadata before
history provisioning. The private bound relay prepares without START; the journal
reserves its pending transition, and main persists the successor anchor with
compare-and-swap, exact acknowledgement and readback. Unknown outcomes retain
ownership and history. Additional graph dependencies pin both the frame producer
and the target-check producer to their exact earlier intermediate outputs.

These components expose no installation endpoint. Renderer-to-main transport,
START authorization, terminal ownership/release and installed-host acceptance
remain separate work. A successfully joined inert cancellation retains an
unresolved pending journal; it does not authorize retry or prove installation.

### Invalidation response — 1 November 2026

Independent review found that profile invalidation blocked admission but left its
caller waiting for an unrelated readiness or flush promise. Two regressions
failed before the repair. A private invalidation signal now ends that observer
immediately; the underlying work remains observed and ownership is not released.
Seventeen renderer tests pass, including late fulfillment/rejection and original
error preservation. The repaired graph and renderer suite pass forty checks
without skips. Another agent independently passed all seventeen renderer tests.

Before this one-file repair, fresh main and renderer TypeScript/build checks and
52 upstream main tests passed. Source maps matched 22 selected main/renderer
Program entries; three unchanged preload/shared entries retained earlier proof.
All 25 graph outputs and the emitted fifteen-file SDK tuple matched. Related
source checks passed 434 cases, history/runtime checks passed 54, and the native
SDK/relay matrix passed 44 with two optional fixtures skipped. The real owned
Node/Python preparation persisted a pending anchor without START and joined both
processes after an explicit inert cancellation. Its journal remains unresolved.

The repaired renderer passed a fresh TypeScript check and webpack build. All
fifteen selected renderer Program/map entries matched; unchanged main, preload,
shared, SDK and compiler inputs retained exact prior evidence. Installed Vortex
was not modified.

## Terminal anchor ownership — 1 November 2026

The 89-patch graph adds Main and Level terminal-window mechanisms. Genuine
committed tracked registration ownership stays reserved while one nonnull,
same-root, changed-census anchor is committed and read back. Only a separate
exact post-CAS read allows the source-created release finalizer. The ordinary
anchor/release paths cannot bypass an active window; failures keep ownership.

[Terminal evidence version 2](NATIVE-EXECUTOR-TERMINAL.md#completion-with-retained-writer-ownership)
records known registration, renderer adoption and worker closure while writer
barriers remain held. Version 1 still requires executed release evidence. Both
versions remain immutable and externally census-anchored; neither observation
hashes nor an opaque window alone authenticate completion.

Independent review exposed accepted substitution of Main's committed record after
opening the window. Four regressions failed before the repair. Main now pins the
original registration slot, binding and observed record, including descriptors
and field values, and rechecks them after callbacks/awaits and before release.
Window/composed checks passed 23 cases; graph checks passed 23. Journal checks
passed 57 and related intent/plan checks passed 32. The source regression matrix
passed 434 checks. Native SDK/relay checks passed 49 with two optional fixtures
skipped. A failed strict TypeScript check caught three unchecked index accesses;
explicit guards replaced them without changing test expectations. Failed build
inputs and logs were retained.

The journal/window composition uses the actual journal and composed owner classes
with a controlled transactional database. Its renderer and worker observations
are fixture claims. Installed-host loading, actual renderer/worker completion,
full transport/START/terminal coordination and known inert-cancel closure remain
separate gates. Installed Vortex and game files were not changed.

The final Main source passed the real TypeScript target and its seven prerequisites,
Rolldown build and all 52 upstream main tests. All seven selected Main Program/map
entries matched the final graph, alongside all 25 source outputs and fifteen SDK
pins. Eighteen unchanged renderer/preload/shared entries retained their prior proof.

## Internal preparation transport — 1 November 2026

The 95-patch graph adds six source changes across Shared, Preload, Main and
Renderer. The [transport contract](NATIVE-EXECUTOR-TRANSPORT.md) joins actual
renderer exclusion and old persistence ACK, exact frame challenges, genuine Main
reservation and pending journal/anchor preparation. It does not issue START or
register an installation endpoint. Preparation can create history and an inert
worker in a qualified native host; a false permission flag is not a read-only claim.

The first complete build passed Shared, Main, Preload and Renderer TypeScript
targets and builds, plus all 52 upstream Main tests. All 25 selected compiler
Program sources matched; 23 runtime source-map texts matched, while two Shared
interfaces were erased and checked through their Program inputs. All six emitted
bundle/map outputs and the unchanged fifteen-file SDK tuple were checked.

Review then found two defects: a foreign duplicate invoke could hold the genuine
operation, and renderer validation rejected supported leading `_`/`-` profile IDs.
Focused regressions failed before repair. The repaired Main and Renderer passed
fresh TypeScript targets, builds and the same 52 upstream tests. Twenty-two
selected Program/map sources were checked afresh; three unchanged Shared/Preload
Program sources and the two Preload outputs retained the exact complete-build
proof. No dependency or installed-host change was made.

The final sequential actor/graph matrix passed all 96 checks without skips. The
related 31-file source matrix passed all 434 checks without skips. An independent
review identified a timing assumption in the sibling-frame integration test:
two scheduler turns did not establish acquisition. The test now waits for the
actual acquired response and asserts the pre-timeout ownership state, retaining
all refusal and post-timeout assertions. Production guards were unchanged.

The SDK ancestor-generation guard can reject an operation when an unrelated
sibling directory changes. The failed parallel fixture run and an isolated causal
check are retained; this availability limitation remains a gate before public
installation. Sequential fixture execution does not establish concurrent native
acceptance. Full START/completion/release coordination, repeat-operation handoff,
inert cancellation closure and installed-host acceptance remain required.
