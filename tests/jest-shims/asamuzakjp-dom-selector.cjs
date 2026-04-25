"use strict";
// CJS shim for @asamuzakjp/dom-selector (ESM-only in npm package).
// jsdom@29 uses DOMSelector for querySelector/querySelectorAll/matches/closest.
// The agent-loop tests do not depend on full CSS selector engine behavior;
// a basic structural implementation that handles simple tag/class/id selectors
// is sufficient.
//
// LIMITATIONS (by design — this is a test shim only):
// - Only simple selectors are supported (tag, #id, .class combinations).
// - Compound/descendant/sibling/pseudo selectors are NOT supported.
// - CSS identifiers are matched against [a-zA-Z0-9_-] only; Unicode and
//   escaped characters in selectors are not handled.
// - JSDOM NodeList impls do not support [i] indexing; item(i) is used instead.

// ---------------------------------------------------------------------------
// Minimal CSS selector helpers (no full CSS parser needed for tests)
// ---------------------------------------------------------------------------

/** Parse a single simple selector into parts */
function parseSimpleSelector(selector) {
  selector = selector.trim();
  const result = { tag: "*", id: null, classes: [] };

  // id: #foo
  const idMatch = selector.match(/#([a-zA-Z0-9_-]+)/);
  if (idMatch) result.id = idMatch[1];

  // classes: .foo.bar
  const classMatches = selector.match(/\.([a-zA-Z0-9_-]+)/g);
  if (classMatches) result.classes = classMatches.map((c) => c.slice(1));

  // tag: div, p, script …
  const tagMatch = selector.match(/^([a-zA-Z][a-zA-Z0-9]*)/);
  if (tagMatch) result.tag = tagMatch[1].toLowerCase();

  return result;
}

/** Test whether a node matches a simple selector object */
function matchesSimple(node, parsed) {
  if (!node || node.nodeType !== 1 /* ELEMENT_NODE */) return false;
  if (parsed.tag !== "*" && node.tagName.toLowerCase() !== parsed.tag) return false;
  if (parsed.id && node.getAttribute("id") !== parsed.id) return false;
  for (const cls of parsed.classes) {
    if (!node.classList || !node.classList.contains(cls)) return false;
  }
  return true;
}

/** Collect all descendant elements of `root` that match `parsed` */
function collectAll(root, parsed) {
  const results = [];
  // Use item(i) for JSDOM NodeList impls which do not support [i] indexing
  function walk(node) {
    const children = node.childNodes;
    if (!children) return;
    const len = children.length || 0;
    for (let i = 0; i < len; i++) {
      const child = children.item ? children.item(i) : children[i];
      if (!child) continue;
      if (child.nodeType === 1 /* ELEMENT_NODE */) {
        if (matchesSimple(child, parsed)) results.push(child);
        walk(child);
      }
    }
  }
  walk(root);
  return results;
}

/** Find first descendant matching `parsed` */
function findFirst(root, parsed) {
  const children = root.childNodes;
  if (!children) return null;
  const len = children.length || 0;
  for (let i = 0; i < len; i++) {
    const child = children.item ? children.item(i) : children[i];
    if (!child) continue;
    if (child.nodeType === 1 /* ELEMENT_NODE */) {
      if (matchesSimple(child, parsed)) return child;
      const found = findFirst(child, parsed);
      if (found) return found;
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// DOMSelector stub
// ---------------------------------------------------------------------------

class DOMSelector {
  constructor(_window, _document, _opt) {}

  clear() {}

  check(selector, node, _opt) {
    try {
      const parsed = parseSimpleSelector(selector);
      return { match: matchesSimple(node, parsed), pseudoElement: null, ast: null };
    } catch {
      return { match: false, pseudoElement: null, ast: null };
    }
  }

  matches(selector, node, _opt) {
    try {
      const parsed = parseSimpleSelector(selector);
      return matchesSimple(node, parsed);
    } catch {
      return false;
    }
  }

  closest(selector, node, _opt) {
    try {
      const parsed = parseSimpleSelector(selector);
      let current = node;
      while (current) {
        if (matchesSimple(current, parsed)) return current;
        current = current.parentNode || null;
      }
      return null;
    } catch {
      return null;
    }
  }

  querySelector(selector, node, _opt) {
    try {
      const parsed = parseSimpleSelector(selector);
      return findFirst(node, parsed);
    } catch {
      return null;
    }
  }

  querySelectorAll(selector, node, _opt) {
    try {
      const parsed = parseSimpleSelector(selector);
      return collectAll(node, parsed);
    } catch {
      return [];
    }
  }
}

module.exports = { DOMSelector };
