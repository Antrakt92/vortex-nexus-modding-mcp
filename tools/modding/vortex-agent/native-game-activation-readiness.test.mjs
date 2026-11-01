// Root-run source tests. No host constructor, filesystem game setup or Main/IPC effects.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {createRequire,stripTypeScriptTypes} from 'node:module';
import {types as utilTypes} from 'node:util';
import {fileURLToPath} from 'node:url';
import {original} from './native-query-source-admission.test.mjs';
import {applyExact} from './native-patch-test-fixture.mjs';
const HERE=new URL('./',import.meta.url),req=createRequire(import.meta.url);
const sha=x=>createHash('sha256').update(x).digest('hex');
const SPEC=Object.freeze({
  "manager": {
    "name": "native-manager-activation-readiness",
    "packet": "lifecycle",
    "path": "src/renderer/src/extensions/mod_management/InstallManager.ts",
    "inputSHA256": "fa286ebca414fc3368de7ef7b50a71a7c5327768098c42f8aabda1a4e7d1bdad",
    "outputSHA256": "dc5409b22d01df8c0913d8b0d0bc52ca519d5ba7979a68f31514503faad10741",
    "patchSHA256": "caa9daff75ca4bcfe6b37f1c0d84332cec10f7f8e06ed2d58addaad6223407bd",
    "originalSHA256": "577d56a8728052069f850face9bb57437dbf2886bd41409fe6a66cfefc08ed33",
    "parent": {
      "name": "native-manager-inert-release",
      "packet": "lifecycle",
      "patchSHA256": "00c4050a245027f66b721c86f3491ef7e94aee03f1e36da4d2382e221294ebcd",
      "outputSHA256": "fa286ebca414fc3368de7ef7b50a71a7c5327768098c42f8aabda1a4e7d1bdad"
    },
    "dependencies": []
  },
  "game": {
    "name": "native-gamemode-activation-lifetime",
    "packet": "lifecycle",
    "path": "src/renderer/src/extensions/gamemode_management/index.ts",
    "inputSHA256": "730912e97b01240f4d58887ee8e1a4af7868788e36d1054063f4f90b140990ee",
    "outputSHA256": "86ea4ad9f85fd015e0a27197fdeefe2ee48b4859cfecb884d1543b0043ffb01b",
    "patchSHA256": "b8dd10b9780ea1d96da54ab8d49d713169feecb8380e32157edccaa2e82b8f10",
    "originalSHA256": "730912e97b01240f4d58887ee8e1a4af7868788e36d1054063f4f90b140990ee",
    "parent": null,
    "dependencies": [
      {
        "name": "native-manager-activation-readiness",
        "packet": "lifecycle",
        "patchSHA256": "caa9daff75ca4bcfe6b37f1c0d84332cec10f7f8e06ed2d58addaad6223407bd",
        "outputSHA256": "dc5409b22d01df8c0913d8b0d0bc52ca519d5ba7979a68f31514503faad10741"
      }
    ]
  },
  "module": {
    "name": "native-manager-activation-binding",
    "packet": "lifecycle",
    "path": "src/renderer/src/extensions/mod_management/index.ts",
    "inputSHA256": "8a4ce258658ad2c9c64ae4b3e70c908c923e3c6d142e75bd67218dcce273f157",
    "outputSHA256": "48055381da85cb2fe9e2cbbbc2e6ea9947c8158deb3564ea2f4706d33b5bb50b",
    "patchSHA256": "218510980ae1d63017cb11b9e75e7587a1948db3f1d4dc420684eca5694ccb12",
    "originalSHA256": "d895c7614a692242e1921fa0d9fba1a52743bcd9aed5b1bcac9a539d393b2400",
    "parent": {
      "name": "native-manager-instance-access",
      "packet": "lifecycle",
      "patchSHA256": "e1725d7308577fbf003ba55bbc3067b9a4f15cbc9d92d6cc5bb7c9706596b731",
      "outputSHA256": "8a4ce258658ad2c9c64ae4b3e70c908c923e3c6d142e75bd67218dcce273f157"
    },
    "dependencies": [
      {
        "name": "native-manager-activation-readiness",
        "packet": "lifecycle",
        "patchSHA256": "caa9daff75ca4bcfe6b37f1c0d84332cec10f7f8e06ed2d58addaad6223407bd",
        "outputSHA256": "dc5409b22d01df8c0913d8b0d0bc52ca519d5ba7979a68f31514503faad10741"
      }
    ]
  },
  "extension": {
    "name": "native-renderer-activation-readiness",
    "packet": "persistence",
    "path": "src/renderer/src/ExtensionManager.ts",
    "inputSHA256": "e85b35a5fa63df53c93e349dd74441666f13e49c397847f2a8c8c94c3e4de910",
    "outputSHA256": "8230de4bb46e2dc26d0e9a817a1618b4a3cd1356daf26fed129590df1525eb49",
    "patchSHA256": "99bb2904dfc1c36f4c86c199f0abe39dda881268e0d566b2e74f5b23a32a2fac",
    "originalSHA256": "5d0de2194cf413938e61a398494196af07677dc6d0d014216ba3b25b5a211b95",
    "parent": {
      "name": "native-renderer-executor-cancellation",
      "packet": "persistence",
      "patchSHA256": "4a755dbbdec6d08fbd550a8ab4de9340e2340ff19fe92329a77bfedc007f614e",
      "outputSHA256": "e85b35a5fa63df53c93e349dd74441666f13e49c397847f2a8c8c94c3e4de910"
    },
    "dependencies": [
      {
        "name": "native-manager-activation-binding",
        "packet": "lifecycle",
        "patchSHA256": "218510980ae1d63017cb11b9e75e7587a1948db3f1d4dc420684eca5694ccb12",
        "outputSHA256": "48055381da85cb2fe9e2cbbbc2e6ea9947c8158deb3564ea2f4706d33b5bb50b"
      }
    ]
  },
  "event": {
    "name": "native-mod-activation-refresh",
    "packet": "lifecycle",
    "path": "src/renderer/src/extensions/mod_management/eventHandlers.ts",
    "inputSHA256": "2d2a7247a50ad6e010c2018b970bf54ab6d205a2a8cf6fed89e070258f39f9d0",
    "outputSHA256": "bc0ad0cd8e1f8f13b1c5882e68094c15dbd87a9036ec03957fed818ad33e682c",
    "patchSHA256": "51620a96067d9132bc228426a339ba8a9266f200a1fe78d89fff5117c0b36d9c",
    "originalSHA256": "c45773ac110808acb3a3bf79bdcb1b3cab1ef498c6ddfdf7c29f11abb60733eb",
    "parent": {
      "name": "handler-promise-types",
      "packet": "lifecycle",
      "patchSHA256": "4f89edaf51ccc801d3ea2dbedd57e8241496b34df37efb2d57fb40be3b643388",
      "outputSHA256": "2d2a7247a50ad6e010c2018b970bf54ab6d205a2a8cf6fed89e070258f39f9d0"
    },
    "dependencies": [
      {
        "name": "native-manager-activation-readiness",
        "packet": "lifecycle",
        "patchSHA256": "caa9daff75ca4bcfe6b37f1c0d84332cec10f7f8e06ed2d58addaad6223407bd",
        "outputSHA256": "dc5409b22d01df8c0913d8b0d0bc52ca519d5ba7979a68f31514503faad10741"
      }
    ]
  }
});
const SOURCES=new Map(),MANIFESTS=new Map();
function packetRoot(packet){assert(['lifecycle','persistence'].includes(packet));return new URL('./native-patches/'+(packet==='lifecycle'?'vortex-2.9.1':'vortex-persistence-2.9.1')+'/',HERE);}
function packet(row){const root=packetRoot(row.packet),m=JSON.parse(fs.readFileSync(new URL(row.name+'.json',root),'utf8')),patch=fs.readFileSync(new URL(row.name+'.patch',root),'utf8');assert.equal(sha(patch),m.patchSHA256);assert.equal(m.patchSHA256,row.patchSHA256);return{m,patch};}
function read(name){
 if(SOURCES.has(name))return SOURCES.get(name);
 assert(Object.hasOwn(SPEC,name),'fixed source-only family');const spec=SPEC[name];
 const graph=JSON.parse(fs.readFileSync(new URL('./native-source-series.json',HERE),'utf8'));
 const file=graph.files.find(r=>r.path===spec.path);assert(file);assert.equal(file.originalSHA256,spec.originalSHA256);
 let source=original(spec.path).toString('utf8');assert.equal(sha(source),spec.originalSHA256);
 const rows=graph.patches.filter(r=>r.path===spec.path);let found=false;
 for(const row of rows){const{m,patch}=packet(row);assert.equal(m.upstreamPath,spec.path);assert.equal(m.upstreamCommit,'c80326367cbe6d96621ad6cf4a5488ef49bac110');assert.equal(sha(source),m.inputSHA256);source=applyExact(source,patch,spec.path);assert.equal(sha(source),m.outputSHA256);assert.equal(m.outputSHA256,row.outputSHA256);
  if(row.name===spec.name){assert.equal(row.packet,spec.packet);assert.equal(m.inputSHA256,spec.inputSHA256);assert.equal(m.outputSHA256,spec.outputSHA256);assert.equal(m.patchSHA256,spec.patchSHA256);MANIFESTS.set(name,m);found=true;break;}}
 assert(found,'maintained activation producer required');assert.equal(sha(source),spec.outputSHA256);SOURCES.set(name,source);return source;
}
function metadata(){
 for(const[name,s]of Object.entries(SPEC)){read(name);const m=MANIFESTS.get(name);assert.equal(m.preparedOnly,true);for(const key of ['installed','nativeAcceptanceVerified','installationPermit'])assert.equal(m[key],false);
  if(s.parent){assert.equal(m.prerequisitePatch,s.parent.name+'.patch');assert.equal(m.prerequisitePatchSHA256,s.parent.patchSHA256);assert.equal(s.inputSHA256,s.parent.outputSHA256);}
  const companions=[...(m.additionalCompanions??[])];
  if(m.requiredCompanionPatch)companions.push({name:m.requiredCompanionPatch.slice(0,-6),packet:m.requiredCompanionPacket??s.packet,patchSHA256:m.requiredCompanionPatchSHA256,outputSHA256:m.requiredCompanionOutputSHA256});
  for(const edge of s.dependencies){
   if(edge.name===SPEC.manager.name){
    // Existing fixed manager-reference form: exactly these three lifecycle stages.
    assert(['native-mod-activation-refresh','native-gamemode-activation-lifetime','native-manager-activation-binding'].includes(s.name));
    assert.equal(s.packet,'lifecycle');assert.equal(edge.packet,SPEC.manager.packet);
    assert.equal(edge.patchSHA256,SPEC.manager.patchSHA256);assert.equal(edge.outputSHA256,SPEC.manager.outputSHA256);
    assert.equal(m.requiredManagerPatchSHA256,edge.patchSHA256);
    const graph=JSON.parse(fs.readFileSync(new URL('./native-source-series.json',HERE),'utf8'));
    const before=graph.patches.findIndex(r=>r.name===SPEC.manager.name&&r.packet===SPEC.manager.packet);
    const after=graph.patches.findIndex(r=>r.name===s.name&&r.packet===s.packet);
    assert(before>=0&&after>before,'fixed manager producer must already be applied');
    const producer=graph.patches[before];assert.equal(producer.path,SPEC.manager.path);assert.equal(producer.patchSHA256,edge.patchSHA256);assert.equal(producer.outputSHA256,edge.outputSHA256);
    read('manager');assert.equal(MANIFESTS.get('manager').outputSHA256,edge.outputSHA256);
   }else assert(companions.some(c=>c.name===edge.name&&c.packet===edge.packet&&c.patchSHA256===edge.patchSHA256&&c.outputSHA256===edge.outputSHA256),'exact companion '+s.name+'->'+edge.name);
  }
 }
 assert(!read('extension').includes('__NEXUS_NATIVE_FIXTURE_METADATA_NONCE__'),'fixture network guard excluded from public source');
 assert(read('module').includes('const nativeActivationWaitFixed = InstallManager.prototype.waitNativeGameActivationReady'));
 assert(read('module').includes('const nativeActivationCheckFixed = InstallManager.prototype.checkNativeGameActivationReady'));
}
let tools;
function inputs(){if(tools)return tools;const deps=process.env.VORTEX_EXTENSION_ADMISSION_DEPS;assert(deps,'reviewed dependencies required');
 const tsPath=path.join(deps,'.pnpm/typescript@6.0.3/node_modules/typescript/lib/typescript.js');assert.equal(sha(fs.readFileSync(tsPath)),'569177652966bd528c319171c7dd22860dbf72bde116cbc4f644f1d02bb12e39');
 const reduxPath=path.join(deps,'.pnpm/redux@4.2.1/node_modules/redux/lib/redux.js');assert.equal(sha(fs.readFileSync(reduxPath)),'d6150d2eae3a3379dd0115822fd682e319ea87eb530eb5653dfc1d4734b38a9f');
 return tools={ts:req(tsPath),redux:req(reduxPath)};
}
const tick=()=>new Promise(r=>setImmediate(r));
const deferred=()=>{let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b});return{promise,resolve,reject}};
function ast(text){const{ts}=inputs();return ts.createSourceFile('source.ts',text,ts.ScriptTarget.Latest,true)}
function find(text,predicate){const{ts}=inputs(),sf=ast(text),out=[];function walk(n){if(predicate(n,ts))out.push(n);ts.forEachChild(n,walk)}walk(sf);assert.equal(out.length,1);return{node:out[0],sf};}
function evaluate(text,result,ctx={}){return new Function(...Object.keys(ctx),stripTypeScriptTypes(text.replace(/^export /gm,''),{mode:'transform'})+'\nreturn '+result)(...Object.values(ctx));}
export function activationFixture({profileId='p',gameId='game',onGetState}={}){
 const{redux,ts}=inputs(),clock={now:0},timers=new Map();let next=0;
 const setTimer=(fn,ms)=>{const id=++next;timers.set(id,{fn,at:clock.now+ms});return id},clearTimer=id=>timers.delete(id);
 const source=read('manager'),{node:c}=find(source,(n,t)=>t.isClassDeclaration(n)&&n.name?.text==='InstallManager');
 const fixed=new Set(['mNativeManagers','registerNativeManager','mNativeLegacyCalls','mNativeExclusiveOwner','trackNativeLifecycleCall']);
 const members=c.members.filter(n=>/Activation|activation/.test(n.name?.getText()??'')||fixed.has(n.name?.getText()));
 const tracker=find(source,(n,t)=>t.isVariableStatement(n)&&n.declarationList.declarations.some(d=>d.name.getText()==='nativeActivationTrackLifecycle')).node.getText();
 const checkReady=find(source,(n,t)=>t.isVariableStatement(n)&&n.declarationList.declarations.some(d=>d.name.getText()==='nativeActivationCheckReady')).node.getText();
 class ProcessCanceled extends Error{};
 const Manager=evaluate('class InstallManager{\n'+members.map(n=>n.getText()).join('\n')+'\n}\n'+tracker+'\n'+checkReady,'InstallManager',{utilTypes,ProcessCanceled,nativeActivationClock:{now:()=>clock.now},setTimeout:setTimer,clearTimeout:clearTimer});
 // Full host constructor is omitted. Enrollment uses the actual source method;
 // no readiness phase/owner/set is written by the fixture.
 const manager=new Manager();manager.registerNativeManager();
 const initial={settings:{profiles:{activeProfileId:profileId},gameMode:{discovered:{[gameId]:{path:'/OWN/GAME'}}}},persistent:{profiles:Object.fromEntries([[profileId,{gameId}],['q',{gameId}]])}};
 const store=redux.createStore((s=initial,a)=>a.type==='PROFILE'?{...s,settings:{...s.settings,profiles:{activeProfileId:a.id}}}:a.type==='UNRELATED'?{...s,ordinary:a.value}:s);
 const realGet=store.getState;store.getState=function(){onGetState?.(store);return realGet();};
 const ordinary=[];
 const f={Manager,manager,store,clock,timers,ProcessCanceled,ordinary,
  wait:()=>manager.waitNativeGameActivationReady(store),begin:()=>Manager.beginNativeGameActivation(store,gameId,profileId),
  check:o=>manager.checkNativeGameActivationReady(o,store),observe:(o,w)=>Manager.observeNativeGameActivation(o,w),
  refresh:fn=>Manager.trackNativeGameActivationRefresh(store,gameId,fn),
  profile:id=>store.dispatch({type:'PROFILE',id}),legacy:()=>Manager.mNativeLegacyCalls.size,
  advance(ms){clock.now+=ms;for(const[id,t]of [...timers])if(t.at<=clock.now){timers.delete(id);t.fn();}},
 };
 return f;
}
function gameProducer(f,{setup=deferred(),refresh=deferred()}={}){
 const src=read('game'),{node:n}=find(src,(n,t)=>t.isVariableDeclaration(n)&&n.name.getText()==='changeGameMode');
 const event=read('event'),eventFn=find(event,(n,t)=>t.isFunctionDeclaration(n)&&n.name?.text==='onGameModeActivated').node.getText();
 const api={store:f.store,sendNotification(){f.ordinary.push('notify');return'notification'},dismissNotification(){f.ordinary.push('dismiss')}};
 const events=evaluate(eventFn,'onGameModeActivated',{InstallManager:f.Manager,unknownToError:e=>e,ProcessCanceled:f.ProcessCanceled,UserCanceled:class extends Error{},showError(){},onGameModeActivatedTracked:()=>refresh.promise});
 class UserCanceled extends Error{};class SetupError extends Error{};class DataInvalid extends Error{};
 const game={name:'game',getModPaths(){return{}}};
 const change=evaluate('const changeGameMode='+n.initializer.getText()+';','changeGameMode',{
  InstallManager:f.Manager,store:f.store,context:{api},log(){},getGame:()=>game,PromiseBB:Promise,
  // Explicit selector collaborator: actual discoveryByGame projects discovered[gameId].
  discoveryByGame:(state,id)=>state.settings.gameMode.discovered[id],
  $:{gameModeManager:{setupGameMode:()=>setup.promise,setGameMode(){events(api,[],'game');return Promise.resolve();}}},
  UserCanceled,ProcessCanceled:f.ProcessCanceled,SetupError,DataInvalid,showError(){},setNextProfile:id=>({type:'PROFILE',id}),
 });
 return{setup,refresh,UserCanceled,change:()=>change(undefined,'game',f.store.getState().settings.profiles.activeProfileId)};
}
test('five maintained activation producers bind exact source parents and companions',{skip:!process.env.VORTEX_EXTENSION_ADMISSION_REPO||!process.env.VORTEX_EXTENSION_ADMISSION_DEPS},metadata);
const integration=(n,fn)=>test(n,{skip:!process.env.VORTEX_EXTENSION_ADMISSION_REPO||!process.env.VORTEX_EXTENSION_ADMISSION_DEPS,timeout:10000},fn);
// Actual module startup helpers and context.once wrapper; ordinary once constructor is
// explicitly controlled and installs the actually enrolled partial Manager above.
function moduleFixture(f){
 const text=read('module');
 const variable=name=>find(text,(n,t)=>t.isVariableStatement(n)&&n.declarationList.declarations.some(d=>d.name.getText()===name)).node.getText();
 const func=name=>find(text,(n,t)=>t.isFunctionDeclaration(n)&&n.name?.text===name).node.getText();
 const once=find(text,(n,t)=>t.isExpressionStatement(n)&&t.isCallExpression(n.expression)&&n.expression.expression.getText()==='context.once').node.getText();
 const names=['holdNativeManagerStartup','checkNativeManagerStartup','beginNativeManagerStartup','waitForNativeManagerStartupReady','checkNativeManagerStartupReady','getNativeManagerStartupInstance','waitForNativeGameActivationReady','checkNativeGameActivationReady'];
 let run,state;const events=[];
 state=evaluate([variable('installManager'),variable('nativeManagerStartup'),variable('nativeActivationWaitFixed'),variable('nativeActivationCheckFixed'),...names.map(func),once].join('\n'),
  '({waitForNativeManagerStartupReady,checkNativeManagerStartupReady,waitForNativeGameActivationReady,checkNativeGameActivationReady,setManager:v=>installManager=v})',{
   InstallManager:f.Manager,context:{api:{store:f.store,ext:{}},once:cb=>run=cb},
   once(){events.push('once');state.setManager(f.manager);},extendApi:()=>({}),history:{init(){events.push('history');}},
  });
 return{state,events,run:()=>run()};
}
integration('actual module once tail issues startup owner and captured activation methods survive later prototype override',async()=>{
 const f=activationFixture(),m=moduleFixture(f);await assert.rejects(m.state.waitForNativeManagerStartupReady(f.store),/NATIVE_MANAGER_STARTUP_UNAVAILABLE/);
 m.run();assert.deepEqual(m.events,['once','history']);const startup=await m.state.waitForNativeManagerStartupReady(f.store);assert.ok(Object.isFrozen(startup));
 let substitutes=0;f.Manager.prototype.waitNativeGameActivationReady=()=>{substitutes++;throw Error('substitute');};f.Manager.prototype.checkNativeGameActivationReady=()=>{substitutes++;throw Error('substitute');};
 const pending=m.state.waitForNativeGameActivationReady(startup,f.store),owner=f.begin();f.observe(owner,Promise.resolve());await f.refresh(()=>Promise.resolve());
 const observed=await pending;assert.equal(observed,owner);m.state.checkNativeGameActivationReady(owner,startup,f.store);assert.equal(substitutes,0);
});
integration('actual module wrappers reject forged startup or activation owners and a different actual Redux store',async()=>{
 const f=activationFixture(),m=moduleFixture(f);m.run();const startup=await m.state.waitForNativeManagerStartupReady(f.store);
 await assert.rejects(async()=>m.state.waitForNativeGameActivationReady({},f.store),/NATIVE_MANAGER_STARTUP_UNAVAILABLE/);
 const owner=f.begin();f.observe(owner,Promise.resolve());await f.refresh(()=>Promise.resolve());await m.state.waitForNativeGameActivationReady(startup,f.store);
 assert.throws(()=>m.state.checkNativeGameActivationReady({},startup,f.store));
 const g=activationFixture(),n=moduleFixture(g);n.run();const other=await n.state.waitForNativeManagerStartupReady(g.store);await assert.rejects(async()=>n.state.waitForNativeGameActivationReady(other,f.store),/NATIVE_MANAGER_STARTUP_UNAVAILABLE/);
});
integration('actual waiter before source begin stays pending then joins genuine setup and refresh',async()=>{
 const f=activationFixture(),waiting=f.wait();let done=false;waiting.then(()=>done=true,()=>done=true);await tick();assert.equal(done,false);
 const owner=f.begin(),s=deferred(),r=deferred();f.observe(owner,s.promise);const refreshing=f.refresh(()=>r.promise);assert.equal(f.legacy(),1);
 s.resolve();await tick();assert.equal(done,false);r.resolve();await refreshing;assert.equal(f.legacy(),0);assert.equal(await waiting,owner);f.check(owner);assert.equal(f.timers.size,0);
});
integration('both actual tail orders require tracker deletion and setup success',async()=>{
 for(const first of ['setup','refresh']){const f=activationFixture(),o=f.begin(),s=deferred(),r=deferred();f.observe(o,s.promise);const refreshing=f.refresh(()=>r.promise),p=f.wait();let done=false;p.then(()=>done=true,()=>done=true);
  if(first==='setup')s.resolve();else r.resolve();await tick();assert.equal(done,false);assert.equal(f.legacy(),first==='setup'?1:0);
  if(first==='setup')r.resolve();else s.resolve();await refreshing;assert.equal(await p,o);f.check(o);assert.equal(f.legacy(),0);}
});
integration('actual game/event source observes pre-catch setup failure although ordinary notification handler resolves',async()=>{
 const f=activationFixture(),g=gameProducer(f),waiting=f.wait();waiting.catch(()=>{});const ordinary=g.change();g.setup.reject(new g.UserCanceled('own setup cancelled'));
 await ordinary;await assert.rejects(waiting,/ACTIVATION/);assert.deepEqual(f.ordinary,['notify','dismiss']);assert.equal(f.store.getState().settings.profiles.activeProfileId,undefined);
});
integration('actual setup/event chain cannot grant on gamemode event before detached refresh tail clears',async()=>{
 const f=activationFixture(),g=gameProducer(f),p=f.wait();let done=false;p.then(()=>done=true,()=>done=true);const ordinary=g.change();g.setup.resolve();await ordinary;await tick();assert.equal(done,false);assert.equal(f.legacy(),1);
 g.refresh.resolve();const o=await p;f.check(o);assert.equal(f.legacy(),0);
});
integration('post-getState subscribe swap refuses and restoring it cannot revive source record',async()=>{
 let armed=false;const f=activationFixture({onGetState:store=>{if(armed){armed=false;store.subscribe=()=>()=>{}}}}),o=f.begin(),s=deferred();f.observe(o,s.promise);await f.refresh(()=>Promise.resolve());s.resolve();await f.wait();
 const saved=f.store.subscribe;armed=true;assert.throws(()=>f.check(o),/ACTIVATION/);f.store.subscribe=saved;assert.throws(()=>f.check(o),/ACTIVATION/);
});
integration('profile ABA is sticky; stale owner and failure cannot poison later genuine generation',async()=>{
 const f=activationFixture(),o=f.begin(),s=deferred(),r=deferred();f.observe(o,s.promise);const refreshing=f.refresh(()=>r.promise),waiting=f.wait();waiting.catch(()=>{});f.profile('q');f.profile('p');await assert.rejects(waiting,/ACTIVATION/);
 r.resolve();s.resolve();await refreshing;assert.throws(()=>f.check(o));
 const next=f.begin(),setup=deferred();f.observe(next,setup.promise);await f.refresh(()=>Promise.resolve());setup.resolve();await f.wait();assert.throws(()=>f.Manager.failNativeGameActivation(o),/REFUSED/);f.check(next);
});
integration('source readiness preserves legitimate opaque leading underscore and hyphen profile IDs',async()=>{
 for(const profileId of ['_p','-p']){const f=activationFixture({profileId}),o=f.begin(),s=deferred();f.observe(o,s.promise);await f.refresh(()=>Promise.resolve());s.resolve();assert.equal(await f.wait(),o);f.check(o);}
});
integration('unrelated prebegin refresh cannot become readiness for the later genuine activation',async()=>{
 const f=activationFixture(),waiting=f.wait();let done=false;waiting.then(()=>done=true,()=>done=true);let ordinary=0;
 await f.refresh(()=>{ordinary++;return Promise.resolve()});await tick();assert.equal(done,false);
 const o=f.begin(),setup=deferred(),refresh=deferred();f.observe(o,setup.promise);
 const genuine=f.refresh(()=>{ordinary++;return refresh.promise});setup.resolve();await tick();assert.equal(done,false,'prebegin refresh is not this activation tail');
 refresh.resolve();await genuine;assert.equal(await waiting,o);assert.equal(ordinary,2);assert.equal(f.legacy(),0);
});
integration('ordinary refresh Error/null/undefined primary and retained legacy owner survive native hold',async()=>{
 for(const primary of [Error('own ordinary'),null,undefined]){const f=activationFixture(),o=f.begin();const waiting=f.wait();waiting.catch(()=>{});let seen=false;try{await f.refresh(()=>Promise.reject(primary))}catch(e){seen=true;assert.equal(e,primary)}assert(seen);await assert.rejects(waiting,/ACTIVATION/);assert.equal(f.legacy(),1);assert.throws(()=>f.check(o));}
});
// Negative-only deadline probe: actual contiguous readiness statements from
// ExtensionManager.prepareNativeExecutor; source-owner/IPC collaborators below
// are controlled callbacks, never evidence of a valid transport/admission grant.
integration('actual ExtensionManager readiness block expires during manager once-tail; late completion invokes no Main',async()=>{
 const f=activationFixture(),manager=deferred(),source=read('extension');
 const c=find(source,(n,t)=>t.isClassDeclaration(n)&&n.name?.text==='ExtensionManager').node;
 const method=c.members.find(n=>n.name?.getText()==='prepareNativeExecutor');assert(method);
 const statements=method.body.statements.find(n=>inputs().ts.isTryStatement(n)).tryBlock.statements;
 const start=statements.findIndex(n=>n.getText().startsWith('const store='));
 const end=statements.findIndex(n=>n.getText().startsWith('const result:'));assert(start>=0&&end>start);
 let segment=statements.slice(start,end+1).map(n=>n.getText()).join('\n');
 const count={invoke:0,checks:0};
 const Segment=evaluate('class Probe{#nativeTransportError(){return Error("OWN_DEADLINE")};#checkNativeTransport(){count.checks++};async run(route,request){'+segment+';return result;}waitForNativeRendererManagerReady(){return manager.promise;}checkNativeRendererManagerReady(){}checkNativeStaticManager(){}}','Probe',{
  nativeReadinessTypes:utilTypes,nativeReadinessClock:{now:()=>f.clock.now},setTimeout:(fn,ms)=>{const id=Symbol();f.timers.set(id,{fn,at:f.clock.now+ms});return id},clearTimeout:id=>f.timers.delete(id),count,manager,
 });
 const route={load:{store:f.store},persist:{},prepare(){count.invoke++;return Promise.resolve({})}},probe=new Segment(),p=probe.run(route,{});p.catch(()=>{});
 f.advance(30001);await assert.rejects(p,/OWN_DEADLINE/);assert.equal(count.invoke,0);manager.resolve({});await tick();assert.equal(count.invoke,0);assert.equal(f.timers.size,0);
});