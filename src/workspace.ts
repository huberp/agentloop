import * as fs from "fs/promises";
import * as path from "path";

/** Structured information about the project workspace. */
export interface WorkspaceInfo {
  /** Primary language detected: 'node', 'python', 'go', 'rust', 'cmake', or 'unknown'. */
  language: string;
  /** Framework detected from dependencies (e.g. 'react', 'django'), or 'none'. */
  framework: string;
  /** Package manager inferred from lock files or language (e.g. 'npm', 'pip', 'cargo', 'gradle'). */
  packageManager: string;
  /** True if a test directory or test script was found. */
  hasTests: boolean;
  /** Command to run the project's test suite (e.g. 'npm test'). */
  testCommand: string;
  /** Command to run the project's linter (e.g. 'npm run lint'). */
  lintCommand: string;
  /** Command to build the project (e.g. 'npm run build'). */
  buildCommand: string;
  /** Main entry-point files declared in the project manifest. */
  entryPoints: string[];
  /** True if a .git directory is present at rootPath. */
  gitInitialized: boolean;
}

/** Lifecycle target names extracted from Makefiles. */
const LIFECYCLE_TARGETS = ["test", "lint", "build", "run", "install"] as const;


async function exists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

/**
 * Parse a Makefile and return a map of recognised target names to their
 * `make <target>` invocation strings.  Only top-level targets whose names
 * match common lifecycle keywords are captured.
 */
async function parseMakefileTargets(rootPath: string): Promise<Record<string, string>> {
  const targets: Record<string, string> = {};
  const makefilePath = path.join(rootPath, "Makefile");

  try {
    const content = await fs.readFile(makefilePath, "utf-8");
    const pattern = new RegExp(`^(${LIFECYCLE_TARGETS.join("|")})\\s*:`, "i");
    for (const line of content.split("\n")) {
      const match = line.match(pattern);
      if (match) {
        targets[match[1].toLowerCase()] = `make ${match[1].toLowerCase()}`;
      }
    }
  } catch {
    // No Makefile present — silently skip
  }

  return targets;
}

/** Analyse a Node.js / TypeScript workspace. */
async function analyzeNode(rootPath: string): Promise<Partial<WorkspaceInfo>> {
  const info: Partial<WorkspaceInfo> = { language: "node", packageManager: "npm" };

  try {
    const raw = await fs.readFile(path.join(rootPath, "package.json"), "utf-8");
    const pkg = JSON.parse(raw);
    const deps: Record<string, string> = { ...pkg.dependencies, ...pkg.devDependencies };

    // Detect common frameworks from dependency names
    if (deps["react"]) info.framework = "react";
    else if (deps["next"]) info.framework = "next";
    else if (deps["vue"]) info.framework = "vue";
    else if (deps["express"]) info.framework = "express";
    else if (deps["@angular/core"]) info.framework = "angular";

    // Extract lifecycle commands from scripts section
    const scripts: Record<string, string> = pkg.scripts ?? {};
    if (scripts["test"]) info.testCommand = `npm test`;
    if (scripts["lint"]) info.lintCommand = `npm run lint`;
    if (scripts["build"]) info.buildCommand = `npm run build`;
    info.hasTests = Boolean(scripts["test"]);

    // Detect package manager from lock files (yarn.lock → yarn, pnpm-lock.yaml → pnpm, otherwise npm)
    if (await exists(path.join(rootPath, "yarn.lock"))) {
      info.packageManager = "yarn";
    } else if (await exists(path.join(rootPath, "pnpm-lock.yaml"))) {
      info.packageManager = "pnpm";
    }

    // Collect entry points declared in the manifest
    const entryPoints: string[] = [];
    if (pkg.main) entryPoints.push(pkg.main);
    if (pkg.bin) {
      if (typeof pkg.bin === "string") entryPoints.push(pkg.bin);
      else entryPoints.push(...(Object.values(pkg.bin) as string[]));
    }
    info.entryPoints = entryPoints;
  } catch {
    // Malformed package.json — leave language set, skip commands
  }

  return info;
}

/** Analyse a Python workspace. */
async function analyzePython(rootPath: string): Promise<Partial<WorkspaceInfo>> {
  const info: Partial<WorkspaceInfo> = {
    language: "python",
    packageManager: "pip",
    testCommand: "pytest",
    lintCommand: "flake8",
    buildCommand: "",
  };

  // Prefer Makefile commands when present
  const make = await parseMakefileTargets(rootPath);
  if (make["test"]) info.testCommand = make["test"];
  if (make["lint"]) info.lintCommand = make["lint"];
  if (make["build"]) info.buildCommand = make["build"];

  // Inspect pyproject.toml for package manager and framework hints
  const pyprojectPath = path.join(rootPath, "pyproject.toml");
  if (await exists(pyprojectPath)) {
    try {
      const content = await fs.readFile(pyprojectPath, "utf-8");
      if (content.includes("[tool.poetry]")) info.packageManager = "poetry";
      // Simple keyword detection for common frameworks
      if (content.includes("django")) info.framework = "django";
      else if (content.includes("flask")) info.framework = "flask";
      else if (content.includes("fastapi")) info.framework = "fastapi";
    } catch { /* ignore parse errors */ }
  }

  // Consider tests present if a standard test directory exists
  info.hasTests =
    (await exists(path.join(rootPath, "tests"))) ||
    (await exists(path.join(rootPath, "test")));

  return info;
}

/** Analyse a Go workspace. */
async function analyzeGo(rootPath: string): Promise<Partial<WorkspaceInfo>> {
  const info: Partial<WorkspaceInfo> = {
    language: "go",
    packageManager: "go mod",
    testCommand: "go test ./...",
    lintCommand: "golint ./...",
    buildCommand: "go build ./...",
  };

  // Override defaults with Makefile targets when available
  const make = await parseMakefileTargets(rootPath);
  if (make["test"]) info.testCommand = make["test"];
  if (make["lint"]) info.lintCommand = make["lint"];
  if (make["build"]) info.buildCommand = make["build"];

  // Check for *_test.go files in the root as a quick test-presence heuristic
  try {
    const entries = await fs.readdir(rootPath);
    info.hasTests = entries.some((f) => f.endsWith("_test.go"));
  } catch { /* ignore readdir failures */ }

  return info;
}

/**
 * Analyse a Rust/Cargo workspace.
 * Reads Cargo.toml for basic metadata and checks for a `tests/` directory.
 */
async function analyzeCargo(rootPath: string): Promise<Partial<WorkspaceInfo>> {
  const info: Partial<WorkspaceInfo> = {
    language: "rust",
    packageManager: "cargo",
    testCommand: "cargo test",
    lintCommand: "cargo clippy",
    buildCommand: "cargo build",
  };

  // Override defaults with Makefile targets when available
  const make = await parseMakefileTargets(rootPath);
  if (make["test"]) info.testCommand = make["test"];
  if (make["lint"]) info.lintCommand = make["lint"];
  if (make["build"]) info.buildCommand = make["build"];

  // Consider tests present if a tests/ directory or any #[cfg(test)] usage exists
  info.hasTests =
    (await exists(path.join(rootPath, "tests"))) ||
    (await exists(path.join(rootPath, "src", "tests")));

  return info;
}

/**
 * Analyse a CMake workspace.
 * Reads CMakeLists.txt for basic metadata and suggests cmake preset commands
 * when a CMakePresets.json file is present.
 */
async function analyzeCMake(rootPath: string): Promise<Partial<WorkspaceInfo>> {
  const info: Partial<WorkspaceInfo> = {
    language: "cmake",
    packageManager: "cmake",
    testCommand: "ctest --output-on-failure",
    lintCommand: "",
    buildCommand: "cmake --build build",
  };

  // When CMakePresets.json is present, recommend the preset-based workflow
  if (await exists(path.join(rootPath, "CMakePresets.json"))) {
    info.buildCommand = "cmake --preset default && cmake --build --preset default";
    info.testCommand = "ctest --preset default";
  } else {
    // Classic out-of-source build pattern
    info.buildCommand = "cmake -S . -B build && cmake --build build";
  }

  // Override with Makefile targets when available (common for CMake super-builds)
  const make = await parseMakefileTargets(rootPath);
  if (make["test"]) info.testCommand = make["test"];
  if (make["build"]) info.buildCommand = make["build"];

  // Detect tests by presence of a CTestTestfile, tests/ directory, or test subdirectory
  info.hasTests =
    (await exists(path.join(rootPath, "CTestTestfile.cmake"))) ||
    (await exists(path.join(rootPath, "tests"))) ||
    (await exists(path.join(rootPath, "test")));

  return info;
}

/**
 * Analyse a Gradle (Java/Kotlin/Android) workspace.
 */
async function analyzeGradle(rootPath: string): Promise<Partial<WorkspaceInfo>> {
  // Prefer ./gradlew wrapper when present
  const gradleCmd = (await exists(path.join(rootPath, "gradlew"))) ? "./gradlew" : "gradle";

  const info: Partial<WorkspaceInfo> = {
    language: "java",
    packageManager: "gradle",
    testCommand: `${gradleCmd} test`,
    lintCommand: `${gradleCmd} check`,
    buildCommand: `${gradleCmd} build`,
  };

  // Check for Kotlin DSL (build.gradle.kts) to refine the language label
  if (await exists(path.join(rootPath, "build.gradle.kts"))) {
    info.language = "kotlin";
  }

  info.hasTests = (await exists(path.join(rootPath, "src", "test")));

  return info;
}

/**
 * Analyse a Maven (Java) workspace.
 */
async function analyzeMaven(rootPath: string): Promise<Partial<WorkspaceInfo>> {
  // Prefer ./mvnw wrapper when present
  const mvnCmd = (await exists(path.join(rootPath, "mvnw"))) ? "./mvnw" : "mvn";

  const info: Partial<WorkspaceInfo> = {
    language: "java",
    packageManager: "maven",
    testCommand: `${mvnCmd} test`,
    lintCommand: `${mvnCmd} verify`,
    buildCommand: `${mvnCmd} package -DskipTests`,
  };

  info.hasTests = (await exists(path.join(rootPath, "src", "test")));

  return info;
}

/**
 * Analyse the workspace rooted at `rootPath` and return a `WorkspaceInfo`
 * object.  Language is detected via well-known indicator files; commands are
 * extracted from the project manifest (package.json, pyproject.toml) and
 * Makefile where available.
 */
export async function analyzeWorkspace(rootPath: string): Promise<WorkspaceInfo> {
  const base: WorkspaceInfo = {
    language: "unknown",
    framework: "none",
    packageManager: "unknown",
    hasTests: false,
    testCommand: "",
    lintCommand: "",
    buildCommand: "",
    entryPoints: [],
    gitInitialized: false,
  };

  // Check for a .git directory regardless of language
  base.gitInitialized = await exists(path.join(rootPath, ".git"));

  // Detect language from well-known indicator files (most specific first)
  let langInfo: Partial<WorkspaceInfo> = {};
  if (await exists(path.join(rootPath, "package.json"))) {
    langInfo = await analyzeNode(rootPath);
  } else if (
    (await exists(path.join(rootPath, "pyproject.toml"))) ||
    (await exists(path.join(rootPath, "requirements.txt")))
  ) {
    langInfo = await analyzePython(rootPath);
  } else if (await exists(path.join(rootPath, "go.mod"))) {
    langInfo = await analyzeGo(rootPath);
  } else if (await exists(path.join(rootPath, "Cargo.toml"))) {
    langInfo = await analyzeCargo(rootPath);
  } else if (await exists(path.join(rootPath, "CMakeLists.txt"))) {
    langInfo = await analyzeCMake(rootPath);
  } else if (
    (await exists(path.join(rootPath, "build.gradle"))) ||
    (await exists(path.join(rootPath, "build.gradle.kts")))
  ) {
    langInfo = await analyzeGradle(rootPath);
  } else if (await exists(path.join(rootPath, "pom.xml"))) {
    langInfo = await analyzeMaven(rootPath);
  }

  return { ...base, ...langInfo };
}
