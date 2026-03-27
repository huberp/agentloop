import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";
import simpleGit from "simple-git";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Create a temp directory that is also initialised as a Git repo. */
async function makeGitRepo(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "agentloop-git-test-"));
  const git = simpleGit(dir);
  await git.init();
  // Minimal identity so commits work in CI environments
  await git.addConfig("user.email", "test@agentloop.test");
  await git.addConfig("user.name", "AgentLoop Test");
  return dir;
}

/** Remove the temp repo created by makeGitRepo. */
async function cleanGitRepo(dir: string): Promise<void> {
  await fs.rm(dir, { recursive: true, force: true });
}

// Lazy requires so modules resolve at test-time (consistent with file-tools.test.ts)
// eslint-disable-next-line @typescript-eslint/no-require-imports
const gitStatus = () => require("../tools/git-status").toolDefinition;
// eslint-disable-next-line @typescript-eslint/no-require-imports
const gitDiff = () => require("../tools/git-diff").toolDefinition;
// eslint-disable-next-line @typescript-eslint/no-require-imports
const gitCommit = () => require("../tools/git-commit").toolDefinition;
// eslint-disable-next-line @typescript-eslint/no-require-imports
const gitLog = () => require("../tools/git-log").toolDefinition;
// eslint-disable-next-line @typescript-eslint/no-require-imports
const gitBranch = () => require("../tools/git-branch").toolDefinition;
// eslint-disable-next-line @typescript-eslint/no-require-imports
const gitCheckout = () => require("../tools/git-checkout").toolDefinition;
// eslint-disable-next-line @typescript-eslint/no-require-imports
const gitPush = () => require("../tools/git-push").toolDefinition;

// ---------------------------------------------------------------------------
// git-status
// ---------------------------------------------------------------------------

describe("git-status — metadata", () => {
  it("has the correct name and permission level", () => {
    expect(gitStatus().name).toBe("git-status");
    expect(gitStatus().permissions).toBe("safe");
  });
});

describe("git-status — clean repository", () => {
  let repo: string;

  beforeAll(async () => {
    repo = await makeGitRepo();
    // Create and commit an initial file so there is a valid HEAD
    await fs.writeFile(path.join(repo, "init.txt"), "init");
    const git = simpleGit(repo);
    await git.add(".");
    await git.commit("initial commit");
  });

  afterAll(() => cleanGitRepo(repo));

  it("reports a clean repository", async () => {
    const raw = await gitStatus().execute({ cwd: repo });
    const result = JSON.parse(raw);

    expect(result.isClean).toBe(true);
    expect(result.entries).toHaveLength(0);
  });
});

describe("git-status — uncommitted changes", () => {
  let repo: string;

  beforeAll(async () => {
    repo = await makeGitRepo();
    await fs.writeFile(path.join(repo, "init.txt"), "init");
    const git = simpleGit(repo);
    await git.add(".");
    await git.commit("initial commit");
    // Introduce an untracked file and a modified tracked file
    await fs.writeFile(path.join(repo, "new.txt"), "new file");
    await fs.writeFile(path.join(repo, "init.txt"), "modified");
  });

  afterAll(() => cleanGitRepo(repo));

  it("returns structured file status list for changed files", async () => {
    const raw = await gitStatus().execute({ cwd: repo });
    const result = JSON.parse(raw);

    expect(result.isClean).toBe(false);
    const paths = result.entries.map((e: { path: string }) => e.path);
    expect(paths).toContain("init.txt");
    expect(paths).toContain("new.txt");
  });

  it("status code for an untracked file is '??'", async () => {
    const raw = await gitStatus().execute({ cwd: repo });
    const result = JSON.parse(raw);

    const untracked = result.entries.find((e: { path: string }) => e.path === "new.txt");
    expect(untracked.status).toBe("??");
  });
});

describe("git-status — outside a Git repository", () => {
  it("returns an error gracefully when cwd is not a git repo", async () => {
    const raw = await gitStatus().execute({ cwd: os.tmpdir() });
    const result = JSON.parse(raw);

    // Should surface an error message, not throw
    expect(result.error).toBeDefined();
    expect(result.entries).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// git-diff
// ---------------------------------------------------------------------------

describe("git-diff — metadata", () => {
  it("has the correct name and permission level", () => {
    expect(gitDiff().name).toBe("git-diff");
    expect(gitDiff().permissions).toBe("safe");
  });
});

describe("git-diff — working-tree diff", () => {
  let repo: string;

  beforeAll(async () => {
    repo = await makeGitRepo();
    await fs.writeFile(path.join(repo, "file.txt"), "hello");
    const git = simpleGit(repo);
    await git.add(".");
    await git.commit("initial commit");
    // Modify the tracked file to create a diff
    await fs.writeFile(path.join(repo, "file.txt"), "hello world");
  });

  afterAll(() => cleanGitRepo(repo));

  it("shows diff content for a modified file", async () => {
    const raw = await gitDiff().execute({ cwd: repo });
    const result = JSON.parse(raw);

    expect(result.diff).toContain("hello world");
  });

  it("limits the diff to the requested path", async () => {
    const raw = await gitDiff().execute({ cwd: repo, path: "file.txt" });
    const result = JSON.parse(raw);

    expect(result.diff).toContain("file.txt");
  });
});

describe("git-diff — staged diff", () => {
  let repo: string;

  beforeAll(async () => {
    repo = await makeGitRepo();
    await fs.writeFile(path.join(repo, "staged.txt"), "original");
    const git = simpleGit(repo);
    await git.add(".");
    await git.commit("initial commit");
    // Stage a modification
    await fs.writeFile(path.join(repo, "staged.txt"), "changed");
    await git.add("staged.txt");
  });

  afterAll(() => cleanGitRepo(repo));

  it("returns the staged diff when staged=true", async () => {
    const raw = await gitDiff().execute({ cwd: repo, staged: true });
    const result = JSON.parse(raw);

    expect(result.diff).toContain("changed");
  });
});

describe("git-diff — outside a Git repository", () => {
  it("returns an error gracefully when cwd is not a git repo", async () => {
    const raw = await gitDiff().execute({ cwd: os.tmpdir() });
    const result = JSON.parse(raw);

    expect(result.error).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// git-commit
// ---------------------------------------------------------------------------

describe("git-commit — metadata", () => {
  it("has the correct name and permission level", () => {
    expect(gitCommit().name).toBe("git-commit");
    expect(gitCommit().permissions).toBe("cautious");
  });
});

describe("git-commit — creating commits", () => {
  let repo: string;

  beforeEach(async () => {
    repo = await makeGitRepo();
    await fs.writeFile(path.join(repo, "a.txt"), "content a");
    await fs.writeFile(path.join(repo, "b.txt"), "content b");
    const git = simpleGit(repo);
    await git.add(".");
    await git.commit("initial commit");
  });

  afterEach(() => cleanGitRepo(repo));

  it("stages explicit files and creates a commit", async () => {
    await fs.writeFile(path.join(repo, "a.txt"), "modified a");
    const raw = await gitCommit().execute({ cwd: repo, message: "update a", files: ["a.txt"] });
    const result = JSON.parse(raw);

    expect(result.success).toBe(true);
    expect(typeof result.commitHash).toBe("string");
  });

  it("created commit appears in git-log output", async () => {
    await fs.writeFile(path.join(repo, "b.txt"), "modified b");
    await gitCommit().execute({ cwd: repo, message: "update b", files: ["b.txt"] });

    const logRaw = await gitLog().execute({ cwd: repo });
    const logResult = JSON.parse(logRaw);

    const messages = logResult.commits.map((c: { message: string }) => c.message);
    expect(messages).toContain("update b");
  });

  it("stages all tracked changes when no files are specified", async () => {
    await fs.writeFile(path.join(repo, "a.txt"), "all changed");
    await fs.writeFile(path.join(repo, "b.txt"), "all changed too");
    const raw = await gitCommit().execute({ cwd: repo, message: "stage all" });
    const result = JSON.parse(raw);

    expect(result.success).toBe(true);
  });
});

describe("git-commit — outside a Git repository", () => {
  it("returns an error gracefully when cwd is not a git repo", async () => {
    const raw = await gitCommit().execute({ cwd: os.tmpdir(), message: "test" });
    const result = JSON.parse(raw);

    expect(result.success).toBe(false);
    expect(result.error).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// git-log
// ---------------------------------------------------------------------------

describe("git-log — metadata", () => {
  it("has the correct name and permission level", () => {
    expect(gitLog().name).toBe("git-log");
    expect(gitLog().permissions).toBe("safe");
  });
});

describe("git-log — reading commit history", () => {
  let repo: string;

  beforeAll(async () => {
    repo = await makeGitRepo();
    const git = simpleGit(repo);
    // Create two commits so the log has multiple entries
    await fs.writeFile(path.join(repo, "first.txt"), "first");
    await git.add(".");
    await git.commit("first commit");
    await fs.writeFile(path.join(repo, "second.txt"), "second");
    await git.add(".");
    await git.commit("second commit");
  });

  afterAll(() => cleanGitRepo(repo));

  it("returns recent commits in reverse-chronological order", async () => {
    const raw = await gitLog().execute({ cwd: repo });
    const result = JSON.parse(raw);

    expect(result.commits.length).toBeGreaterThanOrEqual(2);
    expect(result.commits[0].message).toBe("second commit");
    expect(result.commits[1].message).toBe("first commit");
  });

  it("respects the maxCount limit", async () => {
    const raw = await gitLog().execute({ cwd: repo, maxCount: 1 });
    const result = JSON.parse(raw);

    expect(result.commits).toHaveLength(1);
    expect(result.commits[0].message).toBe("second commit");
  });

  it("each entry has the expected fields", async () => {
    const raw = await gitLog().execute({ cwd: repo });
    const { commits } = JSON.parse(raw);
    const entry = commits[0];

    expect(typeof entry.hash).toBe("string");
    expect(typeof entry.date).toBe("string");
    expect(typeof entry.message).toBe("string");
    expect(typeof entry.author_name).toBe("string");
    expect(typeof entry.author_email).toBe("string");
  });
});

describe("git-log — outside a Git repository", () => {
  it("returns an error gracefully when cwd is not a git repo", async () => {
    const raw = await gitLog().execute({ cwd: os.tmpdir() });
    const result = JSON.parse(raw);

    expect(result.error).toBeDefined();
    expect(result.commits).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// git-branch
// ---------------------------------------------------------------------------

describe("git-branch — metadata", () => {
  it("has the correct name and permission level", () => {
    expect(gitBranch().name).toBe("git-branch");
    expect(gitBranch().permissions).toBe("cautious");
  });
});

describe("git-branch — list", () => {
  let repo: string;

  beforeAll(async () => {
    repo = await makeGitRepo();
    const git = simpleGit(repo);
    await fs.writeFile(path.join(repo, "init.txt"), "init");
    await git.add(".");
    await git.commit("initial commit");
    // Create an extra branch so the list has at least two entries
    await git.branch(["feature/test"]);
  });

  afterAll(() => cleanGitRepo(repo));

  it("lists all local branches", async () => {
    const raw = await gitBranch().execute({ action: "list", cwd: repo });
    const result = JSON.parse(raw);

    expect(result.success).toBe(true);
    const names = result.branches.map((b: { name: string }) => b.name);
    expect(names).toContain("feature/test");
  });

  it("reports which branch is current", async () => {
    const raw = await gitBranch().execute({ action: "list", cwd: repo });
    const result = JSON.parse(raw);

    expect(typeof result.current).toBe("string");
    const current = result.branches.find((b: { current: boolean }) => b.current);
    expect(current).toBeDefined();
    expect(current.name).toBe(result.current);
  });
});

describe("git-branch — create", () => {
  let repo: string;

  beforeEach(async () => {
    repo = await makeGitRepo();
    const git = simpleGit(repo);
    await fs.writeFile(path.join(repo, "init.txt"), "init");
    await git.add(".");
    await git.commit("initial commit");
  });

  afterEach(() => cleanGitRepo(repo));

  it("creates a new branch from HEAD", async () => {
    const raw = await gitBranch().execute({ action: "create", branch: "my-feature", cwd: repo });
    const result = JSON.parse(raw);

    expect(result.success).toBe(true);

    // Verify branch exists
    const listRaw = await gitBranch().execute({ action: "list", cwd: repo });
    const list = JSON.parse(listRaw);
    const names = list.branches.map((b: { name: string }) => b.name);
    expect(names).toContain("my-feature");
  });

  it("returns an error when branch name is missing", async () => {
    const raw = await gitBranch().execute({ action: "create", cwd: repo });
    const result = JSON.parse(raw);

    expect(result.success).toBe(false);
    expect(result.error).toBeDefined();
  });
});

describe("git-branch — delete", () => {
  let repo: string;

  beforeEach(async () => {
    repo = await makeGitRepo();
    const git = simpleGit(repo);
    await fs.writeFile(path.join(repo, "init.txt"), "init");
    await git.add(".");
    await git.commit("initial commit");
    await git.branch(["to-delete"]);
  });

  afterEach(() => cleanGitRepo(repo));

  it("deletes an existing branch", async () => {
    const raw = await gitBranch().execute({ action: "delete", branch: "to-delete", cwd: repo });
    const result = JSON.parse(raw);

    expect(result.success).toBe(true);

    const listRaw = await gitBranch().execute({ action: "list", cwd: repo });
    const list = JSON.parse(listRaw);
    const names = list.branches.map((b: { name: string }) => b.name);
    expect(names).not.toContain("to-delete");
  });

  it("returns an error when deleting a non-existent branch", async () => {
    const raw = await gitBranch().execute({
      action: "delete",
      branch: "does-not-exist",
      cwd: repo,
    });
    const result = JSON.parse(raw);

    expect(result.success).toBe(false);
    expect(result.error).toBeDefined();
  });
});

describe("git-branch — outside a Git repository", () => {
  it("returns an error gracefully when cwd is not a git repo", async () => {
    const raw = await gitBranch().execute({ action: "list", cwd: os.tmpdir() });
    const result = JSON.parse(raw);

    expect(result.success).toBe(false);
    expect(result.error).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// git-checkout
// ---------------------------------------------------------------------------

describe("git-checkout — metadata", () => {
  it("has the correct name and permission level", () => {
    expect(gitCheckout().name).toBe("git-checkout");
    expect(gitCheckout().permissions).toBe("cautious");
  });
});

describe("git-checkout — switching branches", () => {
  let repo: string;

  beforeEach(async () => {
    repo = await makeGitRepo();
    const git = simpleGit(repo);
    await fs.writeFile(path.join(repo, "init.txt"), "init");
    await git.add(".");
    await git.commit("initial commit");
    await git.branch(["other-branch"]);
  });

  afterEach(() => cleanGitRepo(repo));

  it("switches to an existing branch", async () => {
    const raw = await gitCheckout().execute({ branch: "other-branch", cwd: repo });
    const result = JSON.parse(raw);

    expect(result.success).toBe(true);

    const git = simpleGit(repo);
    const status = await git.status();
    expect(status.current).toBe("other-branch");
  });

  it("returns an error when the target branch does not exist", async () => {
    const raw = await gitCheckout().execute({ branch: "no-such-branch", cwd: repo });
    const result = JSON.parse(raw);

    expect(result.success).toBe(false);
    expect(result.error).toBeDefined();
  });
});

describe("git-checkout — create and switch (newBranch)", () => {
  let repo: string;

  beforeEach(async () => {
    repo = await makeGitRepo();
    const git = simpleGit(repo);
    await fs.writeFile(path.join(repo, "init.txt"), "init");
    await git.add(".");
    await git.commit("initial commit");
  });

  afterEach(() => cleanGitRepo(repo));

  it("creates a new branch and checks it out", async () => {
    // Use the actual current branch as start point (could be "main" or "master")
    const git = simpleGit(repo);
    const status = await git.status();
    const currentBranch = status.current!;

    const raw = await gitCheckout().execute({
      branch: currentBranch,
      newBranch: "feat/new",
      cwd: repo,
    });
    const result = JSON.parse(raw);

    expect(result.success).toBe(true);
    expect(result.branch).toBe("feat/new");

    const afterStatus = await git.status();
    expect(afterStatus.current).toBe("feat/new");
  });
});

describe("git-checkout — outside a Git repository", () => {
  it("returns an error gracefully when cwd is not a git repo", async () => {
    const raw = await gitCheckout().execute({ branch: "main", cwd: os.tmpdir() });
    const result = JSON.parse(raw);

    expect(result.success).toBe(false);
    expect(result.error).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// git-push
// ---------------------------------------------------------------------------

describe("git-push — metadata", () => {
  it("has the correct name and permission level", () => {
    expect(gitPush().name).toBe("git-push");
    expect(gitPush().permissions).toBe("dangerous");
  });
});

describe("git-push — pushing to a local remote", () => {
  let origin: string;
  let clone: string;

  beforeEach(async () => {
    // Create a bare repo that acts as the "remote"
    origin = await fs.mkdtemp(path.join(os.tmpdir(), "agentloop-git-origin-"));
    const originGit = simpleGit(origin);
    await originGit.init(["--bare"]);

    // Clone the bare repo to get a working copy with remote configured
    clone = await fs.mkdtemp(path.join(os.tmpdir(), "agentloop-git-clone-"));
    const cloneGit = simpleGit(clone);
    await cloneGit.clone(origin, clone);
    await cloneGit.addConfig("user.email", "test@agentloop.test");
    await cloneGit.addConfig("user.name", "AgentLoop Test");

    // Create an initial commit so there is something to push
    await fs.writeFile(path.join(clone, "init.txt"), "init");
    await cloneGit.add(".");
    await cloneGit.commit("initial commit");
  });

  afterEach(async () => {
    await fs.rm(origin, { recursive: true, force: true });
    await fs.rm(clone, { recursive: true, force: true });
  });

  it("pushes the current branch to origin", async () => {
    const raw = await gitPush().execute({ cwd: clone });
    const result = JSON.parse(raw);

    expect(result.success).toBe(true);
    expect(result.remote).toBe("origin");
    expect(typeof result.branch).toBe("string");
  });

  it("pushes a named branch to origin", async () => {
    const git = simpleGit(clone);
    const status = await git.status();
    const currentBranch = status.current!;

    const raw = await gitPush().execute({ remote: "origin", branch: currentBranch, cwd: clone });
    const result = JSON.parse(raw);

    expect(result.success).toBe(true);
    expect(result.branch).toBe(currentBranch);
  });

  it("returns an error when pushing to a non-existent remote", async () => {
    const raw = await gitPush().execute({ remote: "no-such-remote", cwd: clone });
    const result = JSON.parse(raw);

    expect(result.success).toBe(false);
    expect(result.error).toBeDefined();
  });
});
