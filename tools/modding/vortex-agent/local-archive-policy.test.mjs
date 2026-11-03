import test from 'node:test';
import assert from 'node:assert/strict';
import policy from './local-archive-policy.cjs';

const { validateLocalArchiveName, assertLocalArchiveAdmission } = policy;
const input = extra => ({ archiveName: 'Own-Mod_1.2.zip', mods: {}, existingDirectories: [],
  metadata: [], autoEnable: false, autoDeploy: false, ...extra });

test('admits a new own-local archive without modifying caller snapshots', () => {
  const args = input({ mods: { other: { id: 'other', installationPath: 'other' } },
    existingDirectories: ['other', 'other.installing'] });
  const before = structuredClone(args);
  assert.deepEqual(assertLocalArchiveAdmission(args), { expectedId: 'Own-Mod_1.2' });
  assert.deepEqual(args, before);
  assert.equal(validateLocalArchiveName('A.zip'), 'A');
  assert.equal(validateLocalArchiveName('a'.repeat(116) + '.zip'), 'a'.repeat(116));
});

test('rejects paths, alternate streams, non-ASCII and Windows-aliased names', () => {
  for (const name of [undefined, '', 'a'.repeat(117) + '.zip', 'x.ZIP', '../x.zip', 'a/b.zip',
    'a\\b.zip', 'a:stream.zip', ' mod.zip', 'мод.zip', '.hidden.zip', 'mod.zip\n', 'mod.zip\r\n',
    'mod..zip', 'CON.zip', 'nul.extra.zip', 'COM1.zip', 'LPT9.zip']) {
    assert.throws(() => validateLocalArchiveName(name), /LOCAL_ARCHIVE_NAME_INVALID/, String(name));
  }
});

test('rejects case-insensitive record key, id and installation-directory collisions', () => {
  for (const mods of [
    { 'OWN-MOD_1.2': {} },
    { other: { id: 'own-mod_1.2' } },
    { other: { installationPath: 'OWN-MOD_1.2' } },
    { other: { installationPath: 'nested\\Own-Mod_1.2' } },
    { 'own-mod_1.2. ': {} },
  ]) assert.throws(() => assertLocalArchiveAdmission(input({ mods })), /LOCAL_ARCHIVE_MOD_COLLISION/);
});

test('rejects candidate and in-progress staging directory aliases', () => {
  for (const directory of ['own-mod_1.2', 'OWN-MOD_1.2.INSTALLING', 'Own-Mod_1.2. ',
    'nested/Own-Mod_1.2.installing']) {
    assert.throws(() => assertLocalArchiveAdmission(input({ existingDirectories: [directory] })),
      /LOCAL_ARCHIVE_DIRECTORY_COLLISION/);
  }
});

test('rejects metadata matches and unknown lookup results', () => {
  for (const metadata of [undefined, null, {}, { results: [] }, [{ value: {} }], ['match']])
    assert.throws(() => assertLocalArchiveAdmission(input({ metadata })), /LOCAL_ARCHIVE_METADATA_UNSAFE/);
});

test('requires explicitly disabled auto-enable and auto-deploy', () => {
  for (const field of ['autoEnable', 'autoDeploy']) {
    for (const value of [true, undefined, null, 0, 'false'])
      assert.throws(() => assertLocalArchiveAdmission(input({ [field]: value })), /LOCAL_ARCHIVE_AUTOMATION_UNSAFE/);
  }
});

test('rejects incomplete or malformed inventory inputs', () => {
  for (const mods of [undefined, null, [], { other: null }, { other: { id: 42 } }])
    assert.throws(() => assertLocalArchiveAdmission(input({ mods })), /LOCAL_ARCHIVE_INVENTORY_INVALID/);
  for (const existingDirectories of [undefined, null, {}, [null], [''], ['/']])
    assert.throws(() => assertLocalArchiveAdmission(input({ existingDirectories })), /LOCAL_ARCHIVE_INVENTORY_INVALID/);
});
