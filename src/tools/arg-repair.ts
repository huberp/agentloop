import { logger } from "../logger";
import type { ToolDefinition } from "./registry";

type RepairResult = {
  args: unknown;
  repaired: boolean;
  repairType?: "string_to_object" | "array_to_command_string" | "command_array_to_string";
};

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((v) => typeof v === "string");
}

function normalizeShellArgs(rawArgs: unknown): RepairResult {
  if (typeof rawArgs === "string") {
    return {
      args: { command: rawArgs },
      repaired: true,
      repairType: "string_to_object",
    };
  }

  if (isStringArray(rawArgs)) {
    return {
      args: { command: rawArgs.join(" ") },
      repaired: true,
      repairType: "array_to_command_string",
    };
  }

  if (rawArgs && typeof rawArgs === "object" && !Array.isArray(rawArgs)) {
    const obj = rawArgs as Record<string, unknown>;
    if (isStringArray(obj.command)) {
      return {
        args: { ...obj, command: obj.command.join(" ") },
        repaired: true,
        repairType: "command_array_to_string",
      };
    }
  }

  return { args: rawArgs, repaired: false };
}

type SchemaParser = { parse: (value: unknown) => unknown };

function getSchemaParser(definition: ToolDefinition | undefined): SchemaParser | undefined {
  if (!definition) return undefined;
  const schema = (definition as { schema?: unknown }).schema;
  if (!schema || typeof schema !== "object") return undefined;
  if (!("parse" in schema)) return undefined;
  const parser = (schema as { parse?: unknown }).parse;
  if (typeof parser !== "function") return undefined;
  return { parse: parser as (value: unknown) => unknown };
}

export function prepareToolArgs(toolName: string, rawArgs: unknown): unknown {
  if (toolName !== "shell") {
    return rawArgs;
  }

  const repaired = normalizeShellArgs(rawArgs);
  if (repaired.repaired) {
    logger.info(
      {
        toolName,
        repairType: repaired.repairType,
        receivedType: Array.isArray(rawArgs) ? "array" : typeof rawArgs,
      },
      "Repaired tool arguments before validation"
    );
  }
  return repaired.args;
}

export function validatePreparedToolArgs(
  definition: ToolDefinition | undefined,
  preparedArgs: unknown,
  originalArgs: unknown
): void {
  const parser = getSchemaParser(definition);
  if (!definition || !parser) {
    return;
  }

  try {
    parser.parse(preparedArgs);
  } catch (error) {
    const validationMessage = error instanceof Error ? error.message : String(error);
    if (definition.name === "shell") {
      const payload = {
        status: "invalid_input",
        reason: "Invalid shell tool input",
        retryable: true,
        expected: { command: "string" },
        example: { command: "npm run build" },
        receivedType: Array.isArray(originalArgs) ? "array" : typeof originalArgs,
        validationError: validationMessage,
      };
      throw new Error(JSON.stringify(payload));
    }

    throw new Error(
      `Invalid arguments for tool '${definition.name}'. ` +
        `Expected a JSON object that matches the tool schema. ` +
        `Validation error: ${validationMessage}`
    );
  }
}
