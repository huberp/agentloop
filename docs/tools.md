# Built-in Tools

All built-in tools live in `src/tools/`. Each file exports a `toolDefinition` constant that is automatically discovered and registered at startup — no central list needs to be edited when adding new tools.

## Permission Levels

| Level | Behaviour |
|---|---|
| `safe` | Auto-approved silently |
| `cautious` | Auto-approved with an audit-log warning |
| `dangerous` | Requires interactive confirmation unless `AUTO_APPROVE_ALL=true` |

---

## calculate

**Permission:** `safe`  
**File:** `src/tools/calculate.ts`

Evaluates a mathematical expression using [mathjs](https://mathjs.org/). Safe — does not use `eval`.

### Inputs

| Field | Type | Description |
|---|---|---|
| `expression` | `string` | Mathematical expression to evaluate, e.g. `"2 + 3 * 4"` |

### Output

A plain string: `Result of <expression>: <result>` or an error message.

### Example

```
calculate({ expression: "(3^2 + 4^2) ^ 0.5" })
→ "Result of (3^2 + 4^2) ^ 0.5: 5"
```

---

## search

**Permission:** `safe`  
**File:** `src/tools/search.ts`

Web search tool with pluggable provider support. Returns a JSON array of results with `title`, `link`, and `snippet` fields. On failure, returns a JSON object `{ error, query, results: [] }`.

The active provider is selected via `WEB_SEARCH_PROVIDER`:

| Value | Description |
|---|---|
| `duckduckgo` (default) | Scrapes DuckDuckGo — no API key required |
| `tavily` | [Tavily](https://tavily.com) REST API — requires `TAVILY_API_KEY` |
| `langsearch` | [LangSearch](https://langsearch.com) REST API — requires `LANGSEARCH_API_KEY` |
| `none` | Disabled — always returns an empty results array |

See [docs/search-providers.md](search-providers.md) for full setup instructions and configuration reference.

### Inputs

| Field | Type | Description |
|---|---|---|
| `query` | `string` | Search query string |

### Output

JSON array of result objects:

```json
[
  { "title": "Example", "link": "https://example.com", "snippet": "…" }
]
```

### Configuration (selected keys)

| Variable | Default | Description |
|---|---|---|
| `WEB_SEARCH_PROVIDER` | `duckduckgo` | Active provider |
| `TAVILY_API_KEY` | — | Required when provider is `tavily` |
| `LANGSEARCH_API_KEY` | — | Required when provider is `langsearch` |
| `DUCKDUCKGO_MAX_RESULTS` | `5` | DDG result cap |
| `DUCKDUCKGO_CACHE_TTL_MS` | `300000` | Shared cache TTL (all providers) |

---

## code-search

**Permission:** `safe`  
**File:** `src/tools/code-search.ts`

Searches the workspace for text patterns. Supports three modes:

- `literal` — exact string match (default)
- `regex` — regular expression search
- `glob` — file-name glob (returns matching file paths, not content)

### Inputs

| Field | Type | Default | Description |
|---|---|---|---|
| `pattern` | `string` | — | Pattern to search for |
| `mode` | `"literal" \| "regex" \| "glob"` | `"literal"` | Matching mode |
| `path` | `string` | `"."` | Directory to search (relative to workspace root) |
| `maxResults` | `number` | `50` | Cap on number of results |
| `contextLines` | `number` | `2` | Lines of surrounding context to include |
| `fileGlob` | `string` | — | Glob to restrict which files are searched (e.g. `**/*.ts`) |

### Output

JSON object: `{ matches: SearchMatch[], truncated: boolean }` where each `SearchMatch` has `file`, `line`, `column`, `content`, and `context`.

### Example

```
code-search({ pattern: "ToolDefinition", mode: "literal", fileGlob: "**/*.ts" })
→ JSON with all matches of "ToolDefinition" in TypeScript files
```

---

## code\_run

**Permission:** `dangerous`  
**File:** `src/tools/code-run.ts`

Executes a command or script file in a subprocess. Supports an optional Docker sandbox when `SANDBOX_MODE=docker`.

### Inputs

| Field | Type | Required | Description |
|---|---|---|---|
| `mode` | `"command" \| "file"` | yes | Execution mode |
| `command` | `string` | mode=command | Command string to execute (split by whitespace) |
| `file` | `string` | mode=file | Absolute path to script file |
| `interpreter` | `string` | no | Override interpreter (inferred from extension if omitted) |
| `cwd` | `string` | no | Working directory (defaults to `process.cwd()`) |
| `env` | `Record<string, string>` | no | Extra environment variables |
| `timeout` | `number` | no | Timeout in ms (overrides `EXECUTION_TIMEOUT_MS`) |

Interpreter defaults by extension: `.js` → `node`, `.ts` → `ts-node`, `.py` → `python3`, `.sh` → `bash`, `.rb` → `ruby`.

### Output

JSON: `{ stdout, stderr, exitCode }`.

### Example

```
code_run({ mode: "command", command: "node --version" })
→ { stdout: "v20.x.x\n", stderr: "", exitCode: 0 }
```

---

## shell

**Permission:** `dangerous`  
**File:** `src/tools/shell.ts`

Runs a single executable with arguments using `execFile` (no shell spawned). Shell injection metacharacters (`;`, `&&`, `|`, backticks, `$()`) are rejected before execution. A built-in blocklist rejects the most dangerous patterns (`rm -rf /`, `mkfs`, fork bomb, etc.).

### Inputs

| Field | Type | Required | Description |
|---|---|---|---|
| `command` | `string` | yes | Command to run (split by whitespace) |
| `cwd` | `string` | no | Working directory (must be inside `WORKSPACE_ROOT`) |
| `env` | `Record<string, string>` | no | Extra environment variables |
| `timeout` | `number` | no | Timeout in ms (overrides `TOOL_TIMEOUT_MS`) |

### Output

JSON: `{ stdout, stderr, exitCode }`.

### Example

```
shell({ command: "npm test", cwd: "." })
→ { stdout: "...", stderr: "", exitCode: 0 }
```

---

## file-list

**Permission:** `safe`  
**File:** `src/tools/file-list.ts`

Lists the contents of a directory inside the workspace. Supports optional glob filtering and recursive traversal.

### Inputs

| Field | Type | Default | Description |
|---|---|---|---|
| `path` | `string` | `"."` | Directory path relative to workspace root |
| `glob` | `string` | — | Glob filter (e.g. `*.ts`, `**/*.json`) |
| `recursive` | `boolean` | `false` | Recurse into subdirectories |

### Output

JSON array of `{ path, type, sizeBytes? }` objects.

### Example

```
file-list({ path: "src/tools", glob: "*.ts" })
→ [{ path: "calculate.ts", type: "file", sizeBytes: 512 }, ...]
```

---

## file-read

**Permission:** `safe`  
**File:** `src/tools/file-read.ts`

Reads a file from the workspace. Binary files are returned base64-encoded when no explicit encoding is requested. Enforces `MAX_FILE_SIZE_BYTES`.

### Inputs

| Field | Type | Default | Description |
|---|---|---|---|
| `path` | `string` | — | File path relative to workspace root |
| `encoding` | `"utf-8" \| "base64"` | auto-detect | Encoding for the returned content |

### Output

JSON: `{ content, encoding, sizeBytes }`.

### Example

```
file-read({ path: "package.json" })
→ { content: "{\n  \"name\": \"agentloop\"...", encoding: "utf-8", sizeBytes: 892 }
```

---

## file-write

**Permission:** `cautious`  
**File:** `src/tools/file-write.ts`

Creates or overwrites a file inside the workspace. Parent directories are created automatically. Enforces `MAX_FILE_SIZE_BYTES`.

### Inputs

| Field | Type | Default | Description |
|---|---|---|---|
| `path` | `string` | — | File path relative to workspace root |
| `content` | `string` | — | Content to write |
| `encoding` | `"utf-8" \| "base64"` | `"utf-8"` | Encoding of the provided content |

### Output

JSON: `{ success: true, path }` or throws on error.

### Example

```
file-write({ path: "output/result.txt", content: "Hello, world!\n" })
→ { success: true, path: "output/result.txt" }
```

---

## file-edit

**Permission:** `cautious`  
**File:** `src/tools/file-edit.ts`

Applies a targeted edit to a file. Two modes:

- **search/replace** — replaces the first occurrence of `search` with `replace`.
- **line-range** — replaces lines `startLine` through `endLine` (1-based, inclusive) with `newContent`.

### Inputs (search/replace mode)

| Field | Type | Description |
|---|---|---|
| `path` | `string` | File path relative to workspace root |
| `search` | `string` | Exact string to find |
| `replace` | `string` | Replacement string |

### Inputs (line-range mode)

| Field | Type | Description |
|---|---|---|
| `path` | `string` | File path relative to workspace root |
| `startLine` | `number` | First line to replace (1-based) |
| `endLine` | `number` | Last line to replace (1-based, inclusive) |
| `newContent` | `string` | Replacement text |

### Output

JSON: `{ success: true, path }` or `{ success: false, error }`.

### Example

```
file-edit({ path: "src/config.ts", search: "old text", replace: "new text" })
→ { success: true, path: "src/config.ts" }
```

---

## file-delete

**Permission:** `dangerous`  
**File:** `src/tools/file-delete.ts`

Deletes a file inside the workspace. **This operation is irreversible.**

### Inputs

| Field | Type | Description |
|---|---|---|
| `path` | `string` | File path relative to workspace root |

### Output

JSON: `{ success: true, path }` or throws on error.

---

## diff

**Permission:** `safe`  
**File:** `src/tools/diff.ts`

Generates a unified diff between two strings or two workspace files. Read-only, no side effects.

### Inputs

| Field | Type | Default | Description |
|---|---|---|---|
| `original` | `string` | — | Original text or file path (when mode=files) |
| `modified` | `string` | — | Modified text or file path (when mode=files) |
| `mode` | `"strings" \| "files"` | `"strings"` | Compare inline strings or workspace files |
| `originalLabel` | `string` | `"original"` | Label for the original side |
| `modifiedLabel` | `string` | `"modified"` | Label for the modified side |

### Output

A unified diff string (standard patch format).

### Example

```
diff({ original: "foo\nbar\n", modified: "foo\nbaz\n" })
→ "--- original\n+++ modified\n@@ -1,2 +1,2 @@\n foo\n-bar\n+baz\n"
```

---

## patch

**Permission:** `cautious`  
**File:** `src/tools/patch.ts`

Applies a unified diff patch to a file inside the workspace. The patch must be a valid unified diff string (e.g. as produced by the `diff` tool).

### Inputs

| Field | Type | Description |
|---|---|---|
| `path` | `string` | File path relative to workspace root |
| `patch` | `string` | Unified diff patch string |

### Output

JSON: `{ success: true }` or `{ success: false, error }`.

---

## git-status

**Permission:** `safe`  
**File:** `src/tools/git-status.ts`

Returns the working-tree status of a Git repository. Equivalent to `git status --porcelain`.

### Inputs

| Field | Type | Default | Description |
|---|---|---|---|
| `cwd` | `string` | `process.cwd()` | Repository path |

### Output

JSON: `{ entries: [{ status, path }], isClean }`.

---

## git-log

**Permission:** `safe`  
**File:** `src/tools/git-log.ts`

Returns recent commit history. Equivalent to `git log --oneline`.

### Inputs

| Field | Type | Default | Description |
|---|---|---|---|
| `cwd` | `string` | `process.cwd()` | Repository path |
| `maxCount` | `number` | `20` | Maximum commits to return |

### Output

JSON: `{ commits: [{ hash, date, message, author_name, author_email }] }`.

---

## git-diff

**Permission:** `safe`  
**File:** `src/tools/git-diff.ts`

Returns the diff for a repository. Equivalent to `git diff [--cached] [-- <path>]`.

### Inputs

| Field | Type | Default | Description |
|---|---|---|---|
| `cwd` | `string` | `process.cwd()` | Repository path |
| `path` | `string` | — | Limit diff to this file or directory |
| `staged` | `boolean` | `false` | Show staged (cached) diff |

### Output

JSON: `{ diff: "<unified diff string>" }`.

---

## git-commit

**Permission:** `cautious`  
**File:** `src/tools/git-commit.ts`

Stages files and creates a Git commit. Equivalent to `git add <files> && git commit -m <message>`. When no files are specified, stages all changes (including untracked files).

### Inputs

| Field | Type | Required | Description |
|---|---|---|---|
| `message` | `string` | yes | Commit message |
| `files` | `string[]` | no | Files to stage (omit to stage all changes) |
| `cwd` | `string` | no | Repository path (defaults to `process.cwd()`) |

### Output

JSON: `{ success: true, commitHash, branch }` or `{ success: false, error }`.

### Example

```
git-commit({ message: "fix: correct calculation", files: ["src/tools/calculate.ts"] })
→ { success: true, commitHash: "a1b2c3d", branch: "main" }
```
