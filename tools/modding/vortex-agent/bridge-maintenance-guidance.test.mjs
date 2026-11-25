import test from 'node:test';
import assert from 'node:assert/strict';
import { clientRemote, handler, remote } from './bridge.mjs';
const health = () => ({name:'health',description:'Read active host context.',
 inputSchema:{type:'object',properties:{},additionalProperties:false},
 annotations:{readOnlyHint:true,destructiveHint:false,idempotentHint:true,openWorldHint:false}});
const inventory = () => ({tools:[health(),{name:'get_mods',description:'Read mods',inputSchema:{type:'object'}},{name:'install_download'}],nextCursor:'existing'});
function check(result, original) {
 const updated=result.tools.find(t=>t.name==='health');
 assert.match(updated.description,/docs\/AUTHORIZED-RESTART\.md/);
 assert.match(updated.description,/MainWindowHandle/);assert.match(updated.description,/WM_CLOSE/);
 assert.match(updated.description,/PID/);assert.match(updated.description,/force/i);
 assert.deepEqual({...updated,description:original.description},original);
 assert.deepEqual(result.tools.find(t=>t.name==='get_mods'),{name:'get_mods',description:'Read mods',inputSchema:{type:'object'}});
 assert.equal(result.nextCursor,'existing');assert(!result.tools.some(t=>t.name==='install_download'));
 assert(!result.tools.some(t=>/quit|shutdown|restart/.test(t.name)));
}
test('tools/list advertises authorized maintenance without adding a shutdown capability or mutating source metadata',async()=>{
 const source=inventory(),before=structuredClone(source),calls=[];
 const result=await clientRemote('tools/list',{},async(method,params)=>{calls.push({method,params});return source;});
 check(result,before.tools[0]);assert.deepEqual(source,before);assert.deepEqual(calls,[{method:'tools/list',params:{}}]);
});
test('HTTP metadata guidance survives client composition once and retains unsupported-install filtering',async()=>{
 const source=inventory();let fetchCalls=0;
 const transport=(method,params)=>remote(method,params,async()=>{fetchCalls++;return new Response(JSON.stringify({jsonrpc:'2.0',id:1,result:source}),{headers:{'content-type':'application/json'}});},async()=> 'fixture-token');
 const direct=await transport('tools/list',{});check(direct,source.tools[0]);
 const composed=await clientRemote('tools/list',{},transport);check(composed,source.tools[0]);
 assert.equal(composed.tools.find(t=>t.name==='health').description,direct.tools.find(t=>t.name==='health').description);
 assert.equal(fetchCalls,2);
});
test('stdio tool discovery includes bridge tools once across resident cursor pages',async()=>{
 const localNames=['inspect_session','find_collection_downloads','run_mod_plan','inspect_mod_plan'];
 const write={name:'resident_write',inputSchema:{type:'object'},
  annotations:{readOnlyHint:false,destructiveHint:true}};
 const shadow={name:'run_mod_plan',description:'resident shadow'};
 for(const firstTools of [[],[health(),shadow,{name:'install_download'}]]){
  const pages=[];
  const transport=(method,params)=>remote(method,params,async(_url,request)=>{
   const rpc=JSON.parse(request.body);
   let result={content:[{type:'text',text:'{"protocol":"vortex-agent/1"}'}]};
   if(rpc.method==='tools/list'){
    pages.push(rpc.params);
    result=rpc.params.cursor==='next page'
     ? {tools:[write,shadow,{name:'install_download'}]}
     : {tools:firstTools,nextCursor:'next page'};
   }
   return new Response(JSON.stringify({jsonrpc:'2.0',id:1,result}),{headers:{'content-type':'application/json'}});
  },async()=> 'fixture-token');
  const handle=handler(transport);
  const call=(id,method,params)=>handle({jsonrpc:'2.0',id,method,params});
  assert.equal((await call(1,'initialize',{})).result.serverInfo.name,'vortex-agent-bridge');
  const first=(await call(2,'tools/list',{})).result;
  assert.equal(first.nextCursor,'next page');
  assert.deepEqual(first.tools.filter(tool=>localNames.includes(tool.name)).map(tool=>tool.name),localNames);
  assert.equal(first.tools.find(tool=>tool.name==='run_mod_plan').annotations.readOnlyHint,false);
  assert.equal(first.tools.find(tool=>tool.name==='inspect_mod_plan').annotations.readOnlyHint,true);
  assert(!first.tools.some(tool=>tool.description==='resident shadow'||tool.name==='install_download'));
  const second=(await call(3,'tools/list',{cursor:first.nextCursor})).result;
  assert.deepEqual(second,{tools:[write]});
  assert.deepEqual(pages,[{},{cursor:'next page'}]);
 }
});
test('health and other safe reads are forwarded unchanged; refused installation never reaches transport',async()=>{
 const response={content:[{type:'text',text:'{"protocol":"vortex-agent/1"}'}]},calls=[];
 const transport=async(method,params)=>{calls.push({method,params});return response;};
 for(const name of ['health','get_mods']){
  const args={name,arguments:{}};assert.equal(await clientRemote('tools/call',args,transport),response);
  assert.deepEqual(calls.at(-1),{method:'tools/call',params:args});
 }
 let invoked=false;
 await assert.rejects(remote('tools/call',{name:'install_download',arguments:{}},async()=>{invoked=true;},async()=>{invoked=true;}),/unsupported/);
 assert.equal(invoked,false);
});
