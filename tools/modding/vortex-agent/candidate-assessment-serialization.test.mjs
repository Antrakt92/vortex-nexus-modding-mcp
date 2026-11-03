import test from 'node:test';
import assert from 'node:assert/strict';
import {safe} from './serialization.cjs';

const kind = 'assess_installed_candidates', digest = 'a'.repeat(64);
function observation() {
  return {protocol:'vortex-agent/1',schema:'installed-candidate-assessment/1',status:'ok',
    gameId:'cyberpunk2077',profileId:'active',collection:{modId:'collection',revisionId:10},
    comparisons:[{oldModId:'old',candidateModId:'candidate',status:'insufficient_evidence',
      reasons:['PROFILE_FLAGS_UNKNOWN'],fingerprint:digest,
      selectedRule:{ruleIdHash:digest,fingerprint:digest},
      incomingRequires:[{ownerId:'collection',ruleIdHash:digest,fingerprint:digest}],
      profiles:{old:[{id:'active'}],candidate:[{id:'other'}]},
      archiveReferences:{old:[{gameId:'cyberpunk2077',modId:'old'}],candidate:[]}}]};
}
const api = {getState:() => ({persistent:{nexus:{userInfo:{name:'candidate',label:'insufficient_evidence',
  name2:'collection',name3:'active',name4:'PROFILE_FLAGS_UNKNOWN',name5:digest}}}})};

test('assessment identifiers, hashes and finite labels survive account-name overlap only at curated positions', () => {
  const input = observation();
  assert.deepEqual(safe(input,api,kind),input);
  const display = safe({fingerprint:digest,status:'insufficient_evidence',candidateModId:'candidate'},api);
  assert.deepEqual(display,{fingerprint:'[redacted]',status:'[redacted]',candidateModId:'[redacted]'});
  const extra = safe({...input,arbitrary:{status:'insufficient_evidence'}},api,kind);
  assert.equal(extra.arbitrary.status,'[redacted]');
});

test('unknown assessment labels and non-hash rule fingerprints refuse serialization', () => {
  for (const mutate of [v => {v.comparisons[0].status='looks fine';},
    v => {v.comparisons[0].reasons=['PRIVATE_UNKNOWN_TEXT'];},
    v => {v.comparisons[0].selectedRule.ruleIdHash='requires_C:/private/path';}]) {
    const input=observation(); mutate(input);
    assert.throws(() => safe(input,null,kind),/OPERATIONAL_VALUE_NOT_CURATED/);
  }
});

test('real credential overlap still refuses assessment operational values', () => {
  assert.throws(() => safe(observation(),null,kind,['candidate']),/OPERATIONAL_SECRET_OVERLAP/);
});
