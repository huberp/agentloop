/**
 * file-search — alias for code-search.
 *
 * LLMs frequently use the name "file-search" when asked to look for code or
 * files in the workspace.  This re-exports the full code-search implementation
 * under that alternative name so both names resolve to the same tool.
 */
import { toolDefinition as codeDef } from "./code-search";

export const toolDefinition = {
  ...codeDef,
  name: "file-search",
  description:
    "Search files in the workspace using a literal string, regular expression, or file-name glob. " +
    "Returns matching lines with file path, line/column numbers, and surrounding context. " +
    "(Alias for code-search — both names work identically.)",
};
