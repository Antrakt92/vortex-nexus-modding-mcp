# Initialize executor history

An absent history directory is not an initialized journal. `provision()` requires
an existing ordinary parent and exclusively creates the journal root. An existing
root, including an empty one, is refused. Partial output and failed attempts stay
held; another object cannot provision that directory again.

The result is a frozen empty-census observation. It is not a trusted main anchor
or permission to start a worker. The main process must persist the anchor through
its actual backend/SQL ownership and verify the result independently.

## Main-owned initialization

The prepared `initializeNativeExecutorHistory(mainReadyOwner,
modReservationOwner)` binds the actual selected backend, its startup record and
compiled workspace. It checks genuine source-owned readiness and reservation
owners. Neither paths nor a claimed readiness flag are inputs.

For a first initialization it loads the fixed journal, provisions one fresh
root, verifies an empty census and performs the owned absent-to-present CAS. It
checks the exact acknowledgement, a fresh strict database read, the journal and
the SDK source observations before returning an opaque identity. Existing closed
history reuses the journal captured during startup, without provisioning or
writing another initial anchor.

This is one initialization per application lifetime. Its opaque identity is
retained for a future coordinator; it does not expose worker controls or allow
START. Duplicate/reentrant calls and failures after valid ownership retain the
main reservation and startup hold. A lost acknowledgement is not retried, even
if the database contains the new anchor.

The source-owned reservation hold performs no rollback, SQL or cleanup. It can
stop a waiting main acknowledgement from becoming successful after an external
coordinator check failed. A transaction that already committed remains committed
evidence; marking the operation held cannot undo it.

## Remaining gates

The actual coordinator still needs renderer manager/target ownership and an
acknowledged old-diff flush before reserving main writers. It must bind the exact
archive and registration request, validate the prepared pending transition,
persist its successor anchor, recheck the actual frame and local owners, and
only then send one START to the same private worker.

Completion also needs a defined anchor-only ownership window after registration
release, without losing buffered ordinary writes. Known inert cancellation needs
its own terminal transition. Initialization implements none of these later steps
and does not add a public installation endpoint.
