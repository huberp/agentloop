/** @type {import('jest').Config} */
module.exports = {
  preset: "ts-jest",
  testEnvironment: "node",
  testMatch: ["**/tests/e2e/**/*.e2e.test.ts"],
  transform: {
    "^.+\\.ts$": ["ts-jest", { tsconfig: "tsconfig.e2e.json" }],
  },
  moduleNameMapper: {
    "^@modelcontextprotocol/sdk/(.*)$":
      "<rootDir>/node_modules/@modelcontextprotocol/sdk/dist/cjs/$1",
  },
  moduleFileExtensions: ["ts", "tsx", "js", "jsx", "json"],
};
