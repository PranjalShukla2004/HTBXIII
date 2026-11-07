"""Extract interactable controls and their semantic context from the live DOM."""
from __future__ import annotations

from playwright.sync_api import Page


_JS = r"""() => {
  const query = 'input, textarea, select, button, a, [role="button"], [role="textbox"], [contenteditable="true"]';
  const elements = Array.from(document.querySelectorAll(query));
  let index = 0;
  return elements.flatMap((el) => {
    const css = window.getComputedStyle(el);
    if (!el.getClientRects().length || css.visibility === 'hidden' || css.display === 'none'
        || el.hasAttribute('disabled') || el.getAttribute('aria-hidden') === 'true') return [];

    const tag = el.tagName.toLowerCase();
    const type = (el.getAttribute('type') || '').toLowerCase();
    if (['hidden', 'password', 'file', 'radio'].includes(type)) return [];
    const role = (el.getAttribute('role') || '').toLowerCase();
    const contenteditable = el.getAttribute('contenteditable') === 'true';

    let action;
    if (type === 'checkbox') action = 'check';
    else if (tag === 'select') action = 'select_option';
    else if (tag === 'button' || tag === 'a' || role === 'button' || ['submit', 'button'].includes(type)) action = 'click';
    else if (tag === 'input' || tag === 'textarea' || role === 'textbox' || contenteditable) action = 'fill';
    else return [];

    const labelText = Array.from(el.labels || []).map(l => l.innerText?.trim() || '').join(' ');
    const labelledby = (el.getAttribute('aria-labelledby') || '').split(/\s+/)
      .filter(Boolean)
      .map(id => document.getElementById(id)?.innerText?.trim() || '')
      .join(' ');
    const ariaLabel = el.getAttribute('aria-label') || '';
    const placeholder = el.getAttribute('placeholder') || '';
    const text = (el.innerText || el.getAttribute('value') || '').trim().slice(0, 160);
    const form = el.closest('form');
    const heading = form?.querySelector('h1, h2, h3, legend');
    const context = (heading?.innerText || form?.getAttribute('aria-label') || '').trim().slice(0, 120);
    const name = el.getAttribute('name') || '';
    const title = el.getAttribute('title') || '';
    const id = `swa-${index++}`;
    el.setAttribute('data-swa-id', id);
    const label = [labelText, labelledby, ariaLabel, placeholder, text, title, name]
      .map(s => (s || '').trim()).find(Boolean) || '';
    return [{ id, action, label, placeholder, text, name, type, context, tag }];
  });
}"""


def discover(page: Page) -> list[dict]:
    """Discover controls in main document only; iframe/shadow support is future work."""
    return page.evaluate(_JS)
