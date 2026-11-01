// Trusted offline build helper. No process start, runtime loader or MCP surface.
import crypto from 'node:crypto';
import {isProxy} from 'node:util/types';
import {readCapturedNativeSDKSource, NATIVE_SDK_SOURCE_NAMES} from './native-sdk-capture.mjs';
import {snapshotNativeExecutorRuntimeBinding} from './owned-zip-relay-client.mjs';
import {buildPythonSDKCapsule} from './native-sdk-python-capsule.mjs';
import {buildNodeSDKBootstrap} from './native-sdk-node-bootstrap.mjs';

const need = (ok, code) => {if (!ok) throw Error('NATIVE_SDK_CAPSULE_BUILD_' + code);};
const sha = b => crypto.createHash('sha256').update(b).digest('hex');
const PREFIX = '\0native-sdk-capsule/';
const CONTEXT = '__capsule-context.cjs';
const BUILTINS = new Set(['node:fs','node:path','node:crypto','node:util','node:util/types',
  'node:child_process','node:url','node:net','node:events','url']);
const ADAPTED_SOURCE_PINS = Object.freeze({
  'paths.cjs':'d641537a2d03728c0212461d2e2e1b6ca22403b4e6cbed08f2730dcd234057ba',
  'paths-core.cjs':'b9c0fb32786134996f4ac8af68f22d29bb82b4bd4ed99abbff93c0b25b3ba032',
  'owned-zip-relay-client.mjs':'78c6e449ab80a24308e0b9aa46a843fa5548f6bb5350ca0ddee7763de4e45ad7',
  'owned-zip-worker-client.mjs':'0786be18d373f33d6dd236e55f9947be502e6d3b90b9a63618f3abf1d574f613',
});
function replaceOnce(text, before, after) {
  const at = text.indexOf(before);
  need(at >= 0 && text.indexOf(before, at+before.length) < 0, 'SOURCE_CONTEXT');
  return text.slice(0, at)+after+text.slice(at+before.length);
}
function replaceFunction(text, name, replacement) {
  // These exact function bodies are selected by their captured source digest.
  // The next top-level declaration bounds the replacement; there is no fuzzy match.
  const start = text.indexOf('export function '+name+'(');
  need(start >= 0 && text.indexOf('export function '+name+'(', start+1) < 0, 'SOURCE_CONTEXT');
  const end = text.indexOf('\nexport function ', start+1);
  need(end > start, 'SOURCE_CONTEXT');
  return text.slice(0,start)+replacement+'\n'+text.slice(end);
}

function adapt(name, raw) {
  if (Object.hasOwn(ADAPTED_SOURCE_PINS,name)) need(sha(raw)===ADAPTED_SOURCE_PINS[name],'ADAPTER_SOURCE_PIN');
  let text = new TextDecoder('utf-8', {fatal:true}).decode(raw);
  if (name === 'paths.cjs') {
    return "'use strict';\nconst core=require('./paths-core.cjs');\nmodule.exports={...core,...core.resolvePaths()};\n";
  }
  if (name === 'paths-core.cjs') {
    text = replaceOnce(text,"const path = require('node:path');",
      "const path = require('node:path');\nconst capsule=require('./"+CONTEXT+"');");
    text = replaceOnce(text,"function resolvePaths({ env = process.env, sourceDir = __dirname,\n  compiledWorkspace = undefined } = {}) {",
      "function resolvePaths() {\n  if(arguments.length)throw Error('CAPSULE_PATH_OVERRIDE_REFUSED');\n  const env={},sourceDir=capsule.binding.workspaceRoot+'/tools/modding/vortex-agent',compiledWorkspace=capsule.binding.workspaceRoot;");
  }
  if (name === 'owned-zip-relay-client.mjs' || name === 'owned-zip-worker-client.mjs') {
    text = replaceOnce(text, "const HERE = path.dirname(fileURLToPath(import.meta.url));",
      "import capsule from './"+CONTEXT+"';\nconst HERE = path.join(capsule.binding.workspaceRoot,'tools/modding/vortex-agent');");
  }
  if (name === 'owned-zip-relay-client.mjs') {
    text = replaceFunction(text, 'readRelaySourceClosure',
      'export function readRelaySourceClosure() { return capsule.binding.sourceSHA256; }');
    text = replaceOnce(text, 'const runtime = snapshotNativeExecutorRuntimeBinding(runtimeBindingBytes);',
      "const runtime = snapshotNativeExecutorRuntimeBinding(runtimeBindingBytes);\n    need(capsule.role==='main' && equal(runtime,capsule.binding),'CAPSULE_BINDING');");
    text = replaceOnce(text, "child = spawn(RELAY_NODE, [path.join(HERE, 'owned-zip-relay-runner.mjs')], {\n                cwd: HERE,",
      "need(capsule.role==='main','CAPSULE_ROLE');\n            child = spawn(RELAY_NODE, ['-e',capsule.relayBootstrap], {\n                cwd: capsule.binding.workspaceRoot,");
    text = replaceOnce(text, "            await waitFor('ready');",
      "            write(capsule.relayEnvelope,4*1024*1024);\n            await waitFor('ready');");
  }
  if (name === 'owned-zip-worker-client.mjs') {
    text = replaceOnce(text, "const WORK_BASE = path.resolve(HERE, '../../../local-state/owned-zip-worker-work');",
      "const WORK_BASE = path.join(capsule.binding.workspaceRoot,'local-state/owned-zip-worker-work');");
    text = replaceOnce(text, "function sources() {return Object.fromEntries(SOURCES.map(name => [name, fileHash(path.join(HERE, name), 512*1024)]));}",
      'function sources() {return Object.fromEntries(SOURCES.map(name => [name,capsule.pythonExecutionSHA256[name]]));}');
    text = replaceOnce(text, "child = spawn(PYTHON, ['-I', '-S', '-B', path.join(HERE, 'owned-zip-worker.py')], {\n          cwd: HERE,",
      "need(capsule.role==='relay','CAPSULE_ROLE');\n        child = spawn(PYTHON, ['-I', '-S', '-B','-c',capsule.pythonBootstrap], {\n          cwd: capsule.binding.workspaceRoot,");
    text = replaceOnce(text, "        await wait('ready');",
      "        write(capsule.pythonEnvelope,2*1024*1024);\n        await wait('ready');");
  }
  return text;
}

function frozenLiteral(value) {
  return "const freeze=v=>{if(v&&typeof v==='object'){for(const x of Object.values(v))freeze(x);Object.freeze(v);}return v;};\nmodule.exports=freeze("+JSON.stringify(value)+");\n";
}
const MAIN_ENTRY = `
const snapshot=ns=>{const v=Object.create(null);for(const k of Object.keys(ns))v[k]=ns[k];return Object.freeze(v);};
const modules=Object.create(null);
modules['native-executor-journal.mjs']=snapshot(require('./native-executor-journal.mjs'));
modules['owned-zip-relay-client.mjs']=snapshot(require('./owned-zip-relay-client.mjs'));
modules['owned-zip-worker-client.mjs']=snapshot(require('./owned-zip-worker-client.mjs'));
modules['native-dispatch-contract.cjs']=snapshot(require('./native-dispatch-contract.cjs'));
modules['install-job-contract.cjs']=snapshot(require('./install-job-contract.cjs'));
module.exports=Object.freeze({modules:Object.freeze(modules)});
`;

/** compiler is the already-reviewed build workspace's Rolldown function, not runtime input. */
export async function buildNativeSDKCapsule(capture, runtimeBindingBytes, compiler) {
  need(arguments.length === 3 && typeof compiler === 'function' && !isProxy(compiler), 'COMPILER');
  // All caller data is copied/validated before the first compiler callback or await.
  const originals = new Map(NATIVE_SDK_SOURCE_NAMES.map(name => [name,readCapturedNativeSDKSource(capture,name)]));
  const binding = snapshotNativeExecutorRuntimeBinding(runtimeBindingBytes);
  need(NATIVE_SDK_SOURCE_NAMES.every(name => sha(originals.get(name)) === binding.sourceSHA256[name]), 'SOURCE_PIN');
  const python = buildPythonSDKCapsule(capture,binding.workspaceRoot);
  const common = {schema:'native-sdk-capsule-context/1',binding,
    pythonBootstrap:python.bootstrap,pythonEnvelope:JSON.parse(python.envelope),
    pythonExecutionSHA256:python.executionSHA256};
  const js = new Map([...originals].filter(([name]) => !name.endsWith('.py'))
    .map(([name,bytes]) => [name,adapt(name,bytes)]));
  const transformations = Object.freeze(Object.fromEntries([...js].map(([name,code]) => [name,sha(Buffer.from(code))])));
  async function bundle(role, context) {
    const entry = PREFIX+role+'.cjs', loaded = [], resolved = [];
    const virtual = new Map(js);
    virtual.set(CONTEXT,frozenLiteral(context));
    virtual.set(role+'.cjs',role==='main'?MAIN_ENTRY:"require('./owned-zip-relay-runner.mjs');\n");
    const build = await compiler({input:entry,platform:'node',external:()=>false,plugins:[{
      name:'captured-native-sdk-only',
      resolveId(id,importer) {
        resolved.push(id);
        if (id===entry) return entry;
        if (BUILTINS.has(id)) return {id,external:true};
        need(importer?.startsWith(PREFIX) && id.startsWith('./'), 'IMPORT');
        const name=id.slice(2);need(js.has(name)||name===CONTEXT,'IMPORT');
        return PREFIX+name;
      },
      load(id) {
        need(id.startsWith(PREFIX) && virtual.has(id.slice(PREFIX.length)), 'LOAD');
        loaded.push(id);return virtual.get(id.slice(PREFIX.length));
      },
    }],onLog(level,log,defaultHandler){
      if(log.code==='UNRESOLVED_IMPORT')defaultHandler('error',log);
      else if(level==='error')defaultHandler(level,log);
    }});
    try {
      const {output}=await build.generate({format:'cjs',codeSplitting:false,sourcemap:false,minify:false});
      const chunks=output.filter(v=>v.type==='chunk');need(chunks.length===1,'CHUNKS');
      const chunk=chunks[0];
      need(chunk.imports.every(id=>BUILTINS.has(id))
        && chunk.dynamicImports.every(id=>id===chunk.fileName), 'OUTPUT_IMPORT');
      need(Buffer.byteLength(chunk.code)>0 && Buffer.byteLength(chunk.code)<=2*1024*1024,'OUTPUT_LIMIT');
      return {code:chunk.code,sha256:sha(Buffer.from(chunk.code)),
        inputs:Object.freeze(loaded),imports:Object.freeze([...chunk.imports]),
        dynamicImports:Object.freeze([...chunk.dynamicImports]),resolved:Object.freeze(resolved)};
    } finally {await build.close();}
  }
  const relay = await bundle('relay',{...common,role:'relay'});
  const node = buildNodeSDKBootstrap(Buffer.from(relay.code));
  const main = await bundle('main',{...common,role:'main',relayBootstrap:node.bootstrap,
    relayEnvelope:JSON.parse(node.envelope)});
  const artifact = {schema:'native-sdk-capsule/1',binding,
    main:{code:Buffer.from(main.code).toString('base64'),sha256:main.sha256},
    relay:{codeSHA256:relay.sha256,envelopeSHA256:sha(Buffer.from(node.envelope))},
    python:{originalSHA256:python.originalSHA256,executionSHA256:python.executionSHA256},
    transformedJavaScriptSHA256:transformations};
  const encoded=Buffer.from(JSON.stringify(artifact));
  need(encoded.length<=4*1024*1024,'ARTIFACT_LIMIT');
  return Object.freeze({artifact:encoded.toString('utf8'),sha256:sha(encoded),
    mainInputs:main.inputs,relayInputs:relay.inputs,
    relayBootstrap:node.bootstrap,relayEnvelope:node.envelope,nativeAdmission:false});
}
