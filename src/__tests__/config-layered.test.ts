/**
 * Tests for the layered JSON configuration system.
 *
 * Covers:
 * - Loading with no JSON config present (defaults only)
 * - User-only config
 * - Repo-only config
 * - User + repo merge
 * - Models merge by id
 * - Env overriding JSON
 * - CLI API key override still working
 * - Invalid JSON failure
 * - Invalid schema failure
 * - Backward compatibility with current env-driven behavior
 */

import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { loadConfig, CONFIG_DEFAULTS, ConfigLoadError } from "../config/load";
import { deepMerge, mergeModels, mergeConfigs } from "../config/merge";
import type { ModelConfig, PartialAgentLoopConfig } from "../config/schema";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Create a temporary directory and return its path. */
function mkTmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "agentloop-config-test-"));
}

/** Write a JSON config file at the given path, creating parent dirs as needed. */
function writeConfig(filePath: string, config: object): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(config, null, 2));
}

/** Write raw text to a file at the given path. */
function writeRaw(filePath: string, content: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content);
}

// ---------------------------------------------------------------------------
// Merge utilities
// ---------------------------------------------------------------------------

describe("deepMerge", () => {
  it("merges plain objects recursively", () => {
    const base = { a: { b: 1, c: 2 }, d: 3 };
    const over = { a: { c: 99 }, e: 5 };
    const result = deepMerge(base, over);
    expect(result).toEqual({ a: { b: 1, c: 99 }, d: 3, e: 5 });
  });

  it("replaces scalars", () => {
    const result = deepMerge({ x: "old" }, { x: "new" });
    expect(result.x).toBe("new");
  });

  it("replaces non-models arrays entirely", () => {
    const result = deepMerge(
      { tools: { blocklist: ["a", "b"] } } as Record<string, unknown>,
      { tools: { blocklist: ["c"] } } as Record<string, unknown>,
    );
    expect((result as { tools: { blocklist: string[] } }).tools.blocklist).toEqual(["c"]);
  });

  it("skips undefined values in override", () => {
    const result = deepMerge({ a: 1 }, { a: undefined });
    expect(result.a).toBe(1);
  });
});

describe("mergeModels", () => {
  const base: ModelConfig[] = [
    { id: "default", provider: "mistral", model: "mistral-small-latest", temperature: 0.2 },
    { id: "fast", provider: "mistral", model: "mistral-tiny-latest" },
  ];

  it("preserves base models when override is empty", () => {
    expect(mergeModels(base, [])).toEqual(base);
  });

  it("overrides existing model by id (field-level merge)", () => {
    const override: ModelConfig[] = [
      { id: "default", provider: "mistral", model: "mistral-medium-latest" },
    ];
    const result = mergeModels(base, override);
    expect(result).toHaveLength(2);
    expect(result[0]).toEqual({
      id: "default",
      provider: "mistral",
      model: "mistral-medium-latest",
      temperature: 0.2, // preserved from base
    });
    expect(result[1]).toEqual(base[1]); // unchanged
  });

  it("appends new models from override", () => {
    const override: ModelConfig[] = [
      { id: "strong", provider: "mistral", model: "mistral-large-latest", temperature: 0.1 },
    ];
    const result = mergeModels(base, override);
    expect(result).toHaveLength(3);
    expect(result[2].id).toBe("strong");
  });

  it("both overrides and appends in one pass", () => {
    const override: ModelConfig[] = [
      { id: "default", provider: "mistral", model: "mistral-medium-latest" },
      { id: "strong", provider: "mistral", model: "mistral-large-latest" },
    ];
    const result = mergeModels(base, override);
    expect(result).toHaveLength(3);
    expect(result[0].model).toBe("mistral-medium-latest");
    expect(result[2].id).toBe("strong");
  });

  it("maintains deterministic order: base first, then new overrides", () => {
    const override: ModelConfig[] = [
      { id: "z-model", provider: "other", model: "z" },
      { id: "a-model", provider: "other", model: "a" },
    ];
    const result = mergeModels([], override);
    expect(result.map((m) => m.id)).toEqual(["z-model", "a-model"]);
  });
});

describe("mergeConfigs", () => {
  it("merges multiple layers in order", () => {
    const layer1: PartialAgentLoopConfig = { llm: { provider: "a", temperature: 0.5 } } as PartialAgentLoopConfig;
    const layer2: PartialAgentLoopConfig = { llm: { provider: "b" } } as PartialAgentLoopConfig;
    const layer3: PartialAgentLoopConfig = { tools: { timeoutMs: 999 } } as PartialAgentLoopConfig;
    const result = mergeConfigs(layer1, layer2, layer3);
    expect((result.llm as { provider: string }).provider).toBe("b");
    expect((result.llm as { temperature: number }).temperature).toBe(0.5);
    expect((result.tools as { timeoutMs: number }).timeoutMs).toBe(999);
  });

  it("merges models by id across layers", () => {
    const layer1: PartialAgentLoopConfig = {
      models: [
        { id: "default", provider: "mistral", model: "small", temperature: 0.2 },
      ],
    };
    const layer2: PartialAgentLoopConfig = {
      models: [
        { id: "default", provider: "mistral", model: "medium" },
        { id: "strong", provider: "mistral", model: "large" },
      ],
    };
    const result = mergeConfigs(layer1, layer2);
    expect(result.models).toHaveLength(2);
    expect(result.models![0].model).toBe("medium");
    expect(result.models![0].temperature).toBe(0.2); // preserved
    expect(result.models![1].id).toBe("strong");
  });
});

// ---------------------------------------------------------------------------
// Config loading
// ---------------------------------------------------------------------------

describe("loadConfig", () => {
  let savedEnv: Record<string, string | undefined>;

  beforeEach(() => {
    // Save env vars that could affect loading
    savedEnv = {};
    const envKeys = [
      "LLM_PROVIDER", "LLM_MODEL", "LLM_TEMPERATURE",
      "MAX_ITERATIONS", "MAX_TOKENS_BUDGET", "MAX_CONTEXT_TOKENS",
      "TOOL_TIMEOUT_MS", "TOOL_ALLOWLIST", "TOOL_BLOCKLIST",
      "EXECUTION_TIMEOUT_MS", "SANDBOX_MODE",
      "STREAMING_ENABLED", "TRACING_ENABLED",
      "WEB_SEARCH_PROVIDER", "DUCKDUCKGO_MAX_RESULTS",
    ];
    for (const k of envKeys) {
      savedEnv[k] = process.env[k];
      delete process.env[k];
    }
  });

  afterEach(() => {
    // Restore env vars
    for (const [k, v] of Object.entries(savedEnv)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  it("returns defaults when no config files exist", () => {
    const tmp = mkTmpDir();
    const config = loadConfig({
      userConfigPath: path.join(tmp, "no-user.json"),
      repoConfigPath: path.join(tmp, "no-repo.json"),
      skipEnv: true,
    });
    expect(config.llm.provider).toBe("mistral");
    expect(config.llm.temperature).toBe(0.7);
    expect(config.llm.maxIterations).toBe(20);
    expect(config.tools.timeoutMs).toBe(30000);
    expect(config.models).toEqual([]);
    expect(config.execution.sandboxMode).toBe("none");
  });

  it("loads user-only config and merges with defaults", () => {
    const tmp = mkTmpDir();
    const userPath = path.join(tmp, "user-config.json");
    writeConfig(userPath, {
      llm: { temperature: 0.3 },
      models: [
        { id: "default", provider: "mistral", model: "mistral-small-latest" },
      ],
    });

    const config = loadConfig({
      userConfigPath: userPath,
      repoConfigPath: path.join(tmp, "no-repo.json"),
      skipEnv: true,
    });

    expect(config.llm.temperature).toBe(0.3);
    expect(config.llm.provider).toBe("mistral"); // default preserved
    expect(config.models).toHaveLength(1);
    expect(config.models[0].id).toBe("default");
  });

  it("loads repo-only config and merges with defaults", () => {
    const tmp = mkTmpDir();
    const repoPath = path.join(tmp, "repo-config.json");
    writeConfig(repoPath, {
      tools: { blocklist: ["shell"] },
      llm: { activeModel: "strong" },
    });

    const config = loadConfig({
      userConfigPath: path.join(tmp, "no-user.json"),
      repoConfigPath: repoPath,
      skipEnv: true,
    });

    expect(config.tools.blocklist).toEqual(["shell"]);
    expect(config.llm.activeModel).toBe("strong");
    expect(config.llm.provider).toBe("mistral"); // default preserved
  });

  it("merges user + repo config (repo overrides user)", () => {
    const tmp = mkTmpDir();
    const userPath = path.join(tmp, "user.json");
    const repoPath = path.join(tmp, "repo.json");

    writeConfig(userPath, {
      llm: { activeModel: "default", temperature: 0.5 },
      models: [
        { id: "default", provider: "mistral", model: "mistral-small-latest", temperature: 0.2 },
      ],
      tools: { timeoutMs: 60000 },
    });

    writeConfig(repoPath, {
      llm: { activeModel: "strong" },
      models: [
        { id: "default", provider: "mistral", model: "mistral-medium-latest" },
        { id: "strong", provider: "mistral", model: "mistral-large-latest", temperature: 0.1 },
      ],
      tools: { blocklist: ["shell"] },
    });

    const config = loadConfig({
      userConfigPath: userPath,
      repoConfigPath: repoPath,
      skipEnv: true,
    });

    // Repo overrides user's activeModel
    expect(config.llm.activeModel).toBe("strong");
    // User's temperature preserved (repo didn't set it)
    expect(config.llm.temperature).toBe(0.5);
    // Models merged by id
    expect(config.models).toHaveLength(2);
    expect(config.models[0].id).toBe("default");
    expect(config.models[0].model).toBe("mistral-medium-latest"); // repo override
    expect(config.models[0].temperature).toBe(0.2); // user preserved
    expect(config.models[1].id).toBe("strong"); // new from repo
    // Tools: timeout from user, blocklist from repo
    expect(config.tools.timeoutMs).toBe(60000);
    expect(config.tools.blocklist).toEqual(["shell"]);
  });

  it("env vars override JSON config", () => {
    const tmp = mkTmpDir();
    const userPath = path.join(tmp, "user.json");
    writeConfig(userPath, {
      llm: { provider: "openai", temperature: 0.3 },
    });

    process.env.LLM_PROVIDER = "mistral";
    process.env.LLM_TEMPERATURE = "0.9";

    const config = loadConfig({
      userConfigPath: userPath,
      repoConfigPath: path.join(tmp, "no-repo.json"),
    });

    expect(config.llm.provider).toBe("mistral"); // env wins
    expect(config.llm.temperature).toBe(0.9); // env wins
  });

  it("invalid JSON throws ConfigLoadError with file path", () => {
    const tmp = mkTmpDir();
    const badPath = path.join(tmp, "bad.json");
    writeRaw(badPath, "{ not valid json }}}");

    expect(() =>
      loadConfig({
        userConfigPath: badPath,
        repoConfigPath: path.join(tmp, "no-repo.json"),
        skipEnv: true,
      }),
    ).toThrow(ConfigLoadError);

    try {
      loadConfig({
        userConfigPath: badPath,
        repoConfigPath: path.join(tmp, "no-repo.json"),
        skipEnv: true,
      });
    } catch (err) {
      expect(err).toBeInstanceOf(ConfigLoadError);
      expect((err as ConfigLoadError).filePath).toBe(badPath);
      expect((err as ConfigLoadError).message).toContain("Invalid JSON");
    }
  });

  it("invalid schema (non-object root) throws ConfigLoadError", () => {
    const tmp = mkTmpDir();
    const badPath = path.join(tmp, "array.json");
    writeRaw(badPath, "[]");

    expect(() =>
      loadConfig({
        userConfigPath: badPath,
        repoConfigPath: path.join(tmp, "no-repo.json"),
        skipEnv: true,
      }),
    ).toThrow(ConfigLoadError);
  });

  it("unknown top-level keys throw ConfigLoadError", () => {
    const tmp = mkTmpDir();
    const badPath = path.join(tmp, "unknown.json");
    writeConfig(badPath, { unknownSection: true });

    expect(() =>
      loadConfig({
        userConfigPath: badPath,
        repoConfigPath: path.join(tmp, "no-repo.json"),
        skipEnv: true,
      }),
    ).toThrow(ConfigLoadError);

    try {
      loadConfig({
        userConfigPath: badPath,
        repoConfigPath: path.join(tmp, "no-repo.json"),
        skipEnv: true,
      });
    } catch (err) {
      expect((err as ConfigLoadError).message).toContain("unknownSection");
    }
  });

  it("models without required id/provider/model throws ConfigLoadError", () => {
    const tmp = mkTmpDir();
    const badPath = path.join(tmp, "bad-model.json");
    writeConfig(badPath, {
      models: [{ provider: "mistral", model: "small" }], // missing id
    });

    expect(() =>
      loadConfig({
        userConfigPath: badPath,
        repoConfigPath: path.join(tmp, "no-repo.json"),
        skipEnv: true,
      }),
    ).toThrow(ConfigLoadError);
  });

  it("section as non-object throws ConfigLoadError", () => {
    const tmp = mkTmpDir();
    const badPath = path.join(tmp, "bad-section.json");
    writeConfig(badPath, { llm: "not an object" });

    expect(() =>
      loadConfig({
        userConfigPath: badPath,
        repoConfigPath: path.join(tmp, "no-repo.json"),
        skipEnv: true,
      }),
    ).toThrow(ConfigLoadError);
  });

  it("missing config files are silently skipped (not errors)", () => {
    const tmp = mkTmpDir();
    // Both paths don't exist — should not throw
    expect(() =>
      loadConfig({
        userConfigPath: path.join(tmp, "nonexistent-user.json"),
        repoConfigPath: path.join(tmp, "nonexistent-repo.json"),
        skipEnv: true,
      }),
    ).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// Backward compatibility: appConfig flat fields
// ---------------------------------------------------------------------------

describe("appConfig backward compatibility", () => {
  // We import appConfig to verify its shape matches the old flat format
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { appConfig } = require("../config");

  it("has all expected flat fields", () => {
    expect(typeof appConfig.mistralApiKey).toBe("string");
    expect(typeof appConfig.maxIterations).toBe("number");
    expect(typeof appConfig.llmProvider).toBe("string");
    expect(typeof appConfig.llmTemperature).toBe("number");
    expect(typeof appConfig.toolTimeoutMs).toBe("number");
    expect(Array.isArray(appConfig.toolAllowlist)).toBe(true);
    expect(Array.isArray(appConfig.toolBlocklist)).toBe(true);
    expect(typeof appConfig.executionTimeoutMs).toBe("number");
    expect(typeof appConfig.sandboxMode).toBe("string");
    expect(typeof appConfig.workspaceRoot).toBe("string");
    expect(typeof appConfig.streamingEnabled).toBe("boolean");
    expect(typeof appConfig.tracingEnabled).toBe("boolean");
    expect(typeof appConfig.webSearchProvider).toBe("string");
    expect(typeof appConfig.logger).toBe("object");
    expect(typeof appConfig.logger.level).toBe("string");
    expect(typeof appConfig.logger.enabled).toBe("boolean");
  });

  it("exports applyApiKeyOverride function", () => {
    const { applyApiKeyOverride } = require("../config");
    expect(typeof applyApiKeyOverride).toBe("function");
  });

  it("exports stripApiKeyArg function", () => {
    const { stripApiKeyArg } = require("../config");
    expect(typeof stripApiKeyArg).toBe("function");
  });

  it("exports setLoggerDestination function", () => {
    const { setLoggerDestination } = require("../config");
    expect(typeof setLoggerDestination).toBe("function");
  });

  it("exports resolvedConfig with structured shape", () => {
    const { resolvedConfig } = require("../config");
    expect(resolvedConfig).toBeDefined();
    expect(typeof resolvedConfig.llm).toBe("object");
    expect(typeof resolvedConfig.tools).toBe("object");
    expect(Array.isArray(resolvedConfig.models)).toBe(true);
    expect(typeof resolvedConfig.execution).toBe("object");
    expect(typeof resolvedConfig.observability).toBe("object");
  });
});

// ---------------------------------------------------------------------------
// CLI --api-key override integration
// ---------------------------------------------------------------------------

describe("CLI --api-key override", () => {
  it("stripApiKeyArg removes --api-key from args", () => {
    const { stripApiKeyArg } = require("../config");
    const args = ["--mode", "oneshot", "--api-key", "sk-test", "--json"];
    const cleaned = stripApiKeyArg(args);
    expect(cleaned).toEqual(["--mode", "oneshot", "--json"]);
  });

  it("applyApiKeyOverride updates appConfig and process.env", () => {
    const { applyApiKeyOverride, appConfig: cfg } = require("../config");
    const oldKey = cfg.mistralApiKey;
    const oldEnv = process.env.MISTRAL_API_KEY;

    applyApiKeyOverride("test-key-12345");
    expect(cfg.mistralApiKey).toBe("test-key-12345");
    expect(process.env.MISTRAL_API_KEY).toBe("test-key-12345");

    // Restore
    if (oldEnv !== undefined) process.env.MISTRAL_API_KEY = oldEnv;
    else delete process.env.MISTRAL_API_KEY;
    cfg.mistralApiKey = oldKey;
  });
});

// ---------------------------------------------------------------------------
// Config defaults
// ---------------------------------------------------------------------------

describe("CONFIG_DEFAULTS", () => {
  it("has all required top-level sections", () => {
    expect(CONFIG_DEFAULTS.llm).toBeDefined();
    expect(CONFIG_DEFAULTS.models).toBeDefined();
    expect(CONFIG_DEFAULTS.tools).toBeDefined();
    expect(CONFIG_DEFAULTS.execution).toBeDefined();
    expect(CONFIG_DEFAULTS.paths).toBeDefined();
    expect(CONFIG_DEFAULTS.prompts).toBeDefined();
    expect(CONFIG_DEFAULTS.search).toBeDefined();
    expect(CONFIG_DEFAULTS.observability).toBeDefined();
    expect(CONFIG_DEFAULTS.security).toBeDefined();
    expect(CONFIG_DEFAULTS.webFetch).toBeDefined();
  });

  it("default provider is mistral", () => {
    expect(CONFIG_DEFAULTS.llm.provider).toBe("mistral");
  });

  it("default temperature is 0.7", () => {
    expect(CONFIG_DEFAULTS.llm.temperature).toBe(0.7);
  });

  it("default models array is empty", () => {
    expect(CONFIG_DEFAULTS.models).toEqual([]);
  });
});
