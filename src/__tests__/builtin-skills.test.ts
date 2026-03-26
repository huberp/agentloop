import * as path from "path";
import { SkillRegistry } from "../skills/registry";

jest.mock("../logger", () => ({
  logger: { info: jest.fn(), warn: jest.fn(), debug: jest.fn(), error: jest.fn() },
}));

describe("built-in skill library", () => {
  let registry: SkillRegistry;

  beforeEach(async () => {
    registry = new SkillRegistry();
    const builtinDir = path.join(__dirname, "../skills/builtin");
    await registry.loadFromDirectory(builtinDir);
  });

  const BUILTIN_NAMES = [
    "typescript-expert",
    "code-reviewer",
    "test-writer",
    "git-workflow",
    "security-auditor",
  ];

  it("loads all 5 built-in skills", () => {
    const names = registry.list().map((s) => s.name);
    for (const name of BUILTIN_NAMES) {
      expect(names).toContain(name);
    }
  });

  for (const name of BUILTIN_NAMES) {
    it(`${name} has a non-empty promptFragment with at least 3 actionable points`, () => {
      const skill = registry.list().find((s) => s.name === name)!;
      expect(skill).toBeDefined();
      expect(skill.promptFragment.trim().length).toBeGreaterThan(0);
      const bulletCount = (skill.promptFragment.match(/^[\s]*[-*•]/gm) ?? []).length;
      expect(bulletCount).toBeGreaterThanOrEqual(3);
    });
  }

  it("security-auditor skill declares tools: ['shell']", () => {
    const skill = registry.list().find((s) => s.name === "security-auditor")!;
    expect(skill.tools).toContain("shell");
  });

  it("each skill has a valid slot value", () => {
    const validSlots = ["prepend", "append", "section"];
    for (const skill of registry.list()) {
      expect(validSlots).toContain(skill.slot);
    }
  });

  it("each skill has a non-empty description", () => {
    for (const skill of registry.list()) {
      expect(skill.description.trim().length).toBeGreaterThan(0);
    }
  });
});
