import * as fs from "fs";
import * as path from "path";
import * as os from "os";

// Mock appConfig and logger before imports
jest.mock("../config", () => ({
  appConfig: {
    systemPromptPath: "",
    logger: { level: "silent", enabled: false, destination: "stdout", name: "test", timestamp: false },
  },
}));

const mockLogger = { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() };
jest.mock("../logger", () => ({ logger: mockLogger }));

import { PromptRegistry, type PromptTemplate } from "../prompts/registry";
import { getSystemPrompt } from "../prompts/system";
import { promptRegistry as singletonRegistry } from "../prompts/registry";

// --------------------------------------------------------------------------
// Helpers
// --------------------------------------------------------------------------

let tmpDir: string;

function writeFile(relativePath: string, content: string): string {
  const full = path.join(tmpDir, relativePath);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content, "utf-8");
  return full;
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "prompt-reg-test-"));
  mockLogger.warn.mockClear();
  mockLogger.debug.mockClear();
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// --------------------------------------------------------------------------
// register / get / list
// --------------------------------------------------------------------------

describe("PromptRegistry — register, get, list", () => {
  it("registers and retrieves a template by name", () => {
    const reg = new PromptRegistry();
    const tpl: PromptTemplate = {
      name: "greeting",
      description: "A greeting",
      template: "Hello {{name}}!",
      variables: ["name"],
    };
    reg.register(tpl);
    expect(reg.get("greeting")).toBe(tpl);
  });

  it("list returns all registered templates", () => {
    const reg = new PromptRegistry();
    reg.register({ name: "a", description: "", template: "", variables: [] });
    reg.register({ name: "b", description: "", template: "", variables: [] });
    expect(reg.list().map((t) => t.name).sort()).toEqual(["a", "b"]);
  });

  it("returns undefined for unregistered name", () => {
    const reg = new PromptRegistry();
    expect(reg.get("nonexistent")).toBeUndefined();
  });

  it("overwrites existing template with the same name", () => {
    const reg = new PromptRegistry();
    reg.register({ name: "x", description: "v1", template: "old", variables: [] });
    reg.register({ name: "x", description: "v2", template: "new", variables: [] });
    expect(reg.get("x")!.template).toBe("new");
    expect(reg.list()).toHaveLength(1);
  });
});

// --------------------------------------------------------------------------
// render — variable interpolation
// --------------------------------------------------------------------------

describe("PromptRegistry — variable interpolation", () => {
  it("interpolates {{variable}} with string values", () => {
    const reg = new PromptRegistry();
    reg.register({ name: "t", description: "", template: "Hi {{name}}, your age is {{age}}.", variables: ["name", "age"] });
    expect(reg.render("t", { name: "Alice", age: "30" })).toBe("Hi Alice, your age is 30.");
  });

  it("interpolates array values as comma-separated strings", () => {
    const reg = new PromptRegistry();
    reg.register({ name: "t", description: "", template: "Tools: {{tools}}", variables: ["tools"] });
    expect(reg.render("t", { tools: ["file-read", "shell"] })).toBe("Tools: file-read, shell");
  });

  it("renders undefined variables as empty strings and logs a warning", () => {
    const reg = new PromptRegistry();
    reg.register({ name: "t", description: "", template: "A {{missing}} B", variables: ["missing"] });
    const result = reg.render("t", {});
    expect(result).toBe("A  B");
    expect(mockLogger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ variable: "missing" }),
      expect.stringContaining("not found"),
    );
  });

  it("handles templates with no variables", () => {
    const reg = new PromptRegistry();
    reg.register({ name: "t", description: "", template: "Static text", variables: [] });
    expect(reg.render("t")).toBe("Static text");
  });

  it("handles whitespace inside braces: {{ name }}", () => {
    const reg = new PromptRegistry();
    reg.register({ name: "t", description: "", template: "Hi {{ name }}", variables: ["name"] });
    expect(reg.render("t", { name: "Bob" })).toBe("Hi Bob");
  });

  it("throws when template name is not found", () => {
    const reg = new PromptRegistry();
    expect(() => reg.render("unknown")).toThrow('Prompt template "unknown" not found');
  });
});

// --------------------------------------------------------------------------
// render — partial inclusion
// --------------------------------------------------------------------------

describe("PromptRegistry — partial inclusion", () => {
  it("expands {{> partialName}} from inline partials", () => {
    const reg = new PromptRegistry();
    reg.register({
      name: "t",
      description: "",
      template: "A {{> mid}} C",
      variables: [],
      partials: { mid: "B" },
    });
    expect(reg.render("t")).toBe("A B C");
  });

  it("expands {{> partialName}} from a registered template", () => {
    const reg = new PromptRegistry();
    reg.register({ name: "header", description: "", template: "HEADER", variables: [] });
    reg.register({ name: "page", description: "", template: "{{> header}}\nBody", variables: [] });
    expect(reg.render("page")).toBe("HEADER\nBody");
  });

  it("inline partials take precedence over registered templates", () => {
    const reg = new PromptRegistry();
    reg.register({ name: "footer", description: "", template: "registered-footer", variables: [] });
    reg.register({
      name: "page",
      description: "",
      template: "{{> footer}}",
      variables: [],
      partials: { footer: "inline-footer" },
    });
    expect(reg.render("page")).toBe("inline-footer");
  });

  it("partials can contain variable interpolation", () => {
    const reg = new PromptRegistry();
    reg.register({
      name: "t",
      description: "",
      template: "{{> greeting}}",
      variables: ["name"],
      partials: { greeting: "Hello {{name}}!" },
    });
    expect(reg.render("t", { name: "Eve" })).toBe("Hello Eve!");
  });

  it("renders unknown partials as empty strings and logs a warning", () => {
    const reg = new PromptRegistry();
    reg.register({ name: "t", description: "", template: "A {{> unknown}} B", variables: [] });
    const result = reg.render("t");
    expect(result).toBe("A  B");
    expect(mockLogger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ partialName: "unknown" }),
      expect.stringContaining("not found"),
    );
  });

  it("handles whitespace inside partial braces: {{> name }}", () => {
    const reg = new PromptRegistry();
    reg.register({ name: "t", description: "", template: "{{>  mid  }}", variables: [], partials: { mid: "X" } });
    expect(reg.render("t")).toBe("X");
  });
});

// --------------------------------------------------------------------------
// loadFromDirectory
// --------------------------------------------------------------------------

describe("PromptRegistry — loadFromDirectory", () => {
  it("loads .md files and registers them using filename as name", async () => {
    writeFile("greeting.md", "Hello World");
    const reg = new PromptRegistry();
    await reg.loadFromDirectory(tmpDir);
    expect(reg.get("greeting")).toBeDefined();
    expect(reg.get("greeting")!.template).toBe("Hello World");
  });

  it("loads .txt files", async () => {
    writeFile("note.txt", "A note");
    const reg = new PromptRegistry();
    await reg.loadFromDirectory(tmpDir);
    expect(reg.get("note")).toBeDefined();
  });

  it("ignores non-.md/.txt files", async () => {
    writeFile("data.json", '{"key":"value"}');
    writeFile("script.ts", "console.log()");
    const reg = new PromptRegistry();
    await reg.loadFromDirectory(tmpDir);
    expect(reg.list()).toHaveLength(0);
  });

  it("uses frontmatter name when provided", async () => {
    writeFile("file.md", "---\nname: custom-name\ndescription: A custom template\n---\nBody text");
    const reg = new PromptRegistry();
    await reg.loadFromDirectory(tmpDir);
    expect(reg.get("custom-name")).toBeDefined();
    expect(reg.get("custom-name")!.description).toBe("A custom template");
  });

  it("parses comma-separated variables from frontmatter", async () => {
    writeFile("tpl.md", "---\nvariables: foo, bar, baz\n---\n{{foo}} {{bar}} {{baz}}");
    const reg = new PromptRegistry();
    await reg.loadFromDirectory(tmpDir);
    const tpl = reg.get("tpl")!;
    expect(tpl.variables).toEqual(["foo", "bar", "baz"]);
  });

  it("parses comma-separated tags from frontmatter", async () => {
    writeFile("tpl.md", "---\ntags: core, system\n---\nBody");
    const reg = new PromptRegistry();
    await reg.loadFromDirectory(tmpDir);
    expect(reg.get("tpl")!.tags).toEqual(["core", "system"]);
  });

  it("does not throw when directory does not exist", async () => {
    const reg = new PromptRegistry();
    await expect(reg.loadFromDirectory("/non/existent/dir")).resolves.not.toThrow();
  });
});

// --------------------------------------------------------------------------
// Singleton export
// --------------------------------------------------------------------------

describe("promptRegistry singleton", () => {
  it("is an instance of PromptRegistry", () => {
    expect(singletonRegistry).toBeInstanceOf(PromptRegistry);
  });
});

// --------------------------------------------------------------------------
// getSystemPrompt — backward compatibility via registry
// --------------------------------------------------------------------------

describe("getSystemPrompt — uses PromptRegistry", () => {
  it("returns a prompt containing tool names", async () => {
    const prompt = await getSystemPrompt({ tools: ["search", "calculate"] });
    expect(prompt).toContain("search");
    expect(prompt).toContain("calculate");
  });

  it("includes agent identity", async () => {
    const prompt = await getSystemPrompt();
    expect(prompt).toMatch(/assistant/i);
  });

  it("includes 'no tools' when tools array is empty", async () => {
    const prompt = await getSystemPrompt({ tools: [] });
    expect(prompt).toMatch(/no tools/i);
  });

  it("includes projectInfo", async () => {
    const prompt = await getSystemPrompt({ projectInfo: "My project" });
    expect(prompt).toContain("My project");
  });

  it("includes behavioral instructions", async () => {
    const prompt = await getSystemPrompt();
    expect(prompt).toMatch(/concise|honest|precise|tool/i);
  });

  it("renders via the prompt registry (system template is registered)", async () => {
    await getSystemPrompt();
    // After a call, the "system" template should exist in the singleton registry
    expect(singletonRegistry.get("system")).toBeDefined();
  });
});
