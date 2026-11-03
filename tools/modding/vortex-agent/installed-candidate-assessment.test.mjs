import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
const require = createRequire(import.meta.url);
const {assessInstalledCandidates, LIMITS, SCHEMA, STATUSES, REASONS} = require('./installed-candidate-assessment.cjs');
const gameId = 'cyberpunk2077';
const mod = patch => ({state: 'installed', type: '', attributes: {source: 'nexus', modId: 10, fileId: 100}, ...patch});
const rule = patch => ({type: 'requires', reference: {tag: 'member', repo: {repository: 'nexus', modId: '10', fileId: '100'}}, ...patch});
const nonempty = v => v !== undefined && v !== null && Object.keys(v).length > 0;
function fixture() {
  const state = {persistent: {mods: {[gameId]: {
    old: mod({archiveId: 'old_archive'}), candidate: mod({archiveId: 'candidate_archive'}),
    collection: mod({type: 'collection', attributes: {collectionId: 22, revisionId: 33, revisionNumber: 2}, rules: [rule()]}),
  }}, profiles: {active: {gameId, modState: {old: {enabled: true}, candidate: {enabled: false}}},
    second: {gameId, modState: {old: {enabled: true}}}}}};
  const args = {gameId, profileId: 'active', collectionModId: 'collection', comparisons: [{oldModId: 'old', candidateModId: 'candidate'}]};
  const calls = [];
  // Contract fixture: only the identity forms needed by these scenarios. The
  // production module delegates every match to the supported native utilities.
  const identity = (record, ref) => ref.id !== undefined ? record.id === ref.id
    : ref.repo ? record.attributes?.source === ref.repo.repository && String(record.attributes?.modId) === ref.repo.modId
      && String(record.attributes?.fileId) === ref.repo.fileId : record.attributes?.fileMD5 === ref.fileMD5;
  const util = {
    testModReference(...args) {assert.equal(args.length, 2); calls.push(['identity', ...args]); return identity(...args);},
    ruleInstallSpec(record) {calls.push(['spec', record]); return {installerChoices: record.installerChoices,
      fileList: record.fileList, patches: record.patches ?? record.extra?.patches};},
    modRuleId(record) {calls.push(['ruleId', record]); const r = record.reference;
      return record.type + '_' + (r.tag || r.fileMD5 || r.id || r.logicalFileName || r.fileExpression || r.description);},
    findModByRef(ref, records, source, spec) {
      calls.push(['find', ref, records, source, spec]); assert.equal(source, undefined); assert.equal(Object.keys(records).length, 1);
      const record = Object.values(records)[0];
      const matchedSpec = ['installerChoices', 'fileList', 'patches'].every(key => !nonempty(spec[key])
        || JSON.stringify(record.attributes[key]) === JSON.stringify(spec[key]));
      return matchedSpec && (ref.md5Hint === record.attributes?.fileMD5 && ref.md5Hint !== undefined || identity(record, ref)) ? record : undefined;
    },
  };
  const selectors = {activeGameId: () => gameId, activeProfileId: () => 'active'};
  let reads = 0;
  const api = {getState() {reads++; return state;}};
  return {state, args, util, selectors, api, calls, get reads() {return reads;},
    get mods() {return state.persistent.mods[gameId];},
    run() {return assessInstalledCandidates(api, selectors, util, args);}, row() {return this.run().comparisons[0];}};
}

test('simple installed candidate checks all incoming metadata without migration authority', () => {
  const f = fixture(), before = structuredClone(f.state), result = f.run(), row = result.comparisons[0];
  assert.equal(result.schema, SCHEMA); assert.equal(result.protocol, 'vortex-agent/1'); assert.equal(result.status, 'ok');
  assert.equal(row.status, 'compatible_installed_variant'); assert.deepEqual(row.reasons, []);
  assert.equal(result.metadataOnly, true); assert.equal(result.effectsAllowed, false);
  assert.equal(result.migrationReady, false); assert.equal(result.diskDeploymentVerified, false);
  assert.equal(row.incomingRequires.length, 1);
  assert.deepEqual(row.incomingRequires.map(r => [r.ownerId, r.identityMatches, r.installSpecMatches, r.oldInstallSpecMatches]),
    [['collection', true, true, true]]);
  assert.match(row.fingerprint, /^[a-f0-9]{64}$/); assert.match(row.selectedRule.ruleIdHash, /^[a-f0-9]{64}$/);
  assert.equal(result.counts.matcherChecks, f.calls.length); assert.equal(f.reads, 2);
  assert.deepEqual(f.state, before);
  assert.deepEqual(row.profiles.old.map(p => [p.id, p.enabled]), [['active', true], ['second', true]]);
  assert.deepEqual(row.archiveReferences.old, [{gameId, modId: 'old'}]);
  assert(STATUSES.includes(row.status)); assert(row.reasons.every(r => REASONS.includes(r)));
});

test('map keys override stored IDs and each helper receives fresh detached objects', () => {
  const f = fixture(); f.mods.old.id = 'foreign-old'; f.mods.candidate.id = 'foreign-candidate';
  const before = structuredClone(f.state), original = {...f.util};
  f.util.testModReference = (record, ref) => {
    assert(!ref.mutated); const result = original.testModReference(record, ref); record.attributes.fileId = -1; ref.mutated = true; return result;
  };
  f.util.ruleInstallSpec = record => {assert(!record.reference.mutated); record.reference.mutated = true; return {};};
  f.util.modRuleId = record => {assert(!record.reference.mutated); const result = original.modRuleId(record); record.reference.mutated = true; return result;};
  f.util.findModByRef = (ref, records, source, spec) => {
    assert(!ref.mutated); assert(!spec.mutated); const record = Object.values(records)[0];
    assert.equal(record.attributes.fileId, 100); const result = original.findModByRef(ref, records, source, spec);
    ref.mutated = true; spec.mutated = true; record.attributes.fileId = -1; return result;
  };
  assert.equal(f.row().status, 'compatible_installed_variant'); assert.deepEqual(f.state, before);
});

test('md5Hint shortcut cannot bypass the independent candidate identity matcher', () => {
  const f = fixture(); f.mods.old.attributes.fileMD5 = 'same'; f.mods.candidate.attributes.fileMD5 = 'same';
  f.mods.candidate.attributes.fileId = 999; f.mods.collection.rules[0].reference.md5Hint = 'same';
  const row = f.row(); assert.equal(row.status, 'conflict');
  assert(row.reasons.includes('CANDIDATE_IDENTITY_CONFLICT'));
  assert.equal(row.incomingRequires[0].identityMatches, false); assert.equal(row.incomingRequires[0].installSpecMatches, true);
});

test('native no-match is a specification conflict when independent identity matches', () => {
  const f = fixture(); const choices = {options: {a: true}};
  f.mods.collection.rules[0].installerChoices = choices; f.mods.old.attributes.installerChoices = choices;
  f.mods.candidate.attributes.installerChoices = {options: {a: false}};
  const row = f.row(); assert.equal(row.status, 'conflict');
  assert(row.reasons.includes('CANDIDATE_INSTALL_SPEC_CONFLICT')); assert(row.reasons.includes('CUSTOMIZATIONS_REVIEW_REQUIRED'));
  assert.equal(row.incomingRequires[0].oldInstallSpecMatches, true); assert.equal(row.incomingRequires[0].installSpecMatches, false);
});

test('old specification mismatch stays in closure and is distinguished from candidate conflict', () => {
  const f = fixture(); const wanted = [{path: 'archive/pc/mod/own.archive'}];
  f.mods.collection.rules[0].fileList = wanted; f.mods.candidate.attributes.fileList = wanted;
  const row = f.row(); assert.equal(row.status, 'insufficient_evidence');
  assert(row.reasons.includes('OLD_INSTALL_SPEC_MISMATCH')); assert(!row.reasons.includes('CANDIDATE_INSTALL_SPEC_CONFLICT'));
  assert.equal(row.incomingRequires[0].oldInstallSpecMatches, false); assert.equal(row.incomingRequires[0].installSpecMatches, true);
});

test('nonempty matching choices, legacy patches and file lists still require migration review', () => {
  for (const field of ['installerChoices', 'fileList', 'patches']) {
    const f = fixture(), value = field === 'fileList' ? [{path: 'private-path'}] : {option: 'private-choice'};
    f.mods.old.attributes[field] = value; f.mods.candidate.attributes[field] = value;
    if (field === 'patches') f.mods.collection.rules[0].extra = {patches: value};
    else f.mods.collection.rules[0][field] = value;
    const result = f.run(); assert.equal(result.comparisons[0].status, 'insufficient_evidence');
    assert(result.comparisons[0].review.customizations); assert(!JSON.stringify(result).includes('private-'));
  }
});

test('selected collection rule must be uniquely meaningful even when an optional selector is supplied', () => {
  const f = fixture(); f.mods.collection.rules.push(rule());
  f.args.comparisons[0].ruleId = 'requires_member';
  assert.equal(f.row().selectedRule, null); assert(f.row().reasons.includes('SELECTED_RULE_AMBIGUOUS'));
  const unknown = fixture(); delete unknown.mods.collection.rules[0].reference.tag;
  const row = unknown.row(); assert.equal(row.status, 'insufficient_evidence'); assert.equal(row.selectedRule, null);
  assert(row.reasons.includes('RULE_ID_UNAVAILABLE'));
  const blank = fixture(); blank.util.modRuleId = () => '';
  assert(blank.row().reasons.includes('NATIVE_MATCH_INVALID'));
});

test('distinct selected rules require an explicit exact selector, never first-match selection', () => {
  const f = fixture(); const other = rule(); other.reference.tag = 'other'; f.mods.collection.rules.push(other);
  assert(f.row().reasons.includes('SELECTED_RULE_AMBIGUOUS')); assert.equal(f.row().selectedRule, null);
  f.args.comparisons[0].ruleId = 'requires_other';
  assert.equal(f.row().status, 'compatible_installed_variant');
  f.args.comparisons[0].ruleId = 'requires_missing';
  assert(f.row().reasons.includes('SELECTED_RULE_NOT_FOUND'));
});

test('all collections, noncollection owners and ignored incoming requires are assessed', () => {
  const f = fixture(); const r = rule({ignored: true}); r.reference.tag = 'foreign';
  f.mods.foreignCollection = mod({type: 'collection', rules: [r]});
  const ordinary = rule({ignored: 'unknown'}); ordinary.reference.tag = 'ordinary';
  f.mods.ordinary = mod({rules: [ordinary]});
  const row = f.row(); assert.equal(row.incomingRequires.length, 3);
  assert.deepEqual(row.incomingRequires.map(r => [r.ownerId, r.ignored]), [['collection', false], ['foreignCollection', true], ['ordinary', null]]);
  assert(row.reasons.includes('RULE_METADATA_UNKNOWN')); assert.equal(row.status, 'insufficient_evidence');
  f.mods.candidate.attributes.fileId = 101;
  const conflict = f.row(); assert.equal(conflict.status, 'conflict'); assert(conflict.reasons.includes('RULE_METADATA_UNKNOWN'));
});

test('profile unknowns, pending removal and cross-game archive references remain explicit', () => {
  const f = fixture(); Object.assign(f.state.persistent.profiles, {
    pending: {gameId, pendingRemove: true, modState: {old: {enabled: true}}},
    uncertain: {gameId, pendingRemove: 'unknown', modState: {candidate: {enabled: 'unknown'}}},
    unrelated: {gameId: 'skyrimse', modState: {old: {enabled: true}}},
  });
  f.state.persistent.mods.skyrimse = {archiveConsumer: mod({archiveId: 'old_archive'})};
  const row = f.row(); assert.equal(row.status, 'insufficient_evidence');
  assert(row.reasons.includes('PROFILE_FLAGS_UNKNOWN')); assert(row.reasons.includes('PROFILE_PENDING_REMOVE'));
  assert(row.reasons.includes('PROFILE_PENDING_REMOVE_UNKNOWN'));
  assert.equal(row.profiles.old.some(p => p.id === 'unrelated'), false);
  assert.deepEqual(row.archiveReferences.old.at(-1), {gameId: 'skyrimse', modId: 'archiveConsumer'});
});

test('documented customization, override and outgoing-rule fields prevent migration green', () => {
  for (const [mutate, flag] of [
    [f => {f.mods.old.fileOverrides = ['private-path'];}, 'overrides'],
    [f => {f.mods.collection.rules[0].extra = {fileOverrides: ['private-path']};}, 'overrides'],
    [f => {f.mods.old.enabledINITweaks = ['private-pref'];}, 'preferences'],
    [f => {f.mods.candidate.attributes.variant = 'private-variant';}, 'preferences'],
    [f => {f.mods.old.rules = [{type: 'after', reference: {id: 'other'}}];}, 'outgoingRules'],
    [f => {f.mods.candidate.rules = [rule()];}, 'candidateRequires'],
  ]) {
    const f = fixture(); mutate(f); const result = f.run(), row = result.comparisons[0];
    assert.equal(row.status, 'insufficient_evidence', flag); assert(row.review[flag]); assert(!JSON.stringify(result).includes('private-'));
  }
});

test('native API missing, thrown errors and malformed returns are unknown with fixed codes only', () => {
  for (const key of ['testModReference', 'findModByRef', 'ruleInstallSpec', 'modRuleId']) {
    for (const replacement of [undefined, () => {throw Error('private-native-error');}, () => null, () => Promise.resolve(true)]) {
      const f = fixture(); f.util[key] = replacement; const result = f.run();
      assert.equal(result.comparisons[0].status, 'insufficient_evidence', key);
      assert(!JSON.stringify(result).includes('private-native-error'));
    }
  }
  const wrongId = fixture(); wrongId.util.findModByRef = () => ({id: 'foreign'});
  assert(wrongId.row().reasons.includes('NATIVE_MATCH_INVALID'));
  const accessor = fixture(); accessor.util.findModByRef = () => ({get id() {throw Error('private');}});
  assert(accessor.row().reasons.includes('NATIVE_MATCH_INVALID'));
});

test('native rule IDs and raw metadata never appear in output', () => {
  const f = fixture(); const ref = f.mods.collection.rules[0].reference;
  delete ref.tag; ref.description = 'private description C:/private/path';
  f.mods.collection.rules[0].extra = {name: 'private collection metadata'};
  const result = f.run(); assert.equal(result.comparisons[0].status, 'compatible_installed_variant');
  assert(!JSON.stringify(result).includes('private')); assert(!JSON.stringify(result).includes('requires_'));
});

test('fingerprints are deterministic and change with revision, rules, profile flags and customizations', () => {
  const baseline = fixture().row().fingerprint;
  assert.equal(fixture().row().fingerprint, baseline);
  for (const change of [f => {f.mods.collection.attributes.revisionId++;},
    f => {f.mods.collection.rules[0].ignored = true;}, f => {f.state.persistent.profiles.second.modState.old.enabled = false;},
    f => {f.mods.candidate.fileOverrides = ['own-file'];}, f => {f.mods.candidate.attributes.fileId++;}]) {
    const f = fixture(); change(f); assert.notEqual(f.row().fingerprint, baseline);
  }
  const irrelevant = fixture(); irrelevant.mods.old.attributes.modSize = 123;
  assert.equal(irrelevant.row().fingerprint, baseline, 'postcallback derived size is not an identity/spec input');
});

test('exact context, revision and installed target/type requirements are explicit', () => {
  const f = fixture(); f.args.expectedRevisionId = 34;
  assert(f.row().reasons.includes('COLLECTION_REVISION_MISMATCH'));
  f.args.expectedRevisionId = 33; assert.equal(f.row().status, 'compatible_installed_variant');
  f.mods.candidate.type = 'other'; assert.equal(f.row().status, 'conflict');
  f.mods.candidate.state = 'installing'; assert(f.row().reasons.includes('TARGET_NOT_INSTALLED'));
  f.args.profileId = 'second'; assert.throws(() => f.run(), /ASSESSMENT_CONTEXT_MISMATCH/);
});

test('relevant state or active context mutation during native matching discards the assessment', () => {
  for (const mutate of [f => {f.mods.candidate.attributes.fileId++;},
    f => {f.state.persistent.profiles.second.modState.old.enabled = false;},
    f => {f.selectors.activeProfileId = () => 'second';}]) {
    const f = fixture(), original = f.util.testModReference;
    let changed = false;
    f.util.testModReference = (...args) => {if (!changed) {changed = true; mutate(f);} return original(...args);};
    assert.throws(() => f.run(), /ASSESSMENT_STATE_CHANGED|ASSESSMENT_CONTEXT_MISMATCH/);
  }
});

test('invalid requests, malformed state and absent collection metadata fail without matching', () => {
  for (const args of [null, {}, {...fixture().args, extra: true}, {...fixture().args, comparisons: []},
    {...fixture().args, expectedRevisionId: 0}, {...fixture().args, comparisons: [{oldModId: 'old', candidateModId: 'old'}]},
    {...fixture().args, comparisons: Array.from({length: 21}, (_, n) => ({oldModId: 'old' + n, candidateModId: 'candidate'}))}]) {
    const f = fixture(); assert.throws(() => assessInstalledCandidates(f.api, f.selectors, f.util, args), /ASSESSMENT_INVALID_REQUEST/);
    assert.equal(f.calls.length, 0);
  }
  for (const mutate of [f => {delete f.mods.collection.attributes.revisionId;}, f => {f.mods.old.attributes = [];},
    f => {f.mods.collection.rules[0].reference = null;}, f => {f.state.persistent.profiles.second.modState = [];},
    f => {Object.defineProperty(f.mods.old.attributes, 'fileId', {get() {throw Error('private');}, enumerable: true});}]) {
    const f = fixture(); mutate(f); assert.throws(() => f.run(), /ASSESSMENT_COLLECTION_INVALID|ASSESSMENT_STATE_INVALID/);
  }
});

test('scan and clone bounds reject instead of truncating or returning green', () => {
  const profiles = fixture();
  for (let n = 0; n < LIMITS.profiles; n++) profiles.state.persistent.profiles['profile' + n] = {gameId};
  assert.throws(() => profiles.run(), /ASSESSMENT_READ_LIMIT/);
  const rules = fixture(); rules.mods.collection.rules = Array.from({length: LIMITS.rules + 1}, () => rule());
  assert.throws(() => rules.run(), /ASSESSMENT_READ_LIMIT/);
  const deep = fixture(); let nested = {}; for (let i = 0; i < LIMITS.cloneDepth + 1; i++) nested = {nested};
  deep.mods.collection.rules[0].extra = nested; assert.throws(() => deep.run(), /ASSESSMENT_READ_LIMIT/);
  const large = fixture(); large.mods.old.attributes.fileName = 'a'.repeat(LIMITS.stringBytes + 1);
  assert.throws(() => large.run(), /ASSESSMENT_READ_LIMIT/);
  const cyclic = fixture(); cyclic.mods.collection.rules[0].extra = {}; cyclic.mods.collection.rules[0].extra.self = cyclic.mods.collection.rules[0].extra;
  assert.throws(() => cyclic.run(), /ASSESSMENT_STATE_INVALID/);
});

test('prototype-named mod IDs and profile flags are own entries and participate in drift detection', () => {
  const f = fixture();
  Object.defineProperty(f.mods, '__proto__', {value: mod(), enumerable: true, configurable: true, writable: true});
  delete f.mods.old; f.args.comparisons[0].oldModId = '__proto__';
  f.state.persistent.profiles.active.modState = JSON.parse('{"__proto__":{"enabled":true},"candidate":{"enabled":false}}');
  f.state.persistent.profiles.second.modState = JSON.parse('{"__proto__":{"enabled":true}}');
  assert.equal(f.row().status, 'compatible_installed_variant');
  assert.equal(f.row().profiles.old[0].enabled, true);
  const match = f.util.testModReference; let changed = false;
  f.util.testModReference = (...args) => {
    if (!changed) {changed = true; f.mods.__proto__.attributes.fileId++;}
    return match(...args);
  };
  assert.throws(() => f.run(), /ASSESSMENT_STATE_CHANGED/);
});

test('native specification accessors never execute and malformed outputs remain unknown', () => {
  const f = fixture(); let reads = 0;
  f.util.ruleInstallSpec = () => Object.defineProperty({}, 'installerChoices', {enumerable: true,
    get() {if (++reads === 3) throw Error('private-return-value'); return undefined;}});
  const result = f.run(); assert.equal(result.comparisons[0].status, 'insufficient_evidence');
  assert(result.comparisons[0].reasons.includes('NATIVE_MATCH_INVALID')); assert.equal(reads, 0);
  const nested = fixture(); nested.util.ruleInstallSpec = () => ({installerChoices: {get secret() {throw Error('private');}}});
  assert(nested.row().reasons.includes('NATIVE_MATCH_INVALID'));
});

test('ignored requirements explicitly gate otherwise compatible recorded variants', () => {
  const f = fixture(); f.mods.collection.rules[0].ignored = true;
  const row = f.row(); assert.equal(row.status, 'insufficient_evidence');
  assert(row.reasons.includes('IGNORED_REQUIREMENT_REVIEW_REQUIRED'));
  assert.equal(row.incomingRequires[0].installSpecMatches, true);
});

test('known conflicts retain priority while unknown assessment work makes top-level status partial', () => {
  const f = fixture(); f.mods.candidate.attributes.fileId++;
  assert.equal(f.run().status, 'ok');
  f.util.ruleInstallSpec = () => {throw Error('private');};
  const result = f.run(); assert.equal(result.status, 'partial'); assert.equal(result.comparisons[0].status, 'conflict');
  assert(result.comparisons[0].reasons.includes('CANDIDATE_IDENTITY_CONFLICT'));
  assert(result.comparisons[0].reasons.includes('NATIVE_MATCH_FAILED'));
});

test('fingerprints bind active profile and explicit expected revision context', () => {
  const f = fixture(), baseline = f.row().fingerprint;
  f.args.expectedRevisionId = 33; assert.notEqual(f.row().fingerprint, baseline);
  const pinned = f.row().fingerprint;
  f.args.profileId = 'second'; f.selectors.activeProfileId = () => 'second';
  assert.notEqual(f.row().fingerprint, pinned);
});

test('aggregate native copy budget bounds many repeated small admitted inputs', () => {
  const f = fixture();
  f.mods.old.attributes.fileName = 'a'.repeat(32000); f.mods.old.attributes.name = 'b'.repeat(32000);
  f.mods.old.attributes.logicalFileName = 'c'.repeat(32000);
  f.mods.candidate.attributes = structuredClone(f.mods.old.attributes);
  f.mods.collection.rules = Array.from({length: 20}, (_, n) => {
    const r = rule(); r.reference.tag = 'member_' + n; return r;
  });
  f.args.comparisons = Array.from({length: 20}, (_, n) => ({oldModId: 'old', candidateModId: 'candidate', ruleId: 'requires_member_' + n}));
  assert.throws(() => f.run(), /ASSESSMENT_READ_LIMIT/);
});

test('malformed record preferences, sparse rules and installed lookup-info masquerades never produce green', () => {
  for (const mutate of [f => {f.mods.old.fileOverrides = {};}, f => {f.mods.old.enabledINITweaks = {};},
    f => {f.mods.old.attributes.fileId = {};}, f => {f.mods.collection.rules.length = 2;},
    f => {f.mods.old.game = [gameId];}, f => {f.mods.collection.rules[0].extra = {fileOverrides: {}};},
    f => {f.mods.collection.rules[0].fileList = [{}];}]) {
    const f = fixture(); mutate(f); assert.throws(() => f.run(), /ASSESSMENT_STATE_INVALID/);
  }
});
