'use strict';
const test = require('node:test'), assert = require('node:assert/strict'), { EventEmitter } = require('node:events');
const { createCollectionUpdatePromptController, getCollectionUpdatePromptController } = require('./collection-update-prompt.cjs');
class Element {
  constructor(tag = 'div', attrs = {}, value = '') {
    this.tag = tag; this.attrs = attrs; this.value = value; this.children = []; this.parentElement = null;
    this.ownerDocument = null; this.isConnected = true; this.disabled = false;
    this.style = { display: 'block', visibility: 'visible', opacity: '1' };
  }
  add(node) { node.parentElement = this; node.ownerDocument = this.ownerDocument; this.children.push(node); return node; }
  get textContent() { return this.value + this.children.map(child => child.textContent).join(''); }
  getAttribute(key) { return this.attrs[key] ?? null; }
  getClientRects() { return [{}]; }
  contains(node) { return this === node || this.children.some(child => child.contains(node)); }
  matches(selector) {
    if (selector.startsWith('#')) return this.attrs.id === selector.slice(1);
    if (selector.startsWith('.')) return selector.slice(1).split('.').every(key => (this.attrs.class ?? '').split(' ').includes(key));
    if (selector.startsWith('[')) {
      const [, key, val] = selector.match(/^\[([^=\]]+)(?:="([^"]*)")?\]$/) ?? [];
      return key && this.getAttribute(key) !== null && (val === undefined || this.attrs[key] === val);
    }
    return this.tag === selector;
  }
  closest(selector) { for (let node = this; node; node = node.parentElement) if (selector.split(',').some(part => node.matches(part))) return node; return null; }
  querySelectorAll(selector) {
    const result = []; const walk = node => { for (const child of node.children) {
      if (selector.split(',').some(part => child.matches(part))) result.push(child); walk(child);
    } }; walk(this); return result;
  }
}
function documentFixture() {
  const doc = new Element('document'); doc.ownerDocument = doc; doc.defaultView = { getComputedStyle: node => node.style }; return doc;
}
function prompt(doc) {
  const modal = doc.add(new Element('div', { id: 'install-changelog-dialog', class: 'modal', role: 'dialog' }));
  const title = modal.add(new Element('h4', { class: 'modal-title' }, 'Our Collection 12 update'));
  const body = modal.add(new Element('div', { class: 'modal-body' }));
  const card = body.add(new Element('div', { class: 'collection-thumbnail' }));
  const name = card.add(new Element('div', { class: 'name no-hover' }, 'Our Collection'));
  const revision = card.add(new Element('div', { class: 'revision-number' }, 'Revision 12 ➔ 13'));
  const heading = body.add(new Element('h4', {}, 'Revision 13 Changelog'));
  const changelog = body.add(new Element('div', { class: 'changelog-scroll' }, 'untrusted Later Download Update Revision 999'));
  const footer = modal.add(new Element('div', { class: 'modal-footer' }));
  const later = footer.add(new Element('button', {}, 'Later')), button = footer.add(new Element('button', {}, 'Download Update'));
  return { modal, title, body, card, name, revision, heading, changelog, footer, later, button };
}
async function fixture() {
  const doc = documentFixture(), gameId = 'cyberpunk2077', profileId = 'profile';
  const state = { settings: { profiles: { nextProfileId: profileId } }, persistent: {
    profiles: { profile: { gameId } }, mods: { [gameId]: { old: { id: 'old', state: 'installed', type: 'collection',
      archiveId: 'old-archive', rules: [{ type: 'requires', reference: { id: 'member' } }],
      attributes: { collectionId: 123, collectionSlug: 'ours', version: '12', customFileName: 'Our Collection' } } } } },
    session: { collections: {}, notifications: { dialogs: [] } } };
  let clicks = 0, sourceValid = true, ui = null, prepareHook = () => {}, clickHook = () => { doc.children = []; };
  const api = { events: new EventEmitter(), getState: () => state, awaitUI: async () => {},
    translate: (key, opts) => key.replace(/\{\{(\w+)\}\}/g, (_, k) => opts.replace[k]) };
  const makeAdmission = () => {
    let retained;
    const admit = async () => { await prepareHook(); assert.equal(sourceValid, true); retained = {}; return retained; };
    admit.revalidate = proof => { assert.equal(sourceValid, true); assert.equal(proof, retained); return proof; }; return admit;
  };
  const options = { selectors: { activeGameId: () => gameId, activeProfileId: () => profileId },
    util: { renderModName: (m, opts) => m.attributes.customFileName + (opts?.version === false ? '' : ' ' + m.attributes.version) },
    getDocument: () => doc, admit: makeAdmission(), admitRead: makeAdmission(), pollMs: 1, transitionTimeoutMs: 5 };
  const controller = createCollectionUpdatePromptController(api, options); await controller.initialized;
  const args = { gameId, profileId, oldModId: 'old', collectionId: 123, collectionSlug: 'ours', revisionNumber: 13,
    requestId: 'update_prompt_request', action: 'download_update' };
  const emit = (...values) => api.events.emit('collection-update', ...values);
  function bind() { emit(gameId, 'ours', 13, 'nexus', 'old', () => {}); ui = prompt(doc); ui.button.click = () => { clicks++; clickHook(); }; }
  return { doc, state, api, options, controller, args, emit, bind, get ui() { return ui; }, get clicks() { return clicks; },
    set sourceValid(v) { sourceValid = v; }, set prepareHook(v) { prepareHook = v; }, set clickHook(v) { clickHook = v; } };
}

test('idle readiness verifies host sources before another collection update begins',async()=>{
 const f=await fixture();const initial=await f.controller.readiness();assert.equal(initial.status,'idle');assert.equal(initial.sourceAdmitted,true);
 f.sourceValid=false;const held=await f.controller.readiness();assert.equal(held.status,'held');assert.equal(held.sourceAdmitted,false);
 assert.equal(f.clicks,0);
});
test('event-bound old-to-new prompt clicks once and reports only dismissal, repeatable verification', async () => {
  const f = await fixture(); assert.equal((await f.controller.readiness()).status, 'idle'); f.bind();
  assert.equal((await f.controller.readiness()).status, 'ready'); await f.controller.prepare(f.args);
  f.controller.validate(f.args); f.controller.click(f.args); const result = await f.controller.waitForTransition(f.args);
  assert.deepEqual(result, { oldModId: 'old', collectionId: 123, collectionSlug: 'ours', revisionNumber: 13,
    action: 'download_update', nativePromptDismissalVerified: true, installationCompleted: false });
  f.controller.verifyTransition(f.args, result); f.controller.verifyTransition(f.args, result); assert.equal(f.clicks, 1);
  assert.throws(() => f.controller.click(f.args), /PREPARATION_REQUIRED/);
  f.controller.committed(f.args); assert.equal((await f.controller.readiness()).status, 'idle');
});
test('old owner may be removed and next dialog shown after click without claiming its outcome', async () => {
  const f = await fixture(); f.bind(); await f.controller.prepare(f.args);
  f.clickHook = () => { f.doc.children = []; delete f.state.persistent.mods.cyberpunk2077.old;
    f.doc.add(new Element('div', { class: 'modal' }, 'Another stock continuation')); };
  f.controller.click(f.args); const result = await f.controller.waitForTransition(f.args);
  assert.equal(f.controller.verifyTransition(f.args, result), true); assert.equal(result.installationCompleted, false);
});
test('preexisting prompt at constructor epoch cannot be adopted', async () => {
  const f = await fixture(); prompt(f.doc);
  const c = createCollectionUpdatePromptController(f.api, f.options); await c.initialized;
  assert.equal((await c.readiness()).status, 'held'); await assert.rejects(c.prepare(f.args), /BINDING_UNAVAILABLE/);
});
test('DOM prompt without genuine event remains unbound', async () => {
  const f = await fixture(); prompt(f.doc); await assert.rejects(f.controller.prepare(f.args), /BINDING_UNAVAILABLE/);
});
for (const [name, mutate] of [
  ['wrong collection name', f => { f.ui.name.value = 'Different'; }],
  ['wrong target revision', f => { f.ui.revision.value = 'Revision 12 ➔ 14'; }],
  ['wrong header', f => { f.ui.heading.value = 'Revision 99 Changelog'; }],
  ['unknown footer', f => { f.ui.footer.add(new Element('button', {}, 'Remove All')); }],
  ['disabled target', f => { f.ui.button.disabled = true; }],
  ['disconnected target', f => { f.ui.button.isConnected = false; }],
  ['hidden target', f => { f.ui.button.style.display = 'none'; }],
  ['duplicate prompt', f => { prompt(f.doc); }],
  ['other modal', f => { f.doc.add(new Element('div', { class: 'modal' })); }],
  ['old rules changed', f => { f.state.persistent.mods.cyberpunk2077.old.rules = []; }],
  ['old archive changed', f => { f.state.persistent.mods.cyberpunk2077.old.archiveId = 'replacement'; }],
  ['next profile changed', f => { f.state.settings.profiles.nextProfileId = 'other'; }],
  ['native question pending', f => { f.state.session.notifications.dialogs.push({}); }],
]) test(`refuses ${name} before click`, async () => {
  const f = await fixture(); f.bind(); mutate(f); await assert.rejects(f.controller.prepare(f.args)); assert.equal(f.clicks, 0);
});
test('duplicate or unrelated update events invalidate retained binding', async () => {
  for (const values of [['cyberpunk2077','ours',13,'nexus','old'],['cyberpunk2077','other',14,'nexus','old'],['other','ours',13,'nexus','old']]) {
    const f = await fixture(); f.bind(); f.emit(...values); await assert.rejects(f.controller.prepare(f.args), /BINDING_UNAVAILABLE/);
  }
});
test('asynchronous source-preparation drift is rechecked before click', async () => {
  const f = await fixture(); f.bind(); f.prepareHook = () => { f.state.settings.profiles.nextProfileId = 'other'; };
  await assert.rejects(f.controller.prepare(f.args), /CONTEXT_CHANGED/); assert.equal(f.clicks, 0);
});
test('source generation change after preparation refuses click', async () => {
  const f = await fixture(); f.bind(); await f.controller.prepare(f.args); f.sourceValid = false;
  assert.throws(() => f.controller.click(f.args)); assert.equal(f.clicks, 0);
});
test('throwing click remains consumed and cannot be repeated or re-prepared', async () => {
  const f = await fixture(); f.bind(); await f.controller.prepare(f.args); f.clickHook = () => { throw Error('NATIVE_THROW'); };
  assert.throws(() => f.controller.click(f.args), /NATIVE_THROW/); assert.equal(f.clicks, 1);
  await assert.rejects(f.controller.prepare({ ...f.args, requestId: 'another_request' }), /ACTION_CONSUMED/);
});
test('no prompt dismissal times out and cannot verify or repeat', async () => {
  const f = await fixture(); f.bind(); await f.controller.prepare(f.args); f.clickHook = () => {};
  f.controller.click(f.args); await assert.rejects(f.controller.waitForTransition(f.args), /DISMISSAL_TIMEOUT/);
  assert.equal(f.clicks, 1); assert.throws(() => f.controller.verifyTransition(f.args, {}), /DISMISSAL_UNVERIFIED/);
});
test('read admission cannot replace write proof generation', async () => {
  const f = await fixture(); f.bind(); await f.controller.prepare(f.args);
  await Promise.all([f.controller.readiness(), f.controller.readiness()]); f.controller.click(f.args);
  const result = await f.controller.waitForTransition(f.args); assert.equal(f.controller.verifyTransition(f.args, result), true);
});
test('controller getter retains per-api event observer', async () => {
  const f = await fixture(); const a = getCollectionUpdatePromptController(f.api, f.options), b = getCollectionUpdatePromptController(f.api, f.options);
  assert.equal(a,b); await a.initialized;
});
