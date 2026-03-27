"use strict";
// CJS shim for @exodus/bytes/encoding-lite.js (ESM-only in npm package)
// Provides the subset used by html-encoding-sniffer (jsdom dependency):
// getBOMEncoding and labelToName are the primary consumers.
// We delegate to Node.js built-ins where possible.

const { TextDecoder, TextEncoder } = require("util");

/** Map WHATWG encoding label to a normalized name. */
function labelToName(label) {
  if (!label) return null;
  try {
    // Use TextDecoder to validate/normalize the encoding label.
    const td = new TextDecoder(label.trim().toLowerCase());
    return td.encoding;
  } catch {
    return null;
  }
}

/**
 * Detect BOM encoding from the first bytes of a Uint8Array.
 * Returns an encoding name or null.
 */
function getBOMEncoding(uint8Array) {
  if (uint8Array[0] === 0xfe && uint8Array[1] === 0xff) return "UTF-16BE";
  if (uint8Array[0] === 0xff && uint8Array[1] === 0xfe) return "UTF-16LE";
  if (uint8Array[0] === 0xef && uint8Array[1] === 0xbb && uint8Array[2] === 0xbf) return "UTF-8";
  return null;
}

function normalizeEncoding(label) {
  return labelToName(label);
}

function isomorphicDecode(uint8Array) {
  let str = "";
  for (let i = 0; i < uint8Array.length; i++) {
    str += String.fromCharCode(uint8Array[i]);
  }
  return str;
}

function isomorphicEncode(str) {
  const result = new Uint8Array(str.length);
  for (let i = 0; i < str.length; i++) {
    result[i] = str.charCodeAt(i);
  }
  return result;
}

module.exports = {
  TextDecoder,
  TextEncoder,
  TextDecoderStream: globalThis.TextDecoderStream,
  TextEncoderStream: globalThis.TextEncoderStream,
  normalizeEncoding,
  getBOMEncoding,
  labelToName,
  legacyHookDecode: () => {},
  isomorphicDecode,
  isomorphicEncode,
};
