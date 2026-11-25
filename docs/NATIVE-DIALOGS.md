# Native installation questions

Use `read_native_dialog` and `respond_native_dialog` for the current first stock
installation question. Other questions may remain queued. Supported responses
are **Cancel**, **Ignore dependencies**, and **Update current profile**. The tools
never choose Update all profiles or remember an answer.

1. Read `read_native_preflight` for the active game/profile and filesystem pins.
2. Call `read_native_dialog` with that game and profile. Inspect the question and
   its eligible actions. Keep the returned dialog ID and fingerprint.
3. Call `respond_native_dialog` with the standard context pins, a new request ID,
   that exact dialog ID/fingerprint, and one eligible action. The observation must
   still be fresh and match the current first question.
4. Read the next question separately. After a lost reply, use
   `read_native_dialog_operation` with the original request ID. For Ignore or
   Update current profile, also call `reconcile_operation` with that same ID
   before considering another response.

The observed question survives separate MCP HTTP requests within the same Vortex
process and receipts workspace. Each request still uses fresh source/context
checks and its current mutation guard. Concurrent reads/responses refuse while a
dialog action is pending. Restarting Vortex requires a new observation; existing
attempts and control receipts still prevent replay.

Cancel is an abort-only control. It uses its own control journal and can answer a
question while an earlier operation's global interlock is retained. It does not
remove that interlock or claim the failed installation has been reconciled.
Ignore and Update current profile require the ordinary mutation guard. If the
ordinary guard cannot verify dismissal after invoking the callback, it retains
the global interlock. The ordinary guard can also verify dismissal and finish
before a separate failure writing the dialog control receipt. In that case,
`read_native_dialog_operation` can report `held` even if `reconcile_operation`
returns a matching completion with `terminalOperationVerified: true`. That
completion verifies dismissal only. Reconcile any retained interlock separately.
A missing or pending control receipt leaves the outcome unknown. Neither
inspection replays the response or clears an interlock.

Eligible actions describe what the question supports, not which mod caused it.
Before ignoring dependencies or updating, establish that it belongs to the
authorized installation and assess the affected dependencies separately.

The native source admission supports the reviewed Vortex 2.9.1 packages and
official Vortex 2.10.1 and 2.11.0. Unknown source, changed context, unsupported
question shapes, stale observations and
ambiguous dialog IDs refuse before a response. No generic dispatcher, arbitrary
code, keyboard input or window automation is involved.

For official 2.11.0, the ASAR's renderer source map matches upstream commit
`9c785f8ae3741def2421d6a1ed66cf52b1035414` for `InstallManager.ts`,
`ExtensionManager.ts` and `actions/notifications.ts`. The two admitted question
shapes and `api.closeDialog` callback contract match the controller. Run
`wire.test.mjs` with `VORTEX_NATIVE_DIALOG_2110_APP_ASAR` set to the stock
`resources/app.asar` to check supported actions through the compiled MCP.
Add `--native-dialog-probe` to the paired 2.11.0 [native fixture](STOCK-LOCAL-INSTALL.md)
to exercise Cancel on a synthetic question in the official renderer and verify
that the ordinary profile stays intact. Use `--native-dialog-probe-all` for
Cancel, Ignore dependencies, and Update current profile. The additional actions
use synthetic stock question shapes and verify `remember=false`, delivery to
the native callback, both receipt ledgers, and unchanged synthetic profile and
mod state. Live mod updates, dependency overrides, tracked Nexus installation,
and collection wizard admission require separate evidence.

A successful response proves that the selected question disappeared. It does not
prove callback origin, archive identity, installation completion, rollback or disk
deployment. Verify those separately before continuing a release.
