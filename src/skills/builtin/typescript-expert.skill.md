---
name: typescript-expert
description: TypeScript strict mode idioms and modern patterns
version: 1.0.0
slot: section
---

## TypeScript Expert Guidance

- **Prefer explicit types** over `any` and `unknown` unless truly necessary; use `satisfies` for type-safe assertions without widening.
- **Use utility types** (`Partial<T>`, `Required<T>`, `Pick<T>`, `Omit<T>`, `ReturnType<T>`, `Parameters<T>`) to avoid repeating type definitions.
- **Favour `const` assertions** (`as const`) for literal types and readonly tuples; combine with template literal types for string-union APIs.
- **Strict null checks**: always handle `undefined`/`null` explicitly; use optional chaining (`?.`) and nullish coalescing (`??`) over truthy/falsy guards.
- **Avoid `!` non-null assertions** in production code; use type narrowing (`if (x !== undefined)`) or early returns instead.
- **Keep interfaces and types module-local** unless there is a concrete reason to export; exported types form the public API contract.
