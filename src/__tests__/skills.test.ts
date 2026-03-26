import * as os from "os";
import * as fs from "fs/promises";
import * as path from "path";

jest.mock("../logger", () => ({
  logger: { info: jest.fn(), warn: jest.fn(), debug: jest.fn(), error: jest.fn() },
}));

import { SkillRegistry } from "../skills/registry";
import { logger } from "../logger";

const makeSkill = (name: string) => ({
  name,
  description: "Test skill",
  version: "1.0.0",
  promptFragment: "Some prompt",
  slot: "append" as const,
});

describe("SkillRegistry", () => {
  let registry: SkillRegistry;

  beforeEach(() => {
    registry = new SkillRegistry();
    jest.clearAllMocks();
  });

  // 1. register() + get()
  test("register() registers a skill and get() returns it", () => {
    const skill = makeSkill("typescript-expert");
    registry.register(skill);
    expect(registry.get("typescript-expert")).toBe(skill);
  });

  // 2. duplicate name logs warning and skips
  test("register() duplicate name logs warning and does not overwrite", () => {
    const skill1 = makeSkill("typescript-expert");
    const skill2 = { ...makeSkill("typescript-expert"), description: "Updated" };
    registry.register(skill1);
    registry.register(skill2);
    expect(logger.warn).toHaveBeenCalledTimes(1);
    // original skill still stored, not overwritten
    expect(registry.get("typescript-expert")).toBe(skill1);
  });

  // 3. activate() returns true; isActive() returns true
  test("activate() returns true for known skill; isActive() confirms", () => {
    registry.register(makeSkill("typescript-expert"));
    expect(registry.activate("typescript-expert")).toBe(true);
    expect(registry.isActive("typescript-expert")).toBe(true);
  });

  // 4. activate() returns false for unknown skill
  test("activate() returns false for unknown skill", () => {
    expect(registry.activate("no-such-skill")).toBe(false);
  });

  // 5. activate() is idempotent
  test("activate() is idempotent — activating again returns true without duplicating", () => {
    registry.register(makeSkill("typescript-expert"));
    expect(registry.activate("typescript-expert")).toBe(true);
    expect(registry.activate("typescript-expert")).toBe(true);
    expect(registry.listActive()).toHaveLength(1);
  });

  // 6. deactivate() returns true; isActive() returns false
  test("deactivate() returns true for active skill; isActive() returns false", () => {
    registry.register(makeSkill("typescript-expert"));
    registry.activate("typescript-expert");
    expect(registry.deactivate("typescript-expert")).toBe(true);
    expect(registry.isActive("typescript-expert")).toBe(false);
  });

  // 7. deactivate() returns false for unknown skill
  test("deactivate() returns false for unknown skill", () => {
    expect(registry.deactivate("no-such-skill")).toBe(false);
  });

  // 8. listActive()
  test("listActive() returns only active skills", () => {
    registry.register(makeSkill("a"));
    registry.register(makeSkill("b"));
    registry.activate("a");
    const active = registry.listActive();
    expect(active).toHaveLength(1);
    expect(active[0].name).toBe("a");
  });

  // 9. list()
  test("list() returns all registered skills", () => {
    registry.register(makeSkill("a"));
    registry.register(makeSkill("b"));
    expect(registry.list()).toHaveLength(2);
  });

  // 10. loadFromDirectory() — loads a .skill.md file with frontmatter
  test("loadFromDirectory() loads a skill.md file with frontmatter", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "skills-test-"));
    try {
      const content = [
        "---",
        "name: typescript-expert",
        "description: TypeScript expertise",
        "version: 2.0.0",
        "slot: prepend",
        "tools: file-read, shell",
        "---",
        "You are a TypeScript expert.",
      ].join("\n");
      await fs.writeFile(path.join(dir, "typescript-expert.skill.md"), content, "utf-8");

      await registry.loadFromDirectory(dir);

      const skill = registry.get("typescript-expert");
      expect(skill).toBeDefined();
      expect(skill!.description).toBe("TypeScript expertise");
      expect(skill!.version).toBe("2.0.0");
      expect(skill!.slot).toBe("prepend");
      expect(skill!.tools).toEqual(["file-read", "shell"]);
      expect(skill!.promptFragment).toContain("TypeScript expert");
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  // 11. loadFromDirectory() — non-existent directory silently ignored
  test("loadFromDirectory() silently ignores a non-existent directory", async () => {
    await expect(
      registry.loadFromDirectory(path.join(os.tmpdir(), "no-such-skills-dir-xyz-agentloop"))
    ).resolves.toBeUndefined();
  });

  // 12. loadFromDirectory() — duplicate name logs warning and skips
  test("loadFromDirectory() duplicate name from directory logs warning and skips", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "skills-test-dup-"));
    try {
      const content = [
        "---",
        "name: typescript-expert",
        "description: From file",
        "---",
        "File body",
      ].join("\n");
      await fs.writeFile(path.join(dir, "typescript-expert.skill.md"), content, "utf-8");

      // Pre-register with same name
      registry.register(makeSkill("typescript-expert"));
      jest.clearAllMocks();

      await registry.loadFromDirectory(dir);

      expect(logger.warn).toHaveBeenCalledTimes(1);
      // Original skill description is preserved (not overwritten)
      expect(registry.get("typescript-expert")!.description).toBe("Test skill");
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});
