'use strict';

// Fixed markup contract: official Vortex 2.9.1 renderer map sources 240/243/244.
// Inspection only. Native collection/profile/session identity is checked elsewhere.
const LABELS = Object.freeze({ later: 'Later', install_now: 'Install Now', done: 'Done',
  view_failed: 'View failed mods', close: 'Close', no_thanks: 'No Thanks',
  view_optionals: 'View optional mods', install_optionals: 'Install optional mods' });
const text = element => String(element.textContent ?? '').replace(/\s+/g, ' ').trim();
const all = (root, selector) => Array.from(root.querySelectorAll(selector));

function visible(element, doc) {
  if (!element || element.ownerDocument !== doc || element.isConnected !== true) return false;
  if (typeof doc.defaultView?.getComputedStyle !== 'function') return false;
  for (let node = element; node && node !== doc; node = node.parentElement) {
    if (node.hidden || node.getAttribute('aria-hidden') === 'true') return false;
    const style = doc.defaultView.getComputedStyle(node);
    if (!style || style.display === 'none' || ['hidden', 'collapse'].includes(style.visibility)
      || Number(style.opacity) === 0) return false;
  }
  return typeof element.getClientRects === 'function' && element.getClientRects().length > 0;
}

function inspect(doc, { t, profileLabel } = {}) {
  const refuse = reason => ({ status: 'ambiguous', reason, candidate: null });
  try {
    if (!doc || typeof doc.querySelectorAll !== 'function' || typeof t !== 'function') return refuse('document_or_translation_unavailable');
    const starts = all(doc, '.collections-instructions-canbereviewed');
    const finishes = all(doc, '#install-finished-dialog');
    if (starts.length === 0 && finishes.length === 0) return { status: 'idle', candidate: null };
    if (starts.length + finishes.length !== 1) return refuse('wizard_root_count');
    const phase = starts.length ? 'start' : 'finish';
    const modal = starts.length ? starts[0].closest('.modal,[role="dialog"]') : finishes[0];
    if (!visible(modal, doc)) return refuse('wizard_not_visible');
    if (starts.length && !visible(starts[0], doc)) return refuse('start_marker_not_visible');
    const otherModals = all(doc, '.modal,[role="dialog"]').filter(node => node !== modal
      && !modal.contains(node) && !node.contains(modal) && visible(node, doc));
    if (otherModals.length) return refuse('other_visible_modal');
    const cards = all(modal, '.collection-thumbnail');
    if (cards.length !== 1) return refuse('collection_card_count');
    const names = all(cards[0], '.name.no-hover'), revisions = all(cards[0], '.revision-number');
    if (names.length !== 1 || revisions.length !== 1 || !visible(names[0], doc)
      || !visible(revisions[0], doc) || !text(names[0]) || !text(revisions[0])) return refuse('collection_card_identity');
    let selectedProfileLabel = null;
    const selections = all(modal, '#collections-profile-select .Select-value-label');
    if (phase === 'start') {
      if (typeof profileLabel !== 'string' || !profileLabel.trim() || selections.length !== 1
        || !visible(selections[0], doc)) return refuse('profile_selection_unavailable');
      selectedProfileLabel = text(selections[0]);
      // Caller supplies the already translated exact current-option label.
      if (selectedProfileLabel !== profileLabel.replace(/\s+/g, ' ').trim()) return refuse('current_profile_not_selected');
    } else if (selections.length) return refuse('unexpected_finish_profile_selector');
    const footers = all(modal, '.modal-footer');
    if (footers.length !== 1 || !visible(footers[0], doc)) return refuse('footer_count');
    const elements = all(footers[0], 'button');
    if (all(footers[0], 'a,input,select,textarea,[role="button"]').some(node => !elements.includes(node))) return refuse('unexpected_footer_control');
    const translated = Object.entries(LABELS).map(([action, label]) => [action, t(label)]);
    if (translated.some(([, label]) => typeof label !== 'string' || !label.trim())) return refuse('translation_unavailable');
    const normalized = translated.map(([action, label]) => [action, label.replace(/\s+/g, ' ').trim()]);
    if (new Set(normalized.map(([, label]) => label)).size !== normalized.length) return refuse('translation_collision');
    const buttons = [];
    for (const element of elements) {
      const matches = normalized.filter(([, label]) => label === text(element));
      if (matches.length !== 1 || element.closest('.modal-footer') !== footers[0]
        || !visible(element, doc)) return refuse('unknown_or_hidden_footer_button');
      buttons.push({ action: matches[0][0], enabled: element.disabled === false
        && element.getAttribute('disabled') === null && element.getAttribute('aria-disabled') !== 'true'
        && !element.closest('[inert]') });
    }
    const actions = buttons.map(button => button.action).join(',');
    const accepted = phase === 'start' ? ['later,install_now'] : ['view_failed,close',
      'no_thanks,view_optionals,install_optionals', 'view_failed,no_thanks,view_optionals,install_optionals',
      'done', 'view_failed,done'];
    if (!accepted.includes(actions)) return refuse('unexpected_footer_shape');
    const action = phase === 'start' ? 'install_now' : 'done';
    const index = phase === 'finish' && actions !== 'done' ? -1
      : buttons.findIndex(button => button.action === action && button.enabled);
    return { status: 'observed', phase, name: text(names[0]), revisionLabel: text(revisions[0]),
      selectedProfileLabel, buttons, candidate: index < 0 ? null : { element: elements[index], modal } };
  } catch (_) { return refuse('dom_read_failed'); }
}

module.exports = { inspect };
