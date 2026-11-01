# Internal copy, registration and adoption

These source methods continue the [prepared transport](NATIVE-EXECUTOR-TRANSPORT.md)
using its private owners. They are not registered as IPC handlers or MCP tools.
They must not be wired to an execution endpoint until the coordinator's fresh
renderer checks, completion and failure paths are implemented and accepted.

## Main stages

`copyNativeExecutorTransport(ticket)` consumes one actual prepared attempt. Main
retains the exact validated prepared receipt, including worker lifetime, packet
digest, PID and creation time. It rechecks the independently retained pending
anchor and complete census before calling the captured relay methods:
`startPrepared`, `waitFor('extracted')`, `handoff`, then `copyProof`.

The returned copy projection contains no owner or file proof. Main retains the
canonical proof bytes privately. Actual relay validation binds the full expected
payload, destination and worker/packet/request identities. The projection's proof
digest identifies that retained evidence; it is not a registration permit.

`registerNativeExecutorTransportCopied(ticket)` is a separate one-shot stage.
The fixed coordinator must recheck the actual renderer between copying and
registration. Main rechecks the pending anchor and live custody, retrieves the
SDK proof again and requires identical canonical bytes. A caller cannot supply a
replacement proof, registration record, archive association or digest.

Registration bytes derive from the retained validated plan. `payloadSHA256` uses
the existing `installPayloadDigest(plan)` contract; the complete native proof has
its own separate digest. Actual Main/Level tracked registration checks the current
download association and commits/readbacks the mod record and installed link.
Main then opens the genuine terminal window bound to the exact committed result.

Before registration, transport checks require the target to be absent. During
registration they use the genuine registration checker; after commit they use the
actual terminal window. Frame, source, request and ownership checks remain in all
phases. Post-copy checks also require live relay and worker custody, including
after the database await. If custody is lost during a successful COMMIT, rows may
already exist: no adoptable observation is returned, owners stay held and the
coordinator must reconcile. It must not claim rollback or repeat the operation.

## Renderer stages

`checkNativeExecutorTransportPreparation(transportId)` checks the actual retained
prepared request, admission, game/profile, manager, target and flush owners. It
returns the existing admission projection, without serializing those owners.
It is the source check needed before START and again before registration.

`prepareNativeExecutorTransportAdoption(transportId, observedBytes)` consumes one
adoption attempt. A bounded closed canonical decoder checks the actual Main
observation tuple, exact record/marker and base/full-record hashes. This decoder
does not authenticate Main: only the fixed coordinator may deliver its actual
committed observation. Claimed JSON is not an independent authority.

The method invokes the captured root adoption function with the retained target
and flush owners, then prepares actual manager release using the retained manager
owner. Release-method descriptors are captured at admission and checked throughout
the attempt, so later substitution cannot mint a false release-prepared result.
The release ticket remains private. `checkNativeExecutorTransportAdoption` checks
the genuine committed target, buffered persistence and manager ticket again.

Adoption preserves unrelated buffered changes and leaves the new mod disabled.
It does not reopen writes or release the manager. A failed renderer adoption
cannot undo a committed Main transaction.

## Completion remains separate

There is no worker release or terminal publication in these methods. Both writer
barriers and the pending journal remain held after successful registration and
adoption. Permission fields remain false; they do not assert that copying or
database writes had no effects.

Before enabling an installation endpoint, the fixed coordinator still needs:

- exact-frame continuation challenges and profile invalidation delivery, with
  fresh renderer checks before START and after copy, before registration;
- actual adoption acknowledgement, joined worker closure, v2 terminal evidence,
  terminal-anchor CAS and separate readback;
- known Main release acknowledgement followed by synchronous renderer finalization;
- verified handoff for a second operation on the same application instances;
- inert-cancellation closure, source-custody availability and installed-host tests.

Source-method integration tests use actual composed Main/Level/SDK journal and
renderer/Redux/manager methods. Their transactional storage and physical relay
remain explicit fixtures. They do not establish execution through IPC, a native
child, an installed Vortex or a game.

Run the source suites that create SDK workspaces through one test owner with
`node --test --test-concurrency=1`. Independent agents may review code in parallel,
but must not start separate Main fixtures while that run is active: a sibling
creation changes the guarded ancestor generation. Record the original failure
and diagnose its cause before retrying; an arbitrary rejection is not proof that
the intended failure branch was exercised. This test arrangement does not resolve
the documented runtime source-custody availability gate.
