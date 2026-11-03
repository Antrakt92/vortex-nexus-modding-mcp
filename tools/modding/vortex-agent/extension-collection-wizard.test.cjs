'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const test = require('node:test');

// Execute the maintained registration/start code with explicit MCP, schema and
// host collaborators. This checks wiring, not Zod implementation or native UI.
function fixture() {
  const calls = [], tools = new Map(), controllers = new WeakMap(), dialogs = new WeakMap(), prompts = new WeakMap();
  function schema(kind, value) {
    const node = {kind, value, constraints: {}};
    for (const key of ['min', 'max', 'regex', 'default']) node[key] = v => {node.constraints[key] = v; return node;};
    for (const key of ['int', 'positive', 'nonnegative', 'optional']) node[key] = () => {node.constraints[key] = true; return node;};
    return node;
  }
  const z = Object.fromEntries(['string', 'number', 'boolean', 'strictObject', 'enum', 'literal', 'array', 'record']
    .map(kind => [kind, value => schema(kind, value)]));
  const selectors = {}, util = {}, api = {};
  let operationsOptions;
  const operations = {advance_collection_update_prompt:async args=>{calls.push(['prompt',args]);return {operation:'advance_collection_update_prompt',...args};},respond_collection_dialog:async args=>{calls.push(['respond',args]);return {operation:'respond_collection_dialog',...args};},advance_collection_wizard: async args => {calls.push(['advance', args]); return {operation:'advance_collection_wizard', ...args};}};
  const modules = {
    'node:http': {createServer() {calls.push(['createServer']); return {on(){}, listen(){calls.push(['listen']);}};}},
    '@modelcontextprotocol/server': {McpServer: class {}},
    '@modelcontextprotocol/node': {localhostHostValidation:()=>()=>true, localhostOriginValidation:()=>()=>true},
    zod: {z}, '@nexusmods/vortex-api': {selectors, util, actions:{}, log(){}},
    './guard.cjs': {createOperations(_api, _actions, _selectors, options) {operationsOptions=options; return operations;}, safe:x=>x},
    './collection-wizard-controller.cjs': {getCollectionWizardController(owner, options) {
      assert.equal(options.selectors, selectors); assert.equal(options.util, util);
      calls.push(['controller', owner]);
      if (!controllers.has(owner)) controllers.set(owner, {dialogBinding:()=>({epochReady:true}),readiness:async()=>({status:'idle', nativeTransitionVerified:false})});
      return controllers.get(owner);
    }},
    './collection-dialog-controller.cjs': {createCollectionDialogController(owner, options) {calls.push(['dialog',owner]);assert.equal(options.selectors,selectors);assert.equal(options.util,util);const d={readiness:async()=>({status:'held',sourceAdmitted:false}),getBinding:options.getBinding};dialogs.set(owner,d);return d;}},
    './collection-update-prompt.cjs': {getCollectionUpdatePromptController(owner){calls.push(['updateController',owner]);if(!prompts.has(owner))prompts.set(owner,{readiness:async()=>({status:'idle',nativePromptDismissalVerified:false})});return prompts.get(owner);}},
    './download-identity.cjs': {catalogFromDisk:()=>({})},
    './installed-candidate-assessment.cjs': {LIMITS:{comparisons:20}},
    './local-install-binding.cjs': {localInstallAdmission:()=>async()=>({})},
    './http-ingress.cjs': {acquire:()=>()=>{}},
    './serialization.cjs': {publicErrorCode:e=>e.message},
    './receipts.cjs': {VERIFICATION:'external'},
    './install-diagnostics.cjs': {PHASES:[], STATES:[], REASONS:[], WAITS:[], METRICS:[]},
  };
  const module = {exports:{}};
  vm.runInNewContext(fs.readFileSync(__dirname+'/extension.cjs', 'utf8'), {
    module, require:name=>modules[name]??{}, AbortController, setTimeout, clearTimeout,
  }, {timeout:1000});
  const server={registerTool(name, config, handler) {assert.ok(!tools.has(name)); tools.set(name,{config,handler});}};
  return {api, calls, tools, server, extension:module.exports, controllers, dialogs, prompts, options:()=>operationsOptions};
}

test('wizard controller exists before listener and is reused by operation registration', () => {
  const f=fixture(); f.extension.start(f.api);
  assert.equal(f.calls[0][0], 'controller'); assert.equal(f.calls[1][0], 'dialog'); assert.equal(f.calls[2][0], 'updateController'); assert.equal(f.calls[3][0], 'createServer');
  f.extension.register(f.server, f.api);
  assert.equal(f.options().wizard, f.controllers.get(f.api));
  const other={}; const server={registerTool(){}}; f.extension.register(server,other);
  assert.notEqual(f.options().wizard, f.controllers.get(f.api));
});

test('read wizard is strict no-argument inspection routed to cached readiness', async () => {
  const f=fixture(); f.extension.register(f.server,f.api);
  const t=f.tools.get('read_collection_wizard');
  assert.equal(t.config.inputSchema.kind,'strictObject');
  assert.deepEqual(Object.keys(t.config.inputSchema.value),[]);
  assert.equal(t.config.annotations.readOnlyHint,true);
  assert.equal(t.config.annotations.destructiveHint,false);
  assert.equal(t.config.outputSchema,undefined);
  assert.deepEqual(JSON.parse((await t.handler({})).content[0].text),{status:'idle',nativeTransitionVerified:false});
  assert.equal(f.calls.some(c=>c[0]==='advance'),false);
});

test('advance keeps full guarded context and fixed wizard identities/actions', async () => {
  const f=fixture(); f.extension.register(f.server,f.api);
  const t=f.tools.get('advance_collection_wizard'), fields=t.config.inputSchema.value;
  assert.equal(t.config.inputSchema.kind,'strictObject');
  assert.deepEqual(Object.keys(fields).sort(), ['gameId','profileId','requestId','gamePath','stagingPath','downloadPath','filesystemIds',
    'modId','archiveId','collectionId','revisionId','revisionNumber','action'].sort());
  assert.equal(fields.filesystemIds.kind,'strictObject');
  assert.deepEqual(Object.keys(fields.filesystemIds.value).sort(),['downloadPath','gamePath','stagingPath']);
  for (const key of ['collectionId','revisionId','revisionNumber']) {
    assert.equal(fields[key].kind,'number'); assert.equal(fields[key].constraints.int,true);
    assert.equal(fields[key].constraints.positive,true); assert.equal(fields[key].constraints.max,Number.MAX_SAFE_INTEGER);
  }
  assert.deepEqual(Array.from(fields.action.value),['install_now','done']);
  assert.equal(fields.modId.kind,'string'); assert.equal(fields.archiveId.kind,'string');
  assert.equal(fields.requestId.constraints.regex.test('request_123'),true);
  assert.equal(fields.requestId.constraints.regex.test('bad'),false);
  assert.equal(t.config.annotations.readOnlyHint,false); assert.equal(t.config.annotations.destructiveHint,true);
  const args={requestId:'request_123',action:'done'};
  const response=await t.handler(args);
  assert.equal(f.calls.find(c=>c[0]==='advance')[1],args);
  assert.equal(response.structuredContent.operation,'advance_collection_wizard');
  assert.equal(response.structuredContent.action,'done');
});

test('completion schema retains old operations and includes exact wizard transition fields', () => {
  const f=fixture(); f.extension.register(f.server,f.api);
  const status=f.tools.get('advance_collection_wizard').config.outputSchema;
  assert.equal(status.kind,'strictObject');
  assert.deepEqual(Array.from(status.value.operation.value),['install_download','install_local_archive','set_mods_enabled','deploy_mods','download_nexus','advance_collection_wizard','respond_collection_dialog','advance_collection_update_prompt']);
  for(const key of ['archiveId','collectionId','revisionId','revisionNumber','action','transition','nativeTransitionVerified']) {
    assert.equal(status.value[key].constraints.optional,true,key);
  }
  assert.deepEqual(Array.from(status.value.transition.value),['started','finished']);
  assert.equal(status.value.nativeTransitionVerified.value,true);
  assert.equal(status.value.diskDeploymentVerified.value,false);
  assert.equal(f.tools.get('deploy_mods').config.outputSchema,status);
});


test('dialog observer is created once per api before listen and reused across registrations',()=>{
 const f=fixture();f.extension.start(f.api);const d=f.dialogs.get(f.api);f.extension.register(f.server,f.api);f.extension.register({registerTool(){}},f.api);
 assert.equal(f.options().dialog,d);assert.equal(f.calls.filter(c=>c[0]==='dialog').length,1);assert.equal(d.getBinding().epochReady,true);
 const other={};f.extension.register({registerTool(){}},other);assert.notEqual(f.options().dialog,d);
});
test('dialog tools expose only empty read and guarded fixed response schema',async()=>{
 const f=fixture();f.extension.register(f.server,f.api);const read=f.tools.get('read_collection_dialog'),write=f.tools.get('respond_collection_dialog');
 assert.deepEqual(Object.keys(read.config.inputSchema.value),[]);assert.equal(read.config.annotations.readOnlyHint,true);
 assert.deepEqual(JSON.parse((await read.handler({})).content[0].text),{status:'held',sourceAdmitted:false});
 assert.deepEqual(Object.keys(write.config.inputSchema.value).sort(),['gameId','profileId','requestId','gamePath','stagingPath','downloadPath','filesystemIds','modId','archiveId','collectionId','revisionId','revisionNumber','dialogId','action'].sort());
 assert.equal(write.config.inputSchema.value.action.value,'update_current_profile');assert.equal(write.config.annotations.destructiveHint,true);
 const args={requestId:'request_dialog_01',action:'update_current_profile'};const result=await write.handler(args);assert.equal(result.structuredContent.operation,'respond_collection_dialog');assert.equal(f.calls.find(c=>c[0]==='respond')[1],args);
});

test('update prompt observer is initialized before listener and reused as exact named guard controller',async()=>{const f=fixture();f.extension.start(f.api);f.extension.register(f.server,f.api);assert.equal(f.options().updatePrompt,f.prompts.get(f.api));const r=f.tools.get('read_collection_update_prompt'),w=f.tools.get('advance_collection_update_prompt');assert.deepEqual(Object.keys(r.config.inputSchema.value),[]);assert.equal(r.config.annotations.readOnlyHint,true);assert.deepEqual(JSON.parse((await r.handler({})).content[0].text),{status:'idle',nativePromptDismissalVerified:false});assert.deepEqual(Object.keys(w.config.inputSchema.value).sort(),['gameId','profileId','requestId','gamePath','stagingPath','downloadPath','filesystemIds','oldModId','collectionId','collectionSlug','revisionNumber','action'].sort());assert.equal(w.config.inputSchema.value.action.value,'download_update');const a={requestId:'prompt_request_01',action:'download_update'};assert.equal((await w.handler(a)).structuredContent.operation,'advance_collection_update_prompt');});
