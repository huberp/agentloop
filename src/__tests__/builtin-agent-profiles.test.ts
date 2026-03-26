import * as path from "path";
import { AgentProfileRegistry } from "../agents/registry";

jest.mock("../logger", () => ({
  logger: { info: jest.fn(), warn: jest.fn(), debug: jest.fn(), error: jest.fn() },
}));
jest.mock("../tools/registry", () => ({
  toolRegistry: { get: jest.fn().mockReturnValue(undefined), list: jest.fn().mockReturnValue([]) },
}));
jest.mock("../skills/registry", () => ({
  skillRegistry: {
    get: jest.fn().mockReturnValue(undefined),
    isActive: jest.fn().mockReturnValue(false),
    activate: jest.fn(),
  },
}));

let registry: AgentProfileRegistry;

beforeAll(async () => {
  registry = new AgentProfileRegistry();
  const builtinDir = path.join(__dirname, "../agents/builtin");
  await registry.loadFromDirectory(builtinDir);
});

describe("builtin agent profiles", () => {
  it("loads exactly 5 builtin profiles", () => {
    expect(registry.list()).toHaveLength(5);
  });

  it("coder profile has name === 'coder' and model === 'gpt-4o'", () => {
    const profile = registry.get("coder");
    expect(profile).toBeDefined();
    expect(profile!.name).toBe("coder");
    expect(profile!.model).toBe("gpt-4o");
  });

  it("coder profile has temperature === 0.2", () => {
    const profile = registry.get("coder");
    expect(profile!.temperature).toBe(0.2);
  });

  it("reviewer profile has skills including 'code-reviewer'", () => {
    const profile = registry.get("reviewer");
    expect(profile).toBeDefined();
    expect(profile!.skills).toContain("code-reviewer");
  });

  it("planner profile has maxIterations === 10", () => {
    const profile = registry.get("planner");
    expect(profile).toBeDefined();
    expect(profile!.maxIterations).toBe(10);
  });

  it("security-auditor profile has temperature === 0.1", () => {
    const profile = registry.get("security-auditor");
    expect(profile).toBeDefined();
    expect(profile!.temperature).toBe(0.1);
  });

  it("security-auditor constraints include 'shell' in requireConfirmation", () => {
    const profile = registry.get("security-auditor");
    expect(profile!.constraints?.requireConfirmation).toContain("shell");
  });

  it("devops profile tools includes 'git-commit'", () => {
    const profile = registry.get("devops");
    expect(profile).toBeDefined();
    expect(profile!.tools).toContain("git-commit");
  });

  it("all profiles have valid semver version field", () => {
    for (const profile of registry.list()) {
      expect(/^\d+\.\d+\.\d+$/.test(profile.version)).toBe(true);
    }
  });

  it("registry.get('coder') returns the coder profile", () => {
    const profile = registry.get("coder");
    expect(profile).toBeDefined();
    expect(profile!.name).toBe("coder");
  });

  it("registry.get('nonexistent') returns undefined", () => {
    expect(registry.get("nonexistent")).toBeUndefined();
  });
});
