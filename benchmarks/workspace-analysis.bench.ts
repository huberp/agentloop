/**
 * Benchmark: Workspace Analysis
 *
 * Creates a simulated large Node.js project (package.json, lock file, .git,
 * 8 source directories × 20 files each) and runs analyzeWorkspace() repeatedly.
 */
import { performance } from "node:perf_hooks";
import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";
import { analyzeWorkspace } from "../src/workspace";

export interface BenchmarkResult {
  name: string;
  durationMs: number;
  iterations: number;
  opsPerSec: number;
}

const ITERATIONS = 20;

/** Build a realistic large Node.js project layout in `rootDir`. */
async function createLargeNodeProject(rootDir: string): Promise<void> {
  const pkg = {
    name: "large-simulated-project",
    version: "2.0.0",
    description: "Simulated large project for workspace analysis benchmarking",
    main: "src/index.js",
    scripts: {
      test: "jest --runInBand",
      lint: "eslint src --ext .ts",
      build: "tsc --build",
      start: "node dist/index.js",
    },
    dependencies: {
      react: "^18.2.0",
      express: "^4.18.2",
      lodash: "^4.17.21",
    },
    devDependencies: {
      typescript: "^5.2.2",
      jest: "^29.6.0",
      eslint: "^8.50.0",
    },
    bin: { "my-cli": "dist/cli.js" },
  };

  const writes: Promise<void>[] = [
    fs.writeFile(path.join(rootDir, "package.json"), JSON.stringify(pkg, null, 2), "utf-8"),
    // Presence of yarn.lock → packageManager detection
    fs.writeFile(path.join(rootDir, "yarn.lock"), "# yarn lockfile v1\n\n", "utf-8"),
    fs.writeFile(path.join(rootDir, "tsconfig.json"), JSON.stringify({ compilerOptions: { strict: true } }), "utf-8"),
    fs.writeFile(path.join(rootDir, ".eslintrc.json"), JSON.stringify({ extends: "eslint:recommended" }), "utf-8"),
    fs.writeFile(path.join(rootDir, "README.md"), "# Large Simulated Project\n", "utf-8"),
    fs.writeFile(path.join(rootDir, ".gitignore"), "node_modules/\ndist/\n*.log\n", "utf-8"),
  ];

  // Initialise a minimal .git directory so gitInitialized comes back true
  await fs.mkdir(path.join(rootDir, ".git"), { recursive: true });
  writes.push(fs.writeFile(path.join(rootDir, ".git", "HEAD"), "ref: refs/heads/main\n", "utf-8"));

  // Create 8 source directories, each with 20 TypeScript files
  const SOURCE_DIRS = ["src", "tests", "lib", "utils", "components", "services", "models", "api"];

  for (const dir of SOURCE_DIRS) {
    await fs.mkdir(path.join(rootDir, dir, "subdir"), { recursive: true });
    for (let i = 0; i < 20; i++) {
      writes.push(
        fs.writeFile(
          path.join(rootDir, dir, `file-${i}.ts`),
          `export const ${dir}Value${i} = ${i};\nexport function ${dir}Fn${i}() { return ${i}; }\n`,
          "utf-8"
        )
      );
    }
  }

  await Promise.all(writes);
}

export async function run(): Promise<BenchmarkResult> {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "agentloop-bench-ws-"));

  try {
    await createLargeNodeProject(tempDir);

    // Warm up
    await analyzeWorkspace(tempDir);

    const start = performance.now();

    for (let i = 0; i < ITERATIONS; i++) {
      await analyzeWorkspace(tempDir);
    }

    const durationMs = performance.now() - start;
    const avgMs = durationMs / ITERATIONS;

    return {
      name: `Workspace Analysis (Node.js project, ${ITERATIONS} iterations, avg ${avgMs.toFixed(1)}ms/call)`,
      durationMs,
      iterations: ITERATIONS,
      opsPerSec: Math.round((ITERATIONS / durationMs) * 1000),
    };
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
}
