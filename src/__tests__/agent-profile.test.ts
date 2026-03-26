import * as os from "os";
import * as fs from "fs/promises";
import * as path from "path";

jest.mock("../logger", () => ({
  logger: { info: jest.fn(), warn: jest.fn(), debug: jest.fn(), error: jest.fn() },
}));
jest.mock("../tools/registry", () => ({
  toolRegistry: {
    get: jest.fn().mockReturnValue(undefined),
    list: jest.fn().mockReturnValue([]),
  },
}));
jest.mock("../skills/registry", () => ({
  skillRegistry: {
    get: jest.fn().mockReturnValue(undefined),
    list: jest.fn().mockReturnValue([]),
  },
}));

import { loadAgentProfile } from "../agents/loader";
import { AgentProfileRegistry } from "../agents/registry";
import { AgentProfileError } from "../agents/types";
import { logger } from "../logger";
import { toolRegistry } from "../tools/registry";
import { skillRegistry } from "../skills/registry";

const VALID_JSON_CONTENT = JSON.stringify({
  name: "test-agent",
  description: "A test agent",
  version: "1.0.0",
  model: "mistral-large",
  tools: [],
  skills: [],
});

const VALID_YAML_CONTENT = `
name: yaml-agent
description: A YAML agent
version: 2.1.0
model: mistral-medium
constraints:
  blockedTools:
    - shell
  maxFileSizeBytes: 1048576
`.trim();

async function writeTempFile(
  dir: string,
  filename: string,
  content: string
): Promise<string> {
  const filePath = path.join(dir, filename);
  await fs.writeFile(filePath, content, "utf-8");
  return filePath;
}

describe("loadAgentProfile()", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "agent-profile-test-"));
    jest.clearAllMocks();
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  // 1. Valid .agent.json
  test("loads a valid .agent.json file with all required fields", async () => {
    const filePath = await writeTempFile(
      tmpDir,
      "my.agent.json",
      VALID_JSON_CONTENT
    );
    const profile = await loadAgentProfile(filePath);
    expect(profile.name).toBe("test-agent");
    expect(profile.description).toBe("A test agent");
    expect(profile.version).toBe("1.0.0");
    expect(profile.model).toBe("mistral-large");
  });

  // 2. Valid .agent.yaml with nested constraints
  test("loads a valid .agent.yaml file with nested constraints", async () => {
    const filePath = await writeTempFile(
      tmpDir,
      "my.agent.yaml",
      VALID_YAML_CONTENT
    );
    const profile = await loadAgentProfile(filePath);
    expect(profile.name).toBe("yaml-agent");
    expect(profile.version).toBe("2.1.0");
    expect(profile.constraints?.blockedTools).toEqual(["shell"]);
    expect(profile.constraints?.maxFileSizeBytes).toBe(1048576);
  });

  // 3. Missing required field throws AgentProfileError
  test("throws AgentProfileError when 'name' field is missing", async () => {
    const content = JSON.stringify({
      description: "No name",
      version: "1.0.0",
    });
    const filePath = await writeTempFile(tmpDir, "bad.agent.json", content);
    await expect(loadAgentProfile(filePath)).rejects.toThrow(AgentProfileError);
    await expect(loadAgentProfile(filePath)).rejects.toThrow(/"name"/);
  });

  // 4. Invalid semver throws AgentProfileError
  test("throws AgentProfileError for invalid semver version", async () => {
    const content = JSON.stringify({
      name: "my-agent",
      description: "Bad version",
      version: "1.0",
    });
    const filePath = await writeTempFile(tmpDir, "badver.agent.json", content);
    await expect(loadAgentProfile(filePath)).rejects.toThrow(AgentProfileError);
    await expect(loadAgentProfile(filePath)).rejects.toThrow(/Invalid semver/);
  });

  // 5. Malformed JSON throws AgentProfileError
  test("throws AgentProfileError for malformed JSON", async () => {
    const filePath = await writeTempFile(
      tmpDir,
      "broken.agent.json",
      "{ not valid json }"
    );
    await expect(loadAgentProfile(filePath)).rejects.toThrow(AgentProfileError);
    await expect(loadAgentProfile(filePath)).rejects.toThrow(/Invalid JSON/);
  });

  // 6. Unresolvable tool reference logs warning (does not throw)
  test("logs a warning for unresolvable tool reference and does not throw", async () => {
    const content = JSON.stringify({
      name: "tool-agent",
      description: "Has tools",
      version: "1.0.0",
      tools: ["nonexistent-tool"],
    });
    const filePath = await writeTempFile(tmpDir, "tool.agent.json", content);
    (toolRegistry.get as jest.Mock).mockReturnValue(undefined);
    const profile = await loadAgentProfile(filePath);
    expect(profile.name).toBe("tool-agent");
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ toolName: "nonexistent-tool" }),
      expect.stringContaining("unregistered tool")
    );
  });

  // 7. Unresolvable skill reference logs warning (does not throw)
  test("logs a warning for unresolvable skill reference and does not throw", async () => {
    const content = JSON.stringify({
      name: "skill-agent",
      description: "Has skills",
      version: "1.0.0",
      skills: ["nonexistent-skill"],
    });
    const filePath = await writeTempFile(tmpDir, "skill.agent.json", content);
    (skillRegistry.get as jest.Mock).mockReturnValue(undefined);
    const profile = await loadAgentProfile(filePath);
    expect(profile.name).toBe("skill-agent");
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ skillName: "nonexistent-skill" }),
      expect.stringContaining("unregistered skill")
    );
  });
});

describe("AgentProfileRegistry", () => {
  let registry: AgentProfileRegistry;
  let tmpDir: string;

  beforeEach(async () => {
    registry = new AgentProfileRegistry();
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "agent-registry-test-"));
    jest.clearAllMocks();
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  const makeProfile = (name: string) => ({
    name,
    description: "Test profile",
    version: "1.0.0",
  });

  // 8. register() + get()
  test("register() stores profile and get() returns it", () => {
    const profile = makeProfile("alpha");
    registry.register(profile);
    expect(registry.get("alpha")).toBe(profile);
  });

  // 9. Duplicate name logs warning and skips
  test("register() duplicate name logs warning and does not overwrite", () => {
    const p1 = makeProfile("alpha");
    const p2 = { ...makeProfile("alpha"), description: "Updated" };
    registry.register(p1);
    registry.register(p2);
    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(registry.get("alpha")).toBe(p1);
  });

  // 10. list() returns all registered profiles
  test("list() returns all registered profiles", () => {
    registry.register(makeProfile("alpha"));
    registry.register(makeProfile("beta"));
    expect(registry.list()).toHaveLength(2);
    expect(registry.list().map((p) => p.name)).toContain("alpha");
    expect(registry.list().map((p) => p.name)).toContain("beta");
  });

  // 11. loadFromDirectory() loads .agent.json files
  test("loadFromDirectory() loads .agent.json files from a directory", async () => {
    await writeTempFile(tmpDir, "my.agent.json", VALID_JSON_CONTENT);
    await registry.loadFromDirectory(tmpDir);
    expect(registry.get("test-agent")).toBeDefined();
    expect(registry.get("test-agent")?.version).toBe("1.0.0");
  });

  // 12. loadFromDirectory() ignores non-agent files
  test("loadFromDirectory() ignores files without .agent. in the name", async () => {
    await writeTempFile(
      tmpDir,
      "config.json",
      JSON.stringify({ name: "config", description: "not an agent", version: "1.0.0" })
    );
    await registry.loadFromDirectory(tmpDir);
    expect(registry.list()).toHaveLength(0);
  });

  // 13. loadFromDirectory() silently handles non-existent directory
  test("loadFromDirectory() silently handles non-existent directory", async () => {
    const nonexistent = path.join(tmpDir, "does-not-exist");
    await expect(registry.loadFromDirectory(nonexistent)).resolves.toBeUndefined();
    expect(registry.list()).toHaveLength(0);
  });
});
