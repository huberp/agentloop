/**
 * Benchmark: Code Search
 *
 * Creates a temporary repository with 500 mock TypeScript files spread across
 * 10 directories, then performs a literal-string search across all files.
 * Uses the built-in fs-based fallback (does not require ripgrep).
 */
import { performance } from "node:perf_hooks";
import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";
import { appConfig } from "../src/config";
import { toolDefinition } from "../src/tools/code-search";

export interface BenchmarkResult {
  name: string;
  durationMs: number;
  iterations: number;
  opsPerSec: number;
}

const FILE_COUNT = 500;
const FILES_PER_DIR = 50;

/** Generate realistic-looking TypeScript module content. */
function generateMockTs(idx: number): string {
  return `// Module ${idx}: auto-generated utility
import { EventEmitter } from "events";

export interface Config${idx} {
  id: number;
  name: string;
  enabled: boolean;
  tags: string[];
}

export class Service${idx} extends EventEmitter {
  private readonly config: Config${idx};

  constructor(config: Config${idx}) {
    super();
    this.config = config;
  }

  // BENCH_SEARCH_TARGET: the distinctive marker phrase used in search benchmarks
  process(input: string): string {
    if (!this.config.enabled) {
      return \`service-\${this.config.id}: disabled\`;
    }
    return \`\${this.config.name}[\${idx}]: \${input}\`;
  }

  getStats(): Record<string, unknown> {
    return { id: this.config.id, name: this.config.name, enabled: this.config.enabled };
  }
}

export const DEFAULT_CONFIG_${idx}: Config${idx} = {
  id: ${idx},
  name: "module-${idx}",
  enabled: ${idx % 4 !== 0},
  tags: ["generated", "bench", "module-${idx % 10}"],
};
`;
}

/** Populate the temporary directory with FILE_COUNT files across subdirectories. */
async function createMockRepo(rootDir: string): Promise<void> {
  const dirCount = Math.ceil(FILE_COUNT / FILES_PER_DIR);
  const writes: Promise<void>[] = [];

  for (let d = 0; d < dirCount; d++) {
    const dirPath = path.join(rootDir, `pkg-${String(d).padStart(2, "0")}`);
    await fs.mkdir(dirPath, { recursive: true });

    const filesInDir = Math.min(FILES_PER_DIR, FILE_COUNT - d * FILES_PER_DIR);
    for (let f = 0; f < filesInDir; f++) {
      const content = generateMockTs(d * FILES_PER_DIR + f);
      writes.push(fs.writeFile(path.join(dirPath, `module-${f}.ts`), content, "utf-8"));
    }
  }

  await Promise.all(writes);
}

export async function run(): Promise<BenchmarkResult> {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "agentloop-bench-search-"));

  try {
    await createMockRepo(tempDir);

    // Redirect workspace root to the temp directory for the duration of the benchmark
    const originalRoot = appConfig.workspaceRoot;
    appConfig.workspaceRoot = tempDir;

    try {
      // Warm up: one search to ensure OS file cache is warm
      await toolDefinition.execute({
        pattern: "BENCH_SEARCH_TARGET",
        mode: "literal",
        path: ".",
        maxResults: 10,
        contextLines: 0,
      });

      const start = performance.now();

      const rawResult = await toolDefinition.execute({
        pattern: "BENCH_SEARCH_TARGET",
        mode: "literal",
        path: ".",
        maxResults: 1000,
        contextLines: 0,
      });

      const durationMs = performance.now() - start;
      const parsed = JSON.parse(rawResult) as { matches: unknown[]; truncated: boolean };

      return {
        name: `Code Search (${FILE_COUNT} files, literal match, ${parsed.matches.length} hits)`,
        durationMs,
        iterations: 1,
        opsPerSec: Math.round(1000 / durationMs),
      };
    } finally {
      appConfig.workspaceRoot = originalRoot;
    }
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
}
