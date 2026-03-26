import * as os from "os";
import * as fs from "fs/promises";
import * as path from "path";

/** A self-contained temporary workspace directory for one E2E test suite. */
export interface WorkspaceFixture {
  /** Absolute path to the temporary workspace directory. */
  dir: string;
  /** Remove the workspace directory and all its contents. */
  cleanup(): Promise<void>;
  /** Write a file relative to the workspace root, creating parent dirs as needed. */
  writeFile(relPath: string, content: string): Promise<void>;
  /** Read a file relative to the workspace root as UTF-8 text. */
  readFile(relPath: string): Promise<string>;
  /** Returns true if the file exists relative to the workspace root. */
  fileExists(relPath: string): Promise<boolean>;
}

/**
 * Create a fresh temporary workspace directory for an E2E test suite.
 * Call `fixture.cleanup()` in `afterAll` to remove the directory.
 */
export async function createWorkspaceFixture(): Promise<WorkspaceFixture> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "agentloop-e2e-"));

  return {
    dir,

    async cleanup() {
      await fs.rm(dir, { recursive: true, force: true });
    },

    async writeFile(relPath: string, content: string) {
      const fullPath = path.join(dir, relPath);
      await fs.mkdir(path.dirname(fullPath), { recursive: true });
      await fs.writeFile(fullPath, content, "utf-8");
    },

    async readFile(relPath: string) {
      return fs.readFile(path.join(dir, relPath), "utf-8");
    },

    async fileExists(relPath: string) {
      try {
        await fs.access(path.join(dir, relPath));
        return true;
      } catch {
        return false;
      }
    },
  };
}
