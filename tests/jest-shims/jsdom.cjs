"use strict";
// Minimal CJS shim for jsdom used in Jest tests.
// web-fetch.test.ts overrides this with its own jest.mock() factory;
// other tests only need this so that the import in web-fetch.ts does not fail.
class JSDOM {
  constructor(html, _opts) {
    this.window = {
      document: {
        title: "",
        body: { innerHTML: html || "" },
      },
    };
  }
}

module.exports = { JSDOM };
