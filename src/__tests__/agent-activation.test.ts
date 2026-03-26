jest.mock("../logger", () => ({
  logger: { info: jest.fn(), warn: jest.fn(), debug: jest.fn(), error: jest.fn() },
}));

jest.mock("../skills/registry", () => ({
  skillRegistry: {
    isActive: jest.fn(),
    get: jest.fn(),
    activate: jest.fn(),
  },
}));

jest.mock("../tools/registry", () => ({
  toolRegistry: {
    list: jest.fn(),
  },
}));

import { activateProfile } from "../agents/activator";
import type { AgentProfile } from "../agents/types";
import { skillRegistry } from "../skills/registry";
import { toolRegistry } from "../tools/registry";
import { logger } from "../logger";

const DEFAULT_TOOLS = [
  { name: "calculate", description: "Calculator" },
  { name: "file-read", description: "File reader" },
  { name: "shell", description: "Shell executor" },
];

const baseProfile: AgentProfile = {
  name: "base",
  description: "base profile",
  version: "1.0.0",
  model: "gpt-3.5-turbo",
  temperature: 0.5,
  skills: ["test-skill"],
  tools: ["calculate"],
};

const childProfile: AgentProfile = {
  name: "child",
  description: "child profile",
  version: "1.0.0",
  model: "gpt-4o",
  skills: ["extra-skill"],
  tools: ["file-read"],
  constraints: { blockedTools: ["shell"] },
};

beforeEach(() => {
  jest.clearAllMocks();
  (toolRegistry.list as jest.Mock).mockReturnValue(DEFAULT_TOOLS);
  (skillRegistry.isActive as jest.Mock).mockReturnValue(false);
  (skillRegistry.get as jest.Mock).mockReturnValue(undefined);
});

// 1. Returns correct model and temperature
test("activateProfile() returns model and temperature from the profile", () => {
  const result = activateProfile({
    name: "test",
    description: "",
    version: "1.0.0",
    model: "gpt-4o",
    temperature: 0.3,
  });
  expect(result.model).toBe("gpt-4o");
  expect(result.temperature).toBe(0.3);
});

// 2. Returns maxIterations when set
test("activateProfile() returns maxIterations when set on the profile", () => {
  const result = activateProfile({
    name: "test",
    description: "",
    version: "1.0.0",
    maxIterations: 10,
  });
  expect(result.maxIterations).toBe(10);
});

// 3. No tools list → activeTools is empty array (means all tools)
test("activateProfile() produces an empty activeTools when profile has no tools list", () => {
  const result = activateProfile({ name: "test", description: "", version: "1.0.0" });
  expect(result.activeTools).toEqual([]);
});

// 4. Tools list → activeTools matches
test("activateProfile() produces activeTools matching the profile tools list", () => {
  const result = activateProfile({
    name: "test",
    description: "",
    version: "1.0.0",
    tools: ["calculate", "file-read"],
  });
  expect(result.activeTools).toEqual(["calculate", "file-read"]);
});

// 5. Blocked tools removed from activeTools when tools list is provided
test("activateProfile() removes blocked tools from activeTools", () => {
  const result = activateProfile({
    name: "test",
    description: "",
    version: "1.0.0",
    tools: ["calculate", "shell"],
    constraints: { blockedTools: ["shell"] },
  });
  expect(result.activeTools).toEqual(["calculate"]);
  expect(result.activeTools).not.toContain("shell");
});

// 6. constraints.blockedTools with no tools list → filtered from toolRegistry.list()
test("activateProfile() filters blocked tools from toolRegistry.list() when no tools list is specified", () => {
  const result = activateProfile({
    name: "test",
    description: "",
    version: "1.0.0",
    constraints: { blockedTools: ["shell"] },
  });
  expect(toolRegistry.list).toHaveBeenCalled();
  expect(result.activeTools).toContain("calculate");
  expect(result.activeTools).toContain("file-read");
  expect(result.activeTools).not.toContain("shell");
});

// 7. Activates skills via skillRegistry.activate()
test("activateProfile() activates skills via skillRegistry.activate()", () => {
  (skillRegistry.isActive as jest.Mock).mockReturnValue(false);
  (skillRegistry.get as jest.Mock).mockReturnValue({ name: "test-skill" });

  activateProfile({
    name: "test",
    description: "",
    version: "1.0.0",
    skills: ["test-skill"],
  });

  expect(skillRegistry.activate).toHaveBeenCalledWith("test-skill");
});

// 8. Skips activation for already-active skills
test("activateProfile() skips activation for already-active skills", () => {
  (skillRegistry.isActive as jest.Mock).mockReturnValue(true);

  activateProfile({
    name: "test",
    description: "",
    version: "1.0.0",
    skills: ["test-skill"],
  });

  expect(skillRegistry.activate).not.toHaveBeenCalled();
});

// 9. Logs warning for unknown skill in profile
test("activateProfile() logs a warning for unknown skills in the profile", () => {
  (skillRegistry.isActive as jest.Mock).mockReturnValue(false);
  (skillRegistry.get as jest.Mock).mockReturnValue(undefined);

  activateProfile({
    name: "test",
    description: "",
    version: "1.0.0",
    skills: ["unknown-skill"],
  });

  expect(logger.warn).toHaveBeenCalled();
  expect(skillRegistry.activate).not.toHaveBeenCalled();
});

// 10. Profile stacking: skills is union of both
test("activateProfile(child, base) produces a union of skills", () => {
  (skillRegistry.get as jest.Mock).mockReturnValue({ name: "skill" });

  const result = activateProfile(childProfile, baseProfile);

  expect(result.activeSkills).toContain("test-skill");
  expect(result.activeSkills).toContain("extra-skill");
});

// 11. Profile stacking: child model wins
test("activateProfile(child, base) uses the child profile model", () => {
  (skillRegistry.get as jest.Mock).mockReturnValue({ name: "skill" });

  const result = activateProfile(childProfile, baseProfile);

  expect(result.model).toBe("gpt-4o");
});

// 12. Profile stacking: blocked tools merged from both profiles
test("activateProfile(child, base) merges blockedTools from both profiles", () => {
  const blockedBase: AgentProfile = {
    name: "blocked-base",
    description: "",
    version: "1.0.0",
    constraints: { blockedTools: ["file-delete"] },
  };
  const blockedChild: AgentProfile = {
    name: "blocked-child",
    description: "",
    version: "1.0.0",
    constraints: { blockedTools: ["shell"] },
  };

  const result = activateProfile(blockedChild, blockedBase);

  expect(result.constraints.blockedTools).toContain("file-delete");
  expect(result.constraints.blockedTools).toContain("shell");
});
