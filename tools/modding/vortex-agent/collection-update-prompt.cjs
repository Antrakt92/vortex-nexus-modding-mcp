'use strict';
const crypto = require('node:crypto');
const { createWizardHostAdmission } = require('./collection-wizard-host.cjs');
// Official 2.9.1 ASAR ec3a29d58ea65a1ca84e456742c894a19efe96920a6710063d221d451a26d59a.
// Renderer171 eventHandlers.ts SHA 7e2769980f6c7d44599829d4631ff022a181fd700e8dbc87deccc06af28b8a12.
// Renderer242 InstallChangelogDialog.tsx SHA 882e6bb4dbc44300806e9f1df7f1f23e4e5c4db692a02cf269af520722c3d063.
const controllers = new WeakMap();
const need = (v, code) => { if (!v) throw Error('COLLECTION_UPDATE_PROMPT_' + code); };
const text = v => { need(typeof v === 'string' && v.trim().length > 0, 'TEXT_UNAVAILABLE'); return v.replace(/\s+/g, ' ').trim(); };
const id = v => typeof v === 'string' && v.length > 0 && v.length <= 200 && !/[\r\n\0]/.test(v);
function positive(v) {
  if (typeof v === 'string' && /^[1-9][0-9]*$/.test(v)) v = Number(v);
  need(Number.isSafeInteger(v) && v > 0, 'IDENTITY_INVALID'); return v;
}
const stable = value => JSON.stringify(value, (_, v) => v && typeof v === 'object' && !Array.isArray(v)
  ? Object.fromEntries(Object.keys(v).sort().map(k => [k, v[k]])) : v);
const fingerprint = value => crypto.createHash('sha256').update(stable(value)).digest('hex');
const all = (root, selector) => Array.from(root.querySelectorAll(selector));
function visible(element, doc) {
  if (!element || element.ownerDocument !== doc || element.isConnected !== true
    || typeof doc.defaultView?.getComputedStyle !== 'function') return false;
  for (let node = element; node; node = node.parentElement) {
    const s = doc.defaultView.getComputedStyle(node);
    if (node.hidden || node.getAttribute('aria-hidden') === 'true' || !s || s.display === 'none'
      || ['hidden', 'collapse'].includes(s.visibility) || Number(s.opacity) === 0) return false;
  }
  return typeof element.getClientRects === 'function' && element.getClientRects().length > 0;
}
function inspectPrompt(doc, expected, t) {
  try {
    need(doc && typeof doc.querySelectorAll === 'function', 'DOCUMENT_UNAVAILABLE');
    const roots = all(doc, '#install-changelog-dialog');
    if (!roots.length) {
      need(!all(doc, '.modal,[role="dialog"]').some(node => visible(node, doc)), 'OTHER_MODAL');
      return { status: 'idle', candidate: null };
    }
    need(roots.length === 1 && expected, 'PROMPT_UNBOUND');
    const modal = roots[0]; need(visible(modal, doc), 'PROMPT_NOT_VISIBLE');
    need(!all(doc, '.modal,[role="dialog"]').some(node => node !== modal && !modal.contains(node)
      && !node.contains(modal) && visible(node, doc)), 'OTHER_MODAL');
    const single = (root, selector) => { const nodes = all(root, selector); need(nodes.length === 1 && visible(nodes[0], doc), 'MARKUP_CHANGED'); return nodes[0]; };
    const card = single(modal, '.collection-thumbnail');
    need(text(single(card, '.name.no-hover').textContent) === expected.name
      && text(single(card, '.revision-number').textContent) === expected.revisionLabel, 'CARD_CHANGED');
    need(text(single(modal, '.modal-title').textContent) === expected.title, 'TITLE_CHANGED');
    const body = single(modal, '.modal-body');
    const headings = all(body, 'h4').filter(node => !node.closest('.changelog-scroll'));
    need(headings.length === 1 && visible(headings[0], doc) && text(headings[0].textContent) === expected.heading, 'HEADING_CHANGED');
    const footer = single(modal, '.modal-footer'), buttons = all(footer, 'button');
    need(buttons.length === 2 && text(buttons[0].textContent) === text(t('Later'))
      && text(buttons[1].textContent) === text(t('Download Update'))
      && text(t('Later')) !== text(t('Download Update')), 'FOOTER_CHANGED');
    need(!all(footer, 'a,input,select,textarea,[role="button"]').some(node => !buttons.includes(node)), 'FOOTER_CHANGED');
    for (const button of buttons) need(button.closest('.modal-footer') === footer && visible(button, doc), 'BUTTON_UNAVAILABLE');
    const element = buttons[1];
    need(element.disabled === false && element.getAttribute('disabled') === null
      && element.getAttribute('aria-disabled') !== 'true' && !element.closest('[inert]'), 'BUTTON_DISABLED');
    return { status: 'observed', candidate: { element, modal } };
  } catch (error) {
    return { status: 'ambiguous', reason: /^COLLECTION_UPDATE_PROMPT_[A-Z0-9_]+$/.test(error.message)
      ? error.message : 'COLLECTION_UPDATE_PROMPT_DOM_UNAVAILABLE', candidate: null };
  }
}
async function bounded(promise, milliseconds) {
  let timer;
  try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(Error('COLLECTION_UPDATE_PROMPT_UI_TIMEOUT')), milliseconds); })]); }
  finally { clearTimeout(timer); }
}
function createCollectionUpdatePromptController(api, options) {
  const { selectors, util } = options;
  const doc = () => options.getDocument ? options.getDocument() : typeof document === 'object' ? document : null;
  const t = (...args) => api.translate(...args);
  const admit = options.admit || createWizardHostAdmission(api, util);
  const admitRead = options.admitRead || createWizardHostAdmission(api, util);
  let ready = false, invalidated = false, binding = null, prepared = null, proof = null, readQueue = Promise.resolve();
  const state = () => api.getState();
  const context = () => ({ gameId: selectors.activeGameId(state()), profileId: selectors.activeProfileId(state()),
    nextProfileId: state().settings?.profiles?.nextProfileId });
  function contextCheck() {
    const c = context(); need(binding && c.gameId === binding.gameId && c.profileId === binding.profileId
      && c.nextProfileId === binding.profileId && state().persistent.profiles[c.profileId]?.gameId === c.gameId, 'CONTEXT_CHANGED');
    return c;
  }
  const owner = () => state().persistent?.mods?.[binding?.gameId]?.[binding?.oldModId];
  function checkOwner() {
    const m = owner(); need(m && fingerprint(m) === binding.ownerFingerprint
      && fingerprint(m.rules ?? []) === binding.rulesFingerprint, 'OLD_OWNER_CHANGED');
  }
  const inspect = () => inspectPrompt(doc(), binding?.display, t);
  const initialized = bounded(Promise.resolve().then(() => api.awaitUI()), 180000).then(() => {
    need(inspect().status === 'idle', 'PREEXISTING_PROMPT'); ready = true;
  }).catch(() => { invalidated = true; });
  api.events.on('collection-update', (gameId, slug, revisionNumber, source, oldModId) => {
    try {
      need(ready && !invalidated && !binding && inspect().status === 'idle', 'EVENT_QUEUE_UNBOUND');
      need(gameId === 'cyberpunk2077' && source === 'nexus' && id(oldModId)
        && typeof slug === 'string' && /^[A-Za-z0-9_-]{1,200}$/.test(slug), 'EVENT_UNRELATED');
      const c = context(); need(c.gameId === gameId && id(c.profileId) && c.nextProfileId === c.profileId, 'CONTEXT_CHANGED');
      need(state().session?.collections && state().session.collections.activeSession === undefined, 'SESSION_ACTIVE');
      const m = state().persistent?.mods?.[gameId]?.[oldModId];
      need(m?.type === 'collection' && m.state === 'installed' && id(m.archiveId)
        && m.attributes?.collectionSlug === slug, 'OLD_OWNER_UNAVAILABLE');
      const collectionId = positive(m.attributes.collectionId), target = positive(revisionNumber);
      const name = text(util.renderModName(m, { version: false }));
      const oldVersion = m.attributes.version ?? '0';
      need(typeof oldVersion === 'string' || Number.isFinite(oldVersion), 'OLD_VERSION_UNAVAILABLE');
      binding = { gameId, profileId: c.profileId, oldModId, archiveId: m.archiveId, collectionId,
        collectionSlug: slug, revisionNumber: target, action: 'download_update',
        ownerFingerprint: fingerprint(m), rulesFingerprint: fingerprint(m.rules ?? []),
        display: { name, revisionLabel: text(t('Revision {{number}}{{forceRevision}}', { replace: { number: oldVersion, forceRevision: ' ➔ ' + target } })),
          title: text(t('{{collectionName}} update', { replace: { collectionName: util.renderModName(m) } })),
          heading: text(t('Revision {{revNum}} Changelog', { replace: { revNum: target } })) } };
      contextCheck();
    } catch (_) { invalidated = true; }
  });
  function argsMatch(args) {
    need(ready && !invalidated && binding, 'BINDING_UNAVAILABLE');
    need(['gameId', 'profileId', 'oldModId', 'collectionId', 'collectionSlug', 'revisionNumber', 'action']
      .every(key => args[key] === binding[key]), 'REQUEST_IDENTITY_CHANGED');
  }
  function validate(args) {
    argsMatch(args); need(prepared && !prepared.consumed && prepared.requestId === args.requestId, 'PREPARATION_REQUIRED');
    admit.revalidate(proof); contextCheck(); checkOwner();
    need(state().session?.collections?.activeSession === undefined, 'SESSION_ACTIVE');
    need(Array.isArray(state().session?.notifications?.dialogs) && state().session.notifications.dialogs.length === 0, 'NATIVE_DIALOG_PENDING');
    const current = inspect(); need(current.status === 'observed' && current.candidate.element === prepared.element
      && current.candidate.modal === prepared.modal, 'DOM_CHANGED');
    return true;
  }
  function verifyDismissal(args) {
    argsMatch(args); need(prepared?.consumed && prepared.requestId === args.requestId, 'CLICK_REQUIRED');
    contextCheck();
    // showChangelog.onContinue removes its job before resolving. Subsequent
    // download/cleanup may remove the old owner or display the next dialog.
    // Neither is a condition on the narrowly claimed prompt dismissal.
    const roots = all(doc(), '#install-changelog-dialog');
    need(roots.length <= 1, 'PROMPT_QUEUE_CHANGED');
    if (!roots.length) return true;
    need(roots[0] === prepared.modal, 'PROMPT_REPLACED'); return false;
  }
  return {
    initialized,
    readiness() {
      const read = async () => {
        await initialized;
        const out = { schema: 'collection-update-prompt-readiness/1', status: 'held', action: 'download_update',
          sourceAdmitted: false, writesAvailable: false, nativePromptDismissalVerified: false, installationCompleted: false };
        try {
          need(ready && !invalidated, 'BINDING_UNAVAILABLE');
          const readProof = await admitRead(); admitRead.revalidate(readProof); out.sourceAdmitted = true;
          if (!binding) { need(inspect().status === 'idle', 'PROMPT_UNBOUND'); return { ...out, status: 'idle' }; }
          contextCheck(); checkOwner();
          need(!prepared?.consumed, 'ACTION_CONSUMED'); need(inspect().status === 'observed', 'DOM_UNAVAILABLE');
          return { ...out, status: 'ready', sourceAdmitted: true, ...Object.fromEntries(['gameId', 'profileId', 'oldModId', 'collectionId', 'collectionSlug', 'revisionNumber'].map(key => [key, binding[key]])) };
        } catch (error) { return { ...out, reason: /^COLLECTION_UPDATE_PROMPT_[A-Z0-9_]+$/.test(error.message) ? error.message : 'COLLECTION_UPDATE_PROMPT_SOURCE_UNAVAILABLE' }; }
      };
      const result = readQueue.then(read, read); readQueue = result.then(() => {}, () => {}); return result;
    },
    async prepare(args) {
      await initialized; argsMatch(args); need(!prepared?.consumed, 'ACTION_CONSUMED');
      need(typeof args.requestId === 'string' && /^[A-Za-z0-9_-]{8,80}$/.test(args.requestId), 'REQUEST_INVALID');
      proof = await admit(); argsMatch(args); contextCheck(); checkOwner();
      const current = inspect(); need(current.status === 'observed', 'DOM_UNAVAILABLE');
      prepared = { requestId: args.requestId, ...current.candidate, consumed: false }; validate(args);
    },
    validate,
    click(args) { validate(args); prepared.consumed = true; prepared.element.click(); return true; },
    async waitForTransition(args) {
      const deadline = Date.now() + (options.transitionTimeoutMs ?? 15000);
      while (!verifyDismissal(args)) { need(Date.now() < deadline, 'DISMISSAL_TIMEOUT'); await new Promise(resolve => setTimeout(resolve, options.pollMs ?? 100)); }
      return { ...Object.fromEntries(['oldModId', 'collectionId', 'collectionSlug', 'revisionNumber', 'action'].map(key => [key, binding[key]])),
        nativePromptDismissalVerified: true, installationCompleted: false };
    },
    verifyTransition(args, result) {
      admit.revalidate(proof); need(verifyDismissal(args), 'DISMISSAL_UNVERIFIED');
      need(result.nativePromptDismissalVerified === true && result.installationCompleted === false
        && ['oldModId', 'collectionId', 'collectionSlug', 'revisionNumber', 'action'].every(key => result[key] === binding[key]), 'RESULT_CHANGED');
      prepared.completed = true; return true;
    },
    committed(args) {
      if (prepared?.completed && prepared.requestId === args.requestId) { binding = null; prepared = null; proof = null; }
    },
  };
}
function getCollectionUpdatePromptController(api, options) {
  if (!controllers.has(api)) controllers.set(api, createCollectionUpdatePromptController(api, options));
  return controllers.get(api);
}
module.exports = { createCollectionUpdatePromptController, getCollectionUpdatePromptController, inspectPrompt };
