import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {observeRelayInertCancellation} from './owned-zip-relay-client.mjs';

test('inert cancellation observation rejects foreign owners and status JSON before any filesystem work',()=>{
  let reads=0,getters=0;
  const read=fs.readFileSync,stat=fs.lstatSync;
  fs.readFileSync=()=>{reads++;assert.fail('Foreign observation must not read files');};
  fs.lstatSync=()=>{reads++;assert.fail('Foreign observation must not inspect paths');};
  try{
    const claimed=Object.freeze({cancelledBeforeStart:true,pythonStartSent:false,childResourcesClosed:true});
    const getter={get status(){getters++;assert.fail('Caller getter');}};
    for(const owner of [null,undefined,{},claimed,getter,new Proxy(claimed,{get(){assert.fail('Caller proxy');}})]){
      assert.throws(()=>observeRelayInertCancellation(owner),/INERT_CANCELLATION_OWNER/);
    }
    assert.equal(reads,0);assert.equal(getters,0);
  }finally{fs.readFileSync=read;fs.lstatSync=stat;}
});

test('inert observation accepts exactly one owner argument and never evaluates extra controls',()=>{
  assert.throws(()=>observeRelayInertCancellation(),/INERT_CANCELLATION_ARGUMENTS/);
  assert.throws(()=>observeRelayInertCancellation({},()=>assert.fail('Callback')),/INERT_CANCELLATION_ARGUMENTS/);
  assert.throws(()=>observeRelayInertCancellation({},'reset'),/INERT_CANCELLATION_ARGUMENTS/);
});
