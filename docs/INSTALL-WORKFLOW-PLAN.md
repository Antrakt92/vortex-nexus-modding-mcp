# Install, update and collection workflow plan

Improve the supported stock Vortex workflow in small independently useful steps.
Mod development can continue using the existing own-local ZIP route while later
collection work remains deferred. This plan does not authorize new live effects.

## Boundaries and evidence

- Use official Vortex and its reviewed extension/event APIs only. No Core or
  ASAR changes, UI automation, new daemon, generic dispatch or game launch.
- [Stock local installation](STOCK-LOCAL-INSTALL.md) supports new own-local ZIPs,
  installed disabled. General third-party installation and replacement remain
  separate unsupported capabilities until their own gates pass.
- Reuse [lifecycle inspection](LIFECYCLE-PERFORMANCE.md),
  [collection download lookup](COLLECTION-DOWNLOADS.md) and
  [plan reconciliation](NO-RESTART-WORKFLOW.md). Preserve their stated limits.
- The reviewed stock source ledger is
  [stock-vortex-2.9.1-admission.json](../tools/modding/vortex-agent/stock-vortex-2.9.1-admission.json).
  Its reviewed InstallManager snippets show dependency-ignore decisions before
  update selection, different current/all-profile effects and asynchronous
  post-callback attributes. Matching snippets separate file identity from the
  installer choices, file lists and patches that determine an installed variant.
  Source excerpts remain external context, not vendored application code.

## 1. Observe bounded work and explain waits — implemented

Add bounded phase durations and optional diagnostics to the own-local installer.
Expose live observations and retained final observations through reconciliation;
retain the original request ID. Omit credentials, signed URLs and raw host state.
Report the phase, elapsed work and outcome without claiming the host has stopped.

Budget work for 240 seconds after the existing lock wait of at most 30 seconds.
Cap each native wait at 120 seconds and the remaining work budget; cap host and
metadata waits at 30 seconds and the remaining budget. Keep transport allowance
at 300 seconds. These are waiting limits, not promised installation times.
Receipt finalization must finish through its existing durable path, without a
cancelable timeout race that could leave an unobserved write running.
There is no install snapshot while waiting for the lock, before the immutable
attempt exists, or after a process restart without a retained diagnostic record.
Report unavailable observations explicitly rather than inferring idle or success.

A timeout does not cancel Vortex. Stop subsequent effects, preserve guards and
reconcile the original operation; never retry with another ID or clear a marker.
Synchronous checks can delay timer delivery, so report measured elapsed time and
do not describe a JavaScript deadline as process interruption.

Exit gate: focused deadline/diagnostic regressions, broader adapter checks and
source/artifact consistency pass. Report native activation and isolated-host
acceptance separately; source tests alone do not mark this milestone verified.

On 2026-11-03, the compiled MCP route passed isolated official Vortex 2.9.1
acceptance with a pre-existing disabled mod: live observations, retained final
diagnostics, original attempt binding, five durable completions, collision refusal,
deployment/restore bytes and hardlinks, and ordinary-session preservation.
This is isolated native acceptance, separate from ordinary-host activation.

## 2. Measure before optimizing checks — implemented

Use the phase evidence to rank costs. Initial candidates include the observed
14 PowerShell process/check invocations, repeated source ancestor walks and
synchronous ZIP validation. Establish comparable cold/warm samples, archive
sizes, host identity and full guard costs before choosing one narrow change.
Do not promise a target number of seconds from tiny fixtures.
The first instrumented 219-byte ZIP fixture took 5,904 ms for the install request.
Fourteen context checks measured 4,341 ms, three host admissions 721 ms and
three metadata calls 118 ms; native import/install measured 520/1,156 ms.
These nested metrics overlap. This single sample identifies context/process
checks as the first investigation target; it proves neither collection throughput
nor a speedup over the previous build.
Include progress polling and receipt finalization in the measurement; distinguish
exclusive phase times from overlapping nested metrics. Keep the exact bundle,
fixture, sample count and failed/held runs with the result. A transport deadline
or omitted failed run must not make a slower operation appear faster.

Reuse immutable source proofs or metadata only with matching physical generations
and host/source identity. Preserve context, collision, archive-byte, source and
payload checks at their required effect boundaries. A warm cache is not admission
for a changed file, extension, host or unresolved earlier attempt.

Faster checks can expose settlement races previously hidden by their duration.
Native mod-size calculation can update derived attributes after its callback.
Keep security-relevant identity/record checks strict and handle known derived
attributes separately using bounded observed settlement; never add an arbitrary
sleep or ignore arbitrary record changes to make a test pass.

Exit gate: mutation/refusal tests remain effective, asynchronous post-callback
updates are covered, and comparable measurements show the intended work reduction.
Keep recovery of an older incomplete canonical build cache as a separate small
task: inspect its original attempt, prove required outputs or rebuild explicitly;
do not treat incomplete cache contents as reusable success or delete evidence.

Before any larger implementation, prove its essential stock-host API in a small
isolated experiment. Stop and revise the design if that API needs a Core patch,
cannot preserve the required profiles, or has an unobservable completion boundary.
Do not build surrounding machinery to compensate for an unproved prerequisite.
Keep each later slice independently reviewable and useful with the existing tool.

The own-local route now performs six fresh process probes: entry, import dispatch,
install dispatch, final native-hook permission, post-install proof and completion
publication after receipt fsync. Preparation/poll checkpoints retain live profile,
path, physical-directory and tools-running checks; archive verification retains
its original boundaries. They do not cache process absence. A game launch during read-only preparation is refused
at the next native permission; an already dispatched operation is not canceled.
Other operations retain their original full-check policy.

On 2026-11-03, six serial isolated Vortex 2.9.1 fixtures in A/B/B/A/A/B order passed
independent installation, preservation, deployment and restore checks. The same
219-byte ZIP took 6,233/6,304/6,085 ms on the baseline and 3,719/3,755/3,786 ms
on the candidate. Medians were 6,233 and 3,755 ms (about 40% shorter in this
fixture). Live observation cadence stayed one second; faster requests produced
four observations instead of six. Receipt finalization and observer work remain
included; overlapping metrics are not summed. These are three samples per variant,
not a collection benchmark, cold-disk comparison or general latency guarantee.

An earlier pilot retained two successful fixtures and a failed WMI inventory
before fixture creation. After replacing only the fixture's WMI reader with
complete native process/generation checks, the full six-sample comparison was
started separately. The failed pilot was not removed or counted as a fast install.
Native acceptance here is separate from ordinary-host activation.

## 3. Assess candidates before adding a general installer

First add a bounded read-only assessment for exact target profile, collection
revision, old installed IDs, new provider identities and installation specs.
Classify each member as compatible installed variant, reusable archive candidate,
download needed, separate variant needed, conflict or insufficient evidence.

Evaluate full dependency references against the proposed provider, including
ignored rules; an old provider's compact exact-file summary is insufficient.
Evaluate installer choices, file lists and patches separately from identity.
Account for all-profile usage, preferences, overrides and existing variants.
Do not select an old provider solely because it shares a Nexus mod page.

Archive reuse and installation reuse are different decisions. Finished download
metadata does not prove bytes, CRC or compatible installed choices. Preserve
duplicate, paused, failed, unverified and capped-inventory unknown outcomes;
absence from a bounded read is not permission to acquire another copy.

Freeze relevant revision/specification, context, provider, dependency/profile
and archive inputs. Recheck them before effects; relevant drift requires a fresh
assessment. Historical completed receipts do not establish current readiness.
No whole-host atomic transaction or automatic replacement is promised.

## 4. Add one supported effect class at a time

Only after assessment gates pass, consider noninteractive tracked packages with
explicit scope and exact pins. Keep interactive installers, replacement, removal
and archive deletion separate. Preserve other profiles and retained recovery
inputs; never auto-ignore a dependency conflict. Verify installation before
preparing activation, then perform one final deployment and verify it separately.

An interrupted batch with completed A, uncertain B and unscheduled C stops at B.
Inspect original receipts and current state. Do not replay A/B, deploy a partial
batch or use fresh IDs to evade uncertainty. A later remaining-work plan needs
resolved original attempts and fresh assessment; historical journals do not resume.

## Acceptance matrix

| Scenario | Required observation |
| --- | --- |
| Slow lock, host, metadata or native callback | Correct phase/budget; no duplicate effect or timeout-as-cancellation claim |
| Final receipt write outlasts work budget | Durable finalization observed; no racing finalizer/retry |
| Mod size arrives after native callback | Derived update accepted deliberately; identity/rule mutation still rejected |
| Old provider used by two profiles | Target scope explicit; other profile and old payload preserved |
| Collection pins old exact file | Conflict before effects; rules and ignored flags unchanged |
| Same archive, different choices or patches | Archive may be reusable; incompatible installed variant is not reused |
| Duplicate downloads or incomplete inventory | Ambiguity/unknown retained; no silent duplicate acquisition |
| Revision, flags, rules or bytes change | Stale assessment rejected before the next effect |
| A completes, B loses acknowledgement, C waits | Original IDs reconciled; no replay, C or final deployment |

Use deterministic local fixtures first, then separately authorized isolated stock
host acceptance with two profiles and controlled archives. Check flags, rules,
staged bytes and deployment ownership. Compilation, callbacks and tiny timings
remain distinct from native loading, real collection acceptance and gameplay.
