import test from 'node:test';
import assert from 'node:assert/strict';
import {createRendererInertReleaseFixture as fixture,makeTrackedObservation} from './native-cancellation-renderer-release-fixture.mjs';
const available=process.env.VORTEX_EXTENSION_ADMISSION_REPO&&process.env.VORTEX_EXTENSION_ADMISSION_DEPS;
const integration=(name,fn)=>test(name,{skip:available?false:'Set VORTEX_EXTENSION_ADMISSION_REPO and VORTEX_EXTENSION_ADMISSION_DEPS',timeout:15000},fn);
const closed=(f,o)=>{
 assert.equal(f.manager.getNativeInstallExclusion().exclusiveHeld,true);
 assert.throws(()=>f.middleware.checkNativePersistenceFlushHold(o.flush));
 assert.throws(()=>f.api.checkNativeRendererTarget(o.root));
 f.fire();assert.deepEqual(f.sent,[]);
};
integration('actual inert chain retains absent target and resumes unrelated persistence exactly once',async()=>{
 const f=fixture(),o=await f.owners();
 const before=f.store.getState().persistent.mods.game;
 f.store.dispatch({type:'SETTING',payload:{key:'before',value:1}});
 const ticket=f.prepare(o);f.check(ticket);
 f.store.dispatch({type:'SETTING',payload:{key:'after',value:2}});
 f.store.dispatch({type:'ADD',payload:{id:'unrelated',v:3}});
 f.finalize(ticket);
 assert.equal(f.manager.getNativeInstallExclusion().exclusiveHeld,false);
 assert.equal(f.api.getNativeRendererTargetStatus().phase,'not_reserved');
 assert.equal(f.store.getState().persistent.mods.game.new,undefined);
 assert.equal(before.new,undefined);assert.equal(f.store.getState().persistent.downloads.files.archive.installed,undefined);
 assert.throws(()=>f.middleware.checkNativePersistenceFlushHold(o.flush));
 f.fire();assert.equal(f.sent.length,2);const serialized=JSON.stringify(f.sent);
 assert.match(serialized,/before/);assert.match(serialized,/after/);assert.match(serialized,/unrelated/);
 assert.doesNotMatch(serialized,/__nmtNativeRegistration|"installed"/);
 f.fire();assert.equal(f.sent.length,2);
 await f.Manager.trackNativeLifecycleCall(()=>Promise.resolve());
});
integration('foreign and proxy owners refuse without evaluating traps or invalidating genuine owners',async()=>{
 let calls=0;const f=fixture({managerState:s=>{calls++;return s;}}),o=await f.owners();const before=calls;
 const proxy=new Proxy({},{get(){assert.fail('foreign owner getter');},getPrototypeOf(){assert.fail('foreign owner prototype');}});
 for(const foreign of [{},proxy]){
  assert.throws(()=>f.manager.prepareNativeInertRelease(foreign,o.root,o.flush));
  assert.throws(()=>f.api.prepareNativeRendererTargetInertRelease(foreign,o.flush));
  assert.throws(()=>f.middleware.prepareNativePersistenceInertRelease(foreign,o.root,f.store));
 }
 assert.equal(calls,before);f.manager.checkNativeInstallExclusion(o.manager);f.api.checkNativeRendererTarget(o.root);f.middleware.checkNativePersistenceFlushHold(o.flush);
 f.finalize(f.prepare(o));
});
integration('adoption-completed state refuses inert release without manufacturing another adopted action',async()=>{
 for(const mode of ['prepared','completed']){
  const f=fixture(),o=await f.owners();
  if(mode==='prepared')f.middleware.createNativePersistenceAdoption(o.flush,o.root,f.store,makeTrackedObservation());else f.adopt(o);
  const record=f.store.getState().persistent.mods.game.new;
  assert.throws(()=>f.prepare(o));closed(f,o);assert.equal(f.store.getState().persistent.mods.game.new,record);
 }
});
integration('success lane still completes through the existing registration release',async()=>{
 const f=fixture(),o=await f.owners();f.adopt(o);f.finalizeSuccess(f.prepareSuccess(o));
 assert.equal(f.manager.getNativeInstallExclusion().exclusiveHeld,false);
 assert.equal(f.store.getState().persistent.mods.game.new.state,'installed');
});
integration('generic flush release and old success preparation cannot bypass an active inert ticket',async()=>{
 for(const mode of ['generic','success','adopt']){
  const f=fixture(),o=await f.owners(),ticket=f.prepare(o);
  assert.throws(()=>mode==='generic'?f.middleware.releaseNativePersistenceFlushHold(o.flush):mode==='success'?f.prepareSuccess(o):f.adopt(o));
  assert.throws(()=>f.finalize(ticket));closed(f,o);
 }
});
integration('duplicate preparation and manager getState callback reentry stay held before any opening',async()=>{
 for(const mode of ['duplicate','reentry']){
  let f,o,armed=false;f=fixture({managerState:s=>{if(armed){armed=false;try{f.prepare(o);}catch{}}return s;}});o=await f.owners();
  const ticket=f.prepare(o);
  if(mode==='duplicate')assert.throws(()=>f.prepare(o));else armed=true;
  assert.throws(()=>f.finalize(ticket));closed(f,o);
 }
});
integration('used opaque tickets reject inertly after a fresh operation has genuine owners',async()=>{
 const f=fixture(),one=await f.owners(),old=f.prepare(one);f.finalize(old);
 const two=await f.owners('new2');
 assert.throws(()=>f.check(old));assert.throws(()=>f.finalize(old));
 f.manager.checkNativeInstallExclusion(two.manager);f.api.checkNativeRendererTarget(two.root);f.middleware.checkNativePersistenceFlushHold(two.flush);
 f.finalize(f.prepare(two));assert.equal(f.manager.getNativeInstallExclusion().exclusiveHeld,false);
});
integration('throwing or synchronous timer cannot partially open flush root or manager',async()=>{
 for(const sync of [false,true]){
  let armed=false;const f=fixture({timerSync:sync,timerFailure:()=>armed}),o=await f.owners();
  f.store.dispatch({type:'SETTING',payload:{key:'pending',value:1}});const ticket=f.prepare(o);armed=true;
  assert.throws(()=>f.finalize(ticket));closed(f,o);
 }
});
integration('retained actual inert and success finalizers cannot poison the next genuine operation',async()=>{
 for(const mode of ['inert','success']){
  const retained=[];const f=fixture({observeArms:(name,child)=>retained.push({name,child})}),one=await f.owners();
  if(mode==='success'){f.adopt(one);f.finalizeSuccess(f.prepareSuccess(one));}else f.finalize(f.prepare(one));
  assert.equal(retained.length,2);assert(retained.some(x=>x.name.includes('Persistence')));assert(retained.some(x=>x.name.includes('Target')));
  const two=await f.owners('new2');
  for(const {child}of retained.slice())for(const method of ['check','finish']){
   assert.throws(()=>child[method]());
   f.manager.checkNativeInstallExclusion(two.manager);f.api.checkNativeRendererTarget(two.root);f.middleware.checkNativePersistenceFlushHold(two.flush);
  }
  f.finalize(f.prepare(two));assert.equal(f.manager.getNativeInstallExclusion().exclusiveHeld,false);
 }
});
integration('generic release callback while arming refuses before the deepest opener',async()=>{
 let armed=false,f,o;f=fixture({timerHook:()=>{if(armed){armed=false;try{f.middleware.releaseNativePersistenceFlushHold(o.flush);}catch{}}}});o=await f.owners();
 f.store.dispatch({type:'SETTING',payload:{key:'pending',value:1}});const ticket=f.prepare(o);armed=true;
 assert.throws(()=>f.finalize(ticket));closed(f,o);
});
integration('empty arm with later pending data and expired armed timer refuse before opening',async()=>{
 for(const mode of ['late','timer']){
  const f=fixture(),o=await f.owners();if(mode==='timer')f.store.dispatch({type:'SETTING',payload:{key:'pending',value:1}});
  const ticket=f.api.prepareNativeRendererTargetInertRelease(o.root,o.flush),finish=f.api.armNativeRendererTargetInertRelease(ticket);
  if(mode==='late')f.store.dispatch({type:'SETTING',payload:{key:'late',value:1}});else f.fire();
  assert.throws(()=>finish.finish());closed(f,o);
 }
});
integration('nonwritable manager fields and transfer marker drift refuse with all writers held',async()=>{
 for(const mode of ['owner','manager','record','phase','transfer']){
  const f=fixture(),o=await f.owners(),ticket=f.prepare(o);
  if(mode==='owner')Object.defineProperty(f.Manager,'mNativeExclusiveOwner',{writable:false});
  if(mode==='manager')Object.defineProperty(f.Manager,'mNativeExclusiveManager',{writable:false});
  if(mode==='record')Object.defineProperty(f.manager,'mNativeInertRelease',{writable:false});
  if(mode==='phase')Object.defineProperty(f.manager.mNativeInertRelease,'phase',{writable:false});
  if(mode==='transfer')f.store.getState().persistent.transactions={transfer:{downloads:'pending'}};
  assert.throws(()=>f.finalize(ticket));assert.equal(f.manager.getNativeInstallExclusion().exclusiveHeld,true);
  // A nonwritable private phase can itself prevent assigning 'held'; no child
  // was opened, so use the genuine flush/root checks rather than that label.
  if(mode!=='phase')closed(f,o);else{f.middleware.checkNativePersistenceFlushHold(o.flush);f.api.checkNativeRendererTarget(o.root);}
 }
});
