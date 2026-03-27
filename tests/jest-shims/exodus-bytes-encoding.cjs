"use strict";
// CJS shim for @exodus/bytes/encoding-lite.js to work around ESM in Jest
const { TextDecoder, TextEncoder } = require("util");

function getBOMEncoding(uint8Array) {
  if (!uint8Array || uint8Array.length < 2) return null;
  if (uint8Array[0] === 0xfe && uint8Array[1] === 0xff) return "UTF-16BE";
  if (uint8Array[0] === 0xff && uint8Array[1] === 0xfe) return "UTF-16LE";
  if (uint8Array.length >= 3 && uint8Array[0] === 0xef && uint8Array[1] === 0xbb && uint8Array[2] === 0xbf) return "UTF-8";
  return null;
}

function labelToName(label) {
  if (!label) return null;
  const l = label.toLowerCase().trim();
  if (l === "utf-8" || l === "utf8") return "UTF-8";
  if (l === "utf-16be") return "UTF-16BE";
  if (l === "utf-16le" || l === "utf-16") return "UTF-16LE";
  if (l === "windows-1252" || l === "latin1" || l === "iso-8859-1") return "windows-1252";
  return null;
}

module.exports = {
  TextDecoder,
  TextEncoder,
  TextDecoderStream: class TextDecoderStream {},
  TextEncoderStream: class TextEncoderStream {},
  normalizeEncoding: (e) => e,
  getBOMEncoding,
  labelToName,
  legacyHookDecode: null,
  isomorphicDecode: (bytes) => Buffer.from(bytes).toString("binary"),
  isomorphicEncode: (str) => Buffer.from(str, "binary"),
};
