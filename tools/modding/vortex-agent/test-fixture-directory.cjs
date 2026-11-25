'use strict';

const assert = require('node:assert/strict');
const { lstatSync, mkdirSync, mkdtempSync, realpathSync, rmSync } = require('node:fs');
const path = require('node:path');

function directoryIdentity(directory, allowMissing = false) {
  const info = lstatSync(directory, { bigint: true, throwIfNoEntry: !allowMissing });
  if (info === undefined) return undefined;
  assert(info.isDirectory() && !info.isSymbolicLink() && info.ino !== 0n, 'Expected an ordinary fixture directory');
  return `${info.dev}:${info.ino}`;
}

function fixtureDirectory(t, scratch, prefix) {
  assert(typeof prefix === 'string' && /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(prefix), 'Expected a fixture leaf prefix');
  const base = path.resolve(scratch);
  const ancestry = [];
  for (let directory = base; ; directory = path.dirname(directory)) {
    ancestry.unshift(directory);
    if (directory === path.dirname(directory)) break;
  }
  ancestry.forEach(directory => directoryIdentity(directory, true));
  mkdirSync(base, { recursive: true });
  const ancestorPins = ancestry.map(directory => directoryIdentity(directory));
  assert.equal(path.relative(base, realpathSync.native(base)), '', 'Fixture scratch resolves elsewhere');
  const root = mkdtempSync(path.join(base, prefix));
  const rootPin = directoryIdentity(root);
  t.after(() => {
    for (const [index, directory] of ancestry.entries()) {
      assert.equal(directoryIdentity(directory), ancestorPins[index], 'Fixture ancestry changed');
    }
    assert.equal(directoryIdentity(root), rootPin, 'Fixture root changed');
    const leaf = path.basename(root);
    assert(leaf.startsWith(prefix) && path.relative(base, root) === leaf
      && path.relative(base, realpathSync.native(root)) === leaf, 'Fixture escaped scratch');
    // Node removes link entries themselves, including test-created junctions.
    rmSync(root, { recursive: true });
  });
  return root;
}

module.exports = { fixtureDirectory };
