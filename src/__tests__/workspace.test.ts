import * as path from "path";
import { analyzeWorkspace, WorkspaceInfo } from "../workspace";

// Base path to all workspace fixture directories
const fixturesDir = path.join(__dirname, "fixtures");

describe("analyzeWorkspace — Node/TypeScript project", () => {
  const root = path.join(fixturesDir, "workspace-node");

  let info: WorkspaceInfo;
  beforeAll(async () => {
    info = await analyzeWorkspace(root);
  });

  it("detects language as 'node'", () => {
    expect(info.language).toBe("node");
  });

  it("detects the 'express' framework from dependencies", () => {
    expect(info.framework).toBe("express");
  });

  it("uses 'npm' as the package manager (no lock file present)", () => {
    expect(info.packageManager).toBe("npm");
  });

  it("extracts the test command from package.json scripts", () => {
    expect(info.testCommand).toBe("npm test");
  });

  it("extracts the lint command from package.json scripts", () => {
    expect(info.lintCommand).toBe("npm run lint");
  });

  it("extracts the build command from package.json scripts", () => {
    expect(info.buildCommand).toBe("npm run build");
  });

  it("reports hasTests as true when a test script is present", () => {
    expect(info.hasTests).toBe(true);
  });

  it("includes the main entry point from package.json", () => {
    expect(info.entryPoints).toContain("src/index.ts");
  });

  it("reports gitInitialized as false (no .git in fixture)", () => {
    expect(info.gitInitialized).toBe(false);
  });
});

describe("analyzeWorkspace — Python project", () => {
  const root = path.join(fixturesDir, "workspace-python");

  let info: WorkspaceInfo;
  beforeAll(async () => {
    info = await analyzeWorkspace(root);
  });

  it("detects language as 'python'", () => {
    expect(info.language).toBe("python");
  });

  it("detects 'django' framework from pyproject.toml", () => {
    expect(info.framework).toBe("django");
  });

  it("uses 'poetry' as the package manager (pyproject.toml contains [tool.poetry])", () => {
    expect(info.packageManager).toBe("poetry");
  });

  it("defaults the test command to 'pytest'", () => {
    expect(info.testCommand).toBe("pytest");
  });
});

describe("analyzeWorkspace — Go project", () => {
  const root = path.join(fixturesDir, "workspace-go");

  let info: WorkspaceInfo;
  beforeAll(async () => {
    info = await analyzeWorkspace(root);
  });

  it("detects language as 'go'", () => {
    expect(info.language).toBe("go");
  });

  it("uses 'go mod' as the package manager", () => {
    expect(info.packageManager).toBe("go mod");
  });

  it("defaults the test command to 'go test ./...'", () => {
    expect(info.testCommand).toBe("go test ./...");
  });

  it("defaults the build command to 'go build ./...'", () => {
    expect(info.buildCommand).toBe("go build ./...");
  });
});

describe("analyzeWorkspace — unknown project", () => {
  // Use a directory with no recognised indicator files (e.g. the go fixture
  // but reference a tmp path that contains nothing).
  it("returns language 'unknown' for a directory with no indicator files", async () => {
    // The fixtures root itself has no package.json / go.mod / pyproject.toml
    const info = await analyzeWorkspace(fixturesDir);
    expect(info.language).toBe("unknown");
    expect(info.framework).toBe("none");
  });
});

describe("analyzeWorkspace — git detection", () => {
  it("reports gitInitialized true when a .git directory exists", async () => {
    // The repository root itself has a .git directory
    const repoRoot = path.resolve(__dirname, "../../");
    const info = await analyzeWorkspace(repoRoot);
    expect(info.gitInitialized).toBe(true);
  });
});
