// Pure source expressions + actual pinned Zone. No Main, SDK, SQL or host actors.
import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {stripTypeScriptTypes} from 'node:module';
import {types} from 'node:util';
import {nativePromiseFixturesAvailable,nativePromiseFixtureReason,nativePromiseSourceFixture} from './native-promise-source-fixture.mjs';
if(!nativePromiseFixturesAvailable){test('native renderer Promise source/Zone acceptance inputs',{skip:nativePromiseFixtureReason},()=>{});}else{
const {renderer:source,ts,zone}=nativePromiseSourceFixture();
const variant='fixed';
const sf=ts.createSourceFile('actual-extension.ts',source,ts.ScriptTarget.Latest,true);
const strip=s=>stripTypeScriptTypes(s,{mode:'transform'});
const cls=sf.statements.find(n=>ts.isClassDeclaration(n)&&n.name?.text==='ExtensionManager');assert(cls);
const names=['cancelNativeExecutorPrepared','handoffNativeExecutorCancellationSuccessor','handoffNativeExecutorSuccessor','executeNativeExecutor'];
const controls=names.map(name=>{
 const method=cls.members.find(n=>n.name?.getText(sf)===name);assert(method,name);
 const nodes=[],guards=[];function walk(n){if(ts.isNewExpression(n)&&n.expression.getText(sf)==='Promise'&&n.getText(sf).includes('flight'))nodes.push(n);if(ts.isIfStatement(n)&&n.expression.getText(sf).includes('isPromise(flight)')&&n.expression.getText(sf).includes('isProxy(flight)'))guards.push(n);ts.forEachChild(n,walk);}walk(method);
 assert.equal(nodes.length,1,name);assert.equal(guards.length,1,name);
 return{name,expression:nodes[0].getText(sf),guard:guards[0].getText(sf)};
});
const helper=sf.statements.find(n=>ts.isFunctionDeclaration(n)&&n.name?.text==='observeNativeRendererPromise');
if(variant==='fixed'){assert(helper);assert.equal((source.match(/observeNativeRendererPromise\(/g)??[]).length,9);assert(!source.includes('Promise.prototype.then.call'));}
function fixture(control){
 const timers=new Set(),ctx=vm.createContext({nativeReadinessTypes:types,console:{error(){},warn(){},log(){}},setTimeout:(f,ms)=>{const t=setTimeout(f,ms);timers.add(t);return t;},clearTimeout:t=>{timers.delete(t);clearTimeout(t);},setInterval,clearInterval,queueMicrotask});
 vm.runInContext('globalThis.NativeBefore=Promise;globalThis.rawPrimary={own:true};globalThis.rawNull=null;globalThis.rawUndefined=undefined;globalThis.fulfilled=[];globalThis.rejected=[];',ctx);
 vm.runInContext(zone,ctx,{filename:'actual-pinned-zone.umd.js'});
 const body=helper?helper.getText(sf):'';
 const code=`${body}\nclass SourceControl{#nativeTransportError(){return Error('NATIVE_EXECUTOR_RENDERER_FAILED')}#nativeSuccessorError(){return Error('NATIVE_EXECUTOR_SUCCESSOR_HELD')}run(flight,invalidated,record){let timer;${control?.guard??''}return ${control?.expression??'undefined'};}}globalThis.actor=new SourceControl();`;
 vm.runInContext(strip(code),ctx);
 return{ctx,close(){for(const t of timers)clearTimeout(t);timers.clear();},run(s){return vm.runInContext(s,ctx)}};
}
const tick=()=>new Promise(r=>setImmediate(r));
for(const control of controls){
 test(control.name+': actual source control observes native flight after eager Zone and retains native guard',async()=>{
  const f=fixture(control);try{
   f.run('globalThis.gate=new NativeBefore(r=>globalThis.resolveFlight=r);globalThis.flight=(async()=>await gate)();globalThis.invalidated=new Promise(r=>globalThis.invalidate=r);globalThis.record={primarySet:false,invalidated};globalThis.done=false;globalThis.result=actor.run(flight,invalidated,record);globalThis.observed=(async()=>{const v=await result;done=true;return v})();');
   assert.equal(types.isPromise(f.ctx.flight),true);assert.equal(types.isPromise(f.ctx.invalidated),false,'actual Zone control remains nonnative');await tick();assert.equal(f.ctx.done,false);
   f.run('resolveFlight(42)');assert.equal(await f.ctx.observed,42);assert.equal(f.ctx.done,true);
   const nonnative=f.run('Promise.resolve(7)');assert.throws(()=>f.ctx.actor.run(nonnative,f.ctx.invalidated,{}),/NATIVE_EXECUTOR_/);
  }finally{f.close();}
 });
 for(const primary of ['null','undefined'])test(control.name+': exact '+primary+' native rejection is retained',async()=>{
  const f=fixture(control);try{f.run(`globalThis.flight=(async()=>{throw ${primary}})();globalThis.invalidated=new Promise(()=>{});globalThis.record={primarySet:false,invalidated};globalThis.result=actor.run(flight,invalidated,record);`);let caught=false;try{await f.ctx.result;}catch(error){caught=true;assert.equal(error,primary==='null'?null:undefined);}assert(caught);}finally{f.close();}
 });
}
for(const name of names.slice(0,3))test(name+': actual Zone invalidation control rejects before late native fulfilment',async()=>{
 const f=fixture(controls.find(c=>c.name===name));try{
  f.run('globalThis.gate=new NativeBefore(r=>globalThis.resolveFlight=r);globalThis.flight=(async()=>await gate)();globalThis.invalidated=new Promise(r=>globalThis.invalidate=r);globalThis.record={primarySet:true,primary:null,invalidated};globalThis.result=actor.run(flight,invalidated,record);globalThis.observed=(async()=>{try{await result;return {ok:true}}catch(primary){return {ok:false,primary}}})();invalidate();');
  const r=await f.ctx.observed;assert.equal(r.ok,false);if(name==='cancelNativeExecutorPrepared')assert.equal(r.primary,null);else assert.match(r.primary.message,/NATIVE_EXECUTOR_/);
  f.run('resolveFlight(99)');await tick();assert.equal((await f.ctx.observed).ok,false,'late work cannot replace held observation');
 }finally{f.close();}
});
test('observer separates callback failures and works after eager Zone without intrinsic lookup',async()=>{
 assert(helper,'fixed helper only');const f=fixture();try{
  f.run(`globalThis.completed=(async()=>{await observeNativeRendererPromise((async()=>1)(),()=>{fulfilled.push('called');throw rawPrimary},e=>rejected.push(e));await observeNativeRendererPromise((async()=>{throw rawNull})(),()=>fulfilled.push('wrong'),e=>{rejected.push(e);throw rawPrimary});})();`);
  await f.ctx.completed;assert.equal(f.ctx.fulfilled.length,1);assert.equal(f.ctx.rejected.length,1);assert.equal(f.ctx.rejected[0],null);
 }finally{f.close();}
});
test('observer reentry remains a single observed source callback and does not replay settled late work',async()=>{
 assert(helper,'fixed helper only');const f=fixture();try{
  f.run(`globalThis.hold=false;globalThis.count=0;globalThis.completed=(async()=>{await observeNativeRendererPromise((async()=>1)(),()=>{count++;hold=true;void observeNativeRendererPromise((async()=>2)(),()=>{if(!hold)count++},()=>{})},()=>{});})();`);
  await f.ctx.completed;await tick();assert.equal(f.ctx.hold,true);assert.equal(f.ctx.count,1);
 }finally{f.close();}
});
}
