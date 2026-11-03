'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { inspect } = require('./collection-wizard-dom.cjs');

// Small DOM fixture: fixed selector matching and parent/owner/visibility semantics,
// without a browser, installed application, or additional dependency.
class Element {
  constructor(tag = 'div', attrs = {}, value = '') {
    this.tag = tag; this.attrs = attrs; this.value = value; this.children = [];
    this.parentElement = null; this.ownerDocument = null; this.isConnected = true;
    this.disabled = false; this.style = { display: 'block', visibility: 'visible', opacity: '1' };
  }
  add(element) {
    element.parentElement = this; element.ownerDocument = this.ownerDocument;
    this.children.push(element); return element;
  }
  get textContent() { return this.value + this.children.map(child => child.textContent).join(''); }
  getAttribute(key) { return this.attrs[key] ?? null; }
  getClientRects() { return [{}]; }
  contains(node) { return node === this || this.children.some(child => child.contains(node)); }
  matches(selector) {
    if (selector.startsWith('[')) {
      const [, key, val] = selector.match(/^\[([^=\]]+)(?:="([^"]*)")?\]$/) ?? [];
      return key !== undefined && this.getAttribute(key) !== null && (val === undefined || this.attrs[key] === val);
    }
    if (selector.startsWith('#')) return this.attrs.id === selector.slice(1);
    if (selector.startsWith('.')) return selector.slice(1).split('.').every(c => (this.attrs.class ?? '').split(' ').includes(c));
    return this.tag === selector;
  }
  closest(selector) {
    for (let node = this; node; node = node.parentElement) {
      if (selector.split(',').some(part => node.matches(part))) return node;
    }
    return null;
  }
  querySelectorAll(selector) {
    const found = [], groups = selector.split(',');
    function matches(node, group) {
      const parts = group.trim().split(/\s+/);
      if (!node.matches(parts.pop())) return false;
      for (let parent = node.parentElement; parts.length; parent = parent?.parentElement) {
        if (!parent) return false;
        if (parent.matches(parts[parts.length - 1])) parts.pop();
      }
      return true;
    }
    function walk(node) {
      for (const child of node.children) {
        if (groups.some(group => matches(child, group))) found.push(child);
        walk(child);
      }
    }
    walk(this); return found;
  }
}
function fixture(phase = 'start', labels = phase === 'start' ? ['Later', 'Install Now'] : ['Done']) {
  const doc = new Element('document'); doc.ownerDocument = doc;
  doc.defaultView = { getComputedStyle: element => element.style };
  const modal = doc.add(new Element('div', { class: 'modal', role: 'dialog', ...(phase === 'finish' ? { id: 'install-finished-dialog' } : {}) }));
  if (phase === 'start') modal.add(new Element('p', { class: 'collections-instructions-canbereviewed' }, 'untrusted instructions'));
  const card = modal.add(new Element('div', { class: 'collection-thumbnail' }));
  const name = card.add(new Element('div', { class: 'name no-hover' }, 'Past the Night'));
  const revision = card.add(new Element('div', { class: 'revision-number' }, 'Revision 13'));
  let selected;
  if (phase === 'start') selected = modal.add(new Element('div', { id: 'collections-profile-select' }))
    .add(new Element('span', { class: 'Select-value-label' }, 'DEV (Current)'));
  const footer = modal.add(new Element('div', { class: 'modal-footer' }));
  const buttons = labels.map(label => footer.add(new Element('button', {}, label)));
  return { doc, modal, card, name, revision, selected, footer, buttons };
}
const options = { t: value => value, profileLabel: 'DEV (Current)' };
const read = f => inspect(f.doc, options);
test('idle document has no target', () => {
  const f = fixture(); f.doc.children = []; assert.equal(read(f).status, 'idle');
});
test('exact start reads only card fields and binds current selected label', () => {
  const f = fixture(); f.modal.add(new Element('p', {}, 'Wrong name Revision 99 Done'));
  const result = read(f); assert.equal(result.status, 'observed'); assert.equal(result.phase, 'start');
  assert.equal(result.name, 'Past the Night'); assert.equal(result.revisionLabel, 'Revision 13');
  assert.equal(result.selectedProfileLabel, 'DEV (Current)');
  assert.deepEqual(result.buttons, [{ action: 'later', enabled: true }, { action: 'install_now', enabled: true }]);
  assert.equal(result.candidate.element, f.buttons[1]); assert.equal(result.candidate.modal, f.modal);
});
test('finish Done returns exact target with no claimed profile identity', () => {
  const f = fixture('finish'); const result = read(f);
  assert.equal(result.phase, 'finish'); assert.equal(result.selectedProfileLabel, null);
  assert.equal(result.candidate.element, f.buttons[0]);
});
test('disabled target remains observed without candidate', () => {
  const f = fixture(); f.buttons[1].disabled = true;
  assert.equal(read(f).status, 'observed'); assert.equal(read(f).candidate, null);
});
for (const [label, mutate] of [
  ['duplicate wizard', f => f.doc.add(new Element('div', { id: 'install-finished-dialog' }))],
  ['wrong modal over wizard', f => f.doc.add(new Element('div', { class: 'modal' }))],
  ['duplicate card', f => f.modal.add(new Element('div', { class: 'collection-thumbnail' }))],
  ['wrong selected profile', f => { f.selected.value = 'OTHER'; }],
  ['duplicate selected profile', f => f.selected.parentElement.add(new Element('span', { class: 'Select-value-label' }, 'DEV (Current)'))],
  ['unknown footer button', f => f.footer.add(new Element('button', {}, 'Delete'))],
  ['profile confirmation', f => { f.buttons[0].value = 'No'; f.buttons[1].value = 'Yes'; }],
  ['disconnected target', f => { f.buttons[1].isConnected = false; }],
  ['foreign owner document', f => { f.buttons[1].ownerDocument = {}; }],
  ['hidden ancestor', f => { f.modal.style.display = 'none'; }],
  ['hidden target', f => { f.buttons[1].style.visibility = 'hidden'; }],
  ['absent card revision', f => { f.revision.attrs.class = 'instructions'; }],
]) test(`refuses ${label}`, () => { const f = fixture(); mutate(f); assert.equal(read(f).status, 'ambiguous'); });
test('known failure and optional footers cannot produce Done target', () => {
  for (const labels of [['View failed mods', 'Close'], ['View failed mods', 'Done'], ['No Thanks', 'View optional mods', 'Install optional mods']]) {
    const result = read(fixture('finish', labels)); assert.equal(result.status, 'observed'); assert.equal(result.candidate, null);
  }
});
test('translation resolves exact footer labels without English fallback', () => {
  const f = fixture(); f.buttons[0].value = 'Later translated'; f.buttons[1].value = 'Install translated';
  const result = inspect(f.doc, { ...options, t: value => ({ Later: 'Later translated', 'Install Now': 'Install translated' }[value] ?? value) });
  assert.equal(result.status, 'observed'); assert.equal(result.candidate.element, f.buttons[1]);
});
test('translation collisions fail closed', () => {
  assert.equal(inspect(fixture().doc, { ...options, t: () => 'same' }).status, 'ambiguous');
});
test('aria disabled and inert targets cannot be candidates', () => {
  const f = fixture(); f.buttons[1].attrs['aria-disabled'] = 'true';
  assert.equal(read(f).candidate, null);
  delete f.buttons[1].attrs['aria-disabled']; f.modal.attrs.inert = '';
  assert.equal(read(f).candidate, null);
});
