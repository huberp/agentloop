import { z } from "zod";
import { ToolPermissionManager, ConfirmationHandler } from "../security";
import { ToolBlockedError } from "../errors";
import type { ToolDefinition } from "../tools/registry";

// ---------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------

/** Build a minimal ToolDefinition for testing. */
function makeDef(
  name: string,
  permissions: ToolDefinition["permissions"] = "safe"
): ToolDefinition {
  return {
    name,
    description: `${name} tool`,
    schema: z.object({ input: z.string() }),
    execute: async () => "result",
    permissions,
  };
}

/** Mock ConfirmationHandler whose response can be controlled per test. */
const mockConfirm = jest.fn<Promise<boolean>, [string, unknown]>();
const mockHandler: ConfirmationHandler = { confirm: mockConfirm };

const baseConfig = { autoApproveAll: false, toolAllowlist: [], toolBlocklist: [] };

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("ToolPermissionManager — permission levels", () => {
  beforeEach(() => mockConfirm.mockReset());

  it("(a) safe tool is auto-approved without calling the confirmation handler", async () => {
    const manager = new ToolPermissionManager(baseConfig, mockHandler);
    await expect(manager.checkPermission(makeDef("search", "safe"))).resolves.toBeUndefined();
    expect(mockConfirm).not.toHaveBeenCalled();
  });

  it("(a) cautious tool is auto-approved without a confirmation prompt (only logged)", async () => {
    const manager = new ToolPermissionManager(baseConfig, mockHandler);
    await expect(manager.checkPermission(makeDef("shell", "cautious"))).resolves.toBeUndefined();
    expect(mockConfirm).not.toHaveBeenCalled();
  });

  it("(b) dangerous tool is blocked when the confirmation handler returns false", async () => {
    mockConfirm.mockResolvedValue(false);
    const manager = new ToolPermissionManager(baseConfig, mockHandler);
    await expect(manager.checkPermission(makeDef("delete", "dangerous"))).rejects.toThrow(
      ToolBlockedError
    );
    expect(mockConfirm).toHaveBeenCalledTimes(1);
    expect(mockConfirm).toHaveBeenCalledWith("delete", undefined);
  });

  it("(b) dangerous tool is allowed when the confirmation handler returns true", async () => {
    mockConfirm.mockResolvedValue(true);
    const manager = new ToolPermissionManager(baseConfig, mockHandler);
    await expect(manager.checkPermission(makeDef("delete", "dangerous"))).resolves.toBeUndefined();
    expect(mockConfirm).toHaveBeenCalledTimes(1);
  });

  it("dangerous tool passes args to the confirmation handler", async () => {
    mockConfirm.mockResolvedValue(true);
    const manager = new ToolPermissionManager(baseConfig, mockHandler);
    const args = { path: "/tmp/file.txt" };
    await manager.checkPermission(makeDef("delete", "dangerous"), args);
    expect(mockConfirm).toHaveBeenCalledWith("delete", args);
  });

  it("tool with undefined permissions defaults to safe and is auto-approved", async () => {
    const def = makeDef("no-perm");
    delete def.permissions; // ensure field is absent
    const manager = new ToolPermissionManager(baseConfig, mockHandler);
    await expect(manager.checkPermission(def)).resolves.toBeUndefined();
    expect(mockConfirm).not.toHaveBeenCalled();
  });
});

describe("ToolPermissionManager — blocklist", () => {
  beforeEach(() => mockConfirm.mockReset());

  it("(c) blocklisted tool is rejected with ToolBlockedError", async () => {
    const config = { ...baseConfig, toolBlocklist: ["bad-tool"] };
    const manager = new ToolPermissionManager(config, mockHandler);
    await expect(manager.checkPermission(makeDef("bad-tool", "safe"))).rejects.toThrow(
      ToolBlockedError
    );
    expect(mockConfirm).not.toHaveBeenCalled();
  });

  it("(c) ToolBlockedError message contains the tool name", async () => {
    const config = { ...baseConfig, toolBlocklist: ["bad-tool"] };
    const manager = new ToolPermissionManager(config, mockHandler);
    await expect(manager.checkPermission(makeDef("bad-tool"))).rejects.toThrow(/bad-tool/);
  });

  it("blocklist takes precedence over AUTO_APPROVE_ALL", async () => {
    const config = { autoApproveAll: true, toolAllowlist: [], toolBlocklist: ["blocked"] };
    const manager = new ToolPermissionManager(config, mockHandler);
    await expect(manager.checkPermission(makeDef("blocked", "safe"))).rejects.toThrow(
      ToolBlockedError
    );
  });

  it("non-blocklisted tool is not affected", async () => {
    const config = { ...baseConfig, toolBlocklist: ["bad-tool"] };
    const manager = new ToolPermissionManager(config, mockHandler);
    await expect(manager.checkPermission(makeDef("search", "safe"))).resolves.toBeUndefined();
  });
});

describe("ToolPermissionManager — allowlist", () => {
  beforeEach(() => mockConfirm.mockReset());

  it("tool not in allowlist is rejected with ToolBlockedError", async () => {
    const config = { ...baseConfig, toolAllowlist: ["search"] };
    const manager = new ToolPermissionManager(config, mockHandler);
    await expect(manager.checkPermission(makeDef("calculate", "safe"))).rejects.toThrow(
      ToolBlockedError
    );
    expect(mockConfirm).not.toHaveBeenCalled();
  });

  it("tool in allowlist is permitted", async () => {
    const config = { ...baseConfig, toolAllowlist: ["search"] };
    const manager = new ToolPermissionManager(config, mockHandler);
    await expect(manager.checkPermission(makeDef("search", "safe"))).resolves.toBeUndefined();
  });

  it("empty allowlist imposes no restriction", async () => {
    const manager = new ToolPermissionManager(baseConfig, mockHandler);
    await expect(manager.checkPermission(makeDef("any-tool", "safe"))).resolves.toBeUndefined();
  });
});

describe("ToolPermissionManager — AUTO_APPROVE_ALL", () => {
  beforeEach(() => mockConfirm.mockReset());

  it("(d) AUTO_APPROVE_ALL bypasses confirmation for dangerous tools", async () => {
    const config = { ...baseConfig, autoApproveAll: true };
    const manager = new ToolPermissionManager(config, mockHandler);
    await expect(manager.checkPermission(makeDef("delete", "dangerous"))).resolves.toBeUndefined();
    expect(mockConfirm).not.toHaveBeenCalled();
  });

  it("(d) AUTO_APPROVE_ALL also bypasses confirmation for cautious tools (already auto-approved)", async () => {
    const config = { ...baseConfig, autoApproveAll: true };
    const manager = new ToolPermissionManager(config, mockHandler);
    await expect(
      manager.checkPermission(makeDef("shell", "cautious"))
    ).resolves.toBeUndefined();
    expect(mockConfirm).not.toHaveBeenCalled();
  });
});
