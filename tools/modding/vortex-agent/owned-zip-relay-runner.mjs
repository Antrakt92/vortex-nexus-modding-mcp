// Fixed child entry. SDK import happens only after the ready/start handshake.
import crypto from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import strict from './strict-json.cjs';
import dispatch from './native-dispatch-contract.cjs';
import paths from './paths.cjs';
import terminal from './child-terminal-observer.cjs';
import { readRelaySourceClosure, verifyRelayNode, validateRelaySDKStatus, validateRelayPreparedReceipt, copyRelayAnchor } from './owned-zip-relay-client.mjs';
const HERE = path.dirname(fileURLToPath(import.meta.url)), MAX_START = 2 * 1024 * 1024 + 32768, MAX_STATUS = 65536, MAX_PROOF = 4 * 1024 * 1024 + 16384;
const exact = (v, k) => v && typeof v === 'object' && !Array.isArray(v) && Object.keys(v).length === k.length && k.every(n => Object.hasOwn(v, n));
const need = (v, c) => {
    if (!v)
        throw Error('OWNED_ZIP_RELAY_' + c);
};
const sha = b => crypto.createHash('sha256').update(b).digest('hex'), equal = (a, b) => isDeepStrictEqual(a, b);
const safe = e => /^OWNED_ZIP_(?:RELAY|WORKER)_([A-Z][A-Z0-9_]{0,90})$/.exec(e?.message ?? '')?.[1] ?? 'SDK_FAILED';
let binding = null, mode = null, startSHA256 = null, owner = null, started = false, startPending = false, cancelled = false, handoff = false, releasing = false, released = false, controllerEOF = false, failed = null, sequence = 0, pending = Buffer.alloc(0), writing = false, latest = null, lastJSON = null, active = 0, protocolBroken = false, outputBroken = false, essential = null, proofAttempted = false, preparedReceipt = null, preparedSHA256 = null, startPreparedAttempted = false;
const lifetime = 'relay_' + crypto.randomBytes(16).toString('hex');
const keepAlive = setInterval(() => {
}, 1000);
function maybeExit() {
    if (released && controllerEOF && !outputBroken && !writing && latest === null && essential === null) {
        clearInterval(keepAlive);
        clearInterval(pump);
        process.exit(0);
    }
}
function drain() {
    if (writing || (latest === null && essential === null))
        return;
    const value = essential ?? latest;
    if (essential !== null)
        essential = null;
    else
        latest = null;
    if (value.schema !== 'owned-zip-relay-ready/1')
        value.sequence = ++sequence;
    const bytes = Buffer.from(JSON.stringify(value) + '\n');
    writing = true;
    try {
        process.stdout.write(bytes, e => {
            writing = false;
            if (e) {
                outputBroken = true;
                hold('OUTPUT_FAILED');
                return;
            }
            drain();
            maybeExit();
        });
    }
    catch {
        writing = false;
        outputBroken = true;
        hold('OUTPUT_FAILED');
    }
}
function emit(value, essentialFrame = false) {
    if (outputBroken)
        return;
    need(Buffer.byteLength(JSON.stringify(value)) + 1 <= (value.schema === 'owned-zip-relay-copy-proof/1' ? MAX_PROOF : MAX_STATUS), 'STATUS_LIMIT');
    if (essentialFrame) {
        need(essential === null, 'COPY_PROOF_CAPACITY');
        essential = value;
    }
    else
        latest = value;
    drain();
}
function sdkStatus() {
    if (!owner)
        return null;
    const v = owner.status();
    validateRelaySDKStatus(v, binding, mode);
    return v;
}
function publish(force = false) {
    if (binding === null)
        return;
    try {
        const sdk = sdkStatus();
        let phase = released ? 'released' : controllerEOF ? 'held' : releasing ? 'releasing' : sdk?.phase ?? 'starting';
        if (['ready', 'not_started'].includes(phase))
            phase = cancelled ? 'cancelled' : failed ? 'held' : 'starting';
        if (failed && !['cancelled', 'released'].includes(phase))
            phase = 'held';
        const body = {
            schema: 'owned-zip-relay-status/1', relayLifetime: lifetime, binding, startSHA256, sequence: 0, phase, accepted: sdk?.startSent === true && /^[a-f0-9]{64}$/.test(sdk.packetSHA256 ?? ''), sdk, controllerEOF, errorCode: failed, effectsAllowed: false, nativeInstallAccepted: false, persistenceVerified: false
        };
        const current = JSON.stringify(body);
        if (!force && current === lastJSON)
            return;
        lastJSON = current;
        body.sequence = 0;
        emit(body);
    }
    catch (e) {
        failed ??= safe(e);
        emit({
            schema: 'owned-zip-relay-status/1', relayLifetime: lifetime, binding, startSHA256, sequence: 0, phase: 'held', accepted: false, sdk: null, controllerEOF, errorCode: failed, effectsAllowed: false, nativeInstallAccepted: false, persistenceVerified: false
        });
    }
}
function hold(code) {
    failed ??= code;
    const wasCancelled = cancelled;
    if (!releasing)
        cancelled = true;
    if (owner && !releasing && !wasCancelled) {
        void Promise.resolve().then(() => owner.cancel()).then(() => publish(true), () => publish(true));
    }
    publish(true);
}
function run(fn) {
    if (active >= 8) {
        hold('CONTROL_CAPACITY');
        return;
    }
    ++active;
    void Promise.resolve().then(fn).catch(e => hold(safe(e))).finally(() => {
        --active;
        publish(true);
    });
}
async function start(v, raw) {
    need(started && startPending && !released && owner === null, 'START_REFUSED');
    try {
        need(equal(readRelaySourceClosure(), initialSources), 'SOURCE_CHANGED');
        need(!controllerEOF && !protocolBroken && !failed, 'CONTROLLER_EOF');
        const sdk = await import('./owned-zip-worker-client.mjs');
        need(equal(readRelaySourceClosure(), initialSources), 'SOURCE_CHANGED');
        need(!controllerEOF && !protocolBroken && !failed, 'CONTROLLER_EOF');
        const make = mode === 'scratch' ? sdk.createOwnedZipWorker : sdk.createOwnedStagingZipWorker;
        need(typeof make === 'function', 'STAGING_UNAVAILABLE');
        owner = make(Buffer.from(v.requestJSON), Buffer.from(v.archiveJSON));
        if (cancelled) {
            await owner.cancel();
            publish(true);
            return;
        }
        if (v.schema === 'owned-zip-relay-prepare/1') {
            const anchor = copyRelayAnchor(Buffer.from(v.anchorJSON));
            const receipt = await owner.prepare(anchor);
            validateRelayPreparedReceipt(receipt, binding, JSON.parse(anchor.toString('utf8')));
            if (controllerEOF || protocolBroken || cancelled || failed) {
                await owner.cancel();
                publish(true);
                return;
            }
            preparedReceipt = receipt;
            preparedSHA256 = sha(Buffer.from(JSON.stringify(receipt)));
            emit({
                schema: 'owned-zip-relay-prepared/1', relayLifetime: lifetime, binding, startSHA256, sequence: 0, nonce: v.nonce, preparedSHA256, prepared: receipt
            }, true);
        }
        else {
            await owner.start();
        }
        publish(true);
    }
    finally {
        startPending = false;
    }
}
async function command(v) {
    need(exact(v, ['schema', 'relayLifetime', 'binding', 'command', ...(v.command === 'copyProof' ? ['nonce'] : v.command === 'startPrepared' ? ['preparedSHA256'] : [])]) && v.schema === 'owned-zip-relay-control/1' && v.relayLifetime === lifetime && ['cancel', 'handoff', 'release', 'abort', 'copyProof', 'startPrepared'].includes(v.command), 'CONTROL');
    if (binding === null) {
        need(!started && v.command === 'abort', 'NOT_STARTED');
        binding = terminal.copyChildBinding(v.binding);
        released = true;
        publish(true);
        return;
    }
    need(equal(v.binding, binding), 'BINDING');
    if (v.command === 'cancel') {
        need(!releasing, 'RELEASE_PENDING');
        if (!cancelled) {
            cancelled = true;
            if (owner)
                await owner.cancel();
        }
        publish(true);
        return;
    }
    const cancelStatus = v.command === 'release' && cancelled && owner ? sdkStatus() : null;
    const cancelledRelease = cancelStatus?.phase === 'cancelled' && cancelStatus.cancelAttempted === true;
    need(!controllerEOF && !protocolBroken && (!failed || cancelledRelease), 'CONTROLLER_EOF');
    need(equal(readRelaySourceClosure(), initialSources), 'SOURCE_CHANGED');
    if (v.command === 'startPrepared') {
        need(preparedReceipt && owner && !cancelled && !releasing && !startPending && !startPreparedAttempted && v.preparedSHA256 === preparedSHA256, 'START_PREPARED_REFUSED');
        startPreparedAttempted = true;
        await owner.startPrepared();
        publish(true);
        return;
    }
    if (v.command === 'copyProof') {
        need(mode === 'staging' && owner && !cancelled && !releasing && !proofAttempted && typeof v.nonce === 'string' && /^[a-f0-9]{32}$/.test(v.nonce), 'COPY_PROOF_REFUSED');
        proofAttempted = true;
        const proof = owner.copyProof();
        const current = sdkStatus();
        need(current.phase === 'copied' && current.workerTerminal && !current.workerTerminal.exitObserved && !current.workerTerminal.closeObserved && !current.workerTerminal.childErrorObserved && !current.workerTerminal.childResourcesClosed && !current.workerTerminal.held, 'COPY_PROOF_UNAVAILABLE');
        emit({
            schema: 'owned-zip-relay-copy-proof/1', relayLifetime: lifetime, binding, startSHA256, sequence: 0, nonce: v.nonce, proof
        }, true);
        return;
    }
    if (v.command === 'handoff') {
        need(owner && !handoff && !cancelled && !releasing && owner.status().phase === 'extracted', 'HANDOFF_REFUSED');
        handoff = true;
        await owner.handoff();
        publish(true);
        return;
    }
    need(v.command === 'release' && owner && !releasing, 'RELEASE_REFUSED');
    releasing = true;
    const result = await owner.release();
    validateRelaySDKStatus(result, binding, mode);
    const neverStarted = result.startAttempted === false && result.workerPid === null && result.workerTerminal === null;
    need(neverStarted || result.childClosed && result.workerTerminal?.childResourcesClosed && result.workerTerminal.exitSucceeded, 'WORKER_TERMINAL');
    released = true;
    publish(true);
    maybeExit();
}
function receive(raw) {
    const value = strict.parseStrictJSON(raw, {
        maxBytes: started ? 4096 : MAX_START, maxDepth: 24, maxTokens: 60000
    });
    if (value?.schema === 'owned-zip-relay-start/1' || value?.schema === 'owned-zip-relay-prepare/1') {
        need(exact(value, [
            'schema', 'relayLifetime', 'binding', 'mode', 'requestJSON', 'archiveJSON', ...(value.schema === 'owned-zip-relay-prepare/1' ? ['anchorJSON', 'nonce'] : [])
        ]) && value.relayLifetime === lifetime && (value.mode === 'scratch' || value.mode === 'staging') && typeof value.requestJSON === 'string' && typeof value.archiveJSON === 'string' && !started, 'START');
        if (value.schema === 'owned-zip-relay-prepare/1') {
            need(typeof value.anchorJSON === 'string' && typeof value.nonce === 'string' && /^[a-f0-9]{32}$/.test(value.nonce), 'PREPARE');
            copyRelayAnchor(Buffer.from(value.anchorJSON));
        }
        else
            need(value.mode === 'scratch', 'STAGING_PREPARE_REQUIRED');
        const request = dispatch.parseDispatchRequest(Buffer.from(value.requestJSON));
        need(JSON.stringify(request) === value.requestJSON, 'REQUEST');
        const expected = terminal.copyChildBinding({
            operationId: request.operationId, nativeJobId: request.nativeJobId, requestSHA256: dispatch.dispatchRequestDigest(Buffer.from(value.requestJSON)), rendererGeneration: request.rendererGeneration
        });
        need(equal(expected, value.binding), 'BINDING');
        strict.parseStrictJSON(Buffer.from(value.archiveJSON), {
            maxBytes: 8192, maxDepth: 4, maxTokens: 100
        });
        // Claim before import/await. Controls can synchronously cancel the pending start.
        started = true;
        binding = expected;
        mode = value.mode;
        startSHA256 = sha(raw);
        startPending = true;
        run(() => start(value, raw));
        return;
    }
    run(() => command(value));
}
let initialSources;
try {
    need(process.platform === 'win32' && process.arch === 'x64' && !process.versions.electron && process.versions.node === '24.20.0' && process.env.NODE_OPTIONS === undefined && process.env.NODE_PATH === undefined, 'UNSUPPORTED_RUNTIME');
    const nodeSHA256 = verifyRelayNode();
    initialSources = readRelaySourceClosure();
    emit({
        schema: 'owned-zip-relay-ready/1', relayLifetime: lifetime, pid: process.pid, nodeVersion: process.versions.node, nodeSHA256, sourceSHA256: initialSources, workspace: paths.resolvePaths().workspace
    });
}
catch {
    process.exitCode = 1;
    clearInterval(keepAlive);
    process.exit(1);
}
const pump = setInterval(() => publish(), 25);
process.stdin.on('data', chunk => {
    if (protocolBroken)
        return;
    try {
        need(chunk.length <= MAX_START, 'FRAME_LIMIT');
        pending = Buffer.concat([pending, chunk]);
        let at;
        while ((at = pending.indexOf(10)) !== -1) {
            need(at > 0 && at <= (started ? 4096 : MAX_START), 'FRAME_LIMIT');
            const raw = pending.subarray(0, at);
            pending = pending.subarray(at + 1);
            receive(raw);
        }
        need(pending.length <= (started ? 4096 : MAX_START), 'FRAME_LIMIT');
    }
    catch (e) {
        protocolBroken = true;
        hold(safe(e));
    }
});
process.stdin.on('end', () => {
    controllerEOF = true;
    if (released) {
        maybeExit();
        return;
    }
    if (pending.length)
        protocolBroken = true;
    hold('CONTROLLER_EOF');
});
process.stdin.on('error', () => {
    controllerEOF = true;
    hold('INPUT_FAILED');
});
process.stdout.on('error', () => {
    outputBroken = true;
    hold('OUTPUT_FAILED');
});
process.stderr.on('error', () => hold('OUTPUT_FAILED'));
