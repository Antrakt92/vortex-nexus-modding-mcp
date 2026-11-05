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
   `read_native_dialog_operation` with the original request ID before considering
   another operation.

The observed question survives separate MCP HTTP requests within the same Vortex
process and receipts workspace. Each request still uses fresh source/context
checks and its current mutation guard. Concurrent reads/responses refuse while a
dialog action is pending. Restarting Vortex requires a new observation; existing
attempts and control receipts still prevent replay.

Cancel is an abort-only control. It uses its own control journal and can answer a
question while an earlier operation's global interlock is retained. It does not
remove that interlock or claim the failed installation has been reconciled.
Ignore and Update current profile require the ordinary mutation guard.
An uncertain response through either action retains the standard global
interlock, blocking later ordinary changes. Both the standard operation receipts
and the dialog control journal remain available for inspection.

Eligible actions describe what the question supports, not which mod caused it.
Before ignoring dependencies or updating, establish that it belongs to the
authorized installation and assess the affected dependencies separately.

The native source admission supports the reviewed Vortex 2.9.1 packages. Unknown
source, changed context, unsupported question shapes, stale observations and
ambiguous dialog IDs refuse before a response. No generic dispatcher, arbitrary
code, keyboard input or window automation is involved.

A successful response proves that the selected question disappeared. It does not
prove callback origin, archive identity, installation completion, rollback or disk
deployment. Verify those separately before continuing a release.
