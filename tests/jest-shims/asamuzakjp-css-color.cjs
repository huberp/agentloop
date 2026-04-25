"use strict";
// CJS shim for @asamuzakjp/css-color (ESM-only in npm package).
// jsdom@29 imports this module for CSS color resolution.  The agent-loop
// tests do not exercise CSS rendering, so stub implementations that pass
// through / return safe defaults are sufficient.
//
// NOTE: This shim returns pass-through values only. Full CSS color parsing
// is not implemented; tests that require accurate color computation should
// not rely on this shim.

/**
 * Resolve a CSS colour value to a canonical form.
 * Returns the input unchanged when resolution is not needed.
 */
function resolve(value, opt) {
  if (typeof value === "string") return value;
  return "";
}

/**
 * Convert a colour between spaces.
 * Returns null (indicating "not resolved") so jsdom falls back gracefully.
 */
function convert(value, opt) {
  return null;
}

/** Utility helpers exposed by the real package. Stubbed as no-ops. */
const utils = {
  cssCalc: (value) => value,
  cssVar: (value) => value,
  extractDashedIdent: () => [],
  isAbsoluteFontSize: () => false,
  isAbsoluteSizeOrLength: () => false,
  isColor: (value) => typeof value === "string",
  isGradient: () => false,
  resolveGradient: (value) => value,
  resolveLengthInPixels: () => 0,
  splitValue: (value) => (typeof value === "string" ? [value] : []),
};

module.exports = { resolve, convert, utils };
