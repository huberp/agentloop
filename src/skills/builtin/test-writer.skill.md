---
name: test-writer
description: Jest/Vitest testing conventions, AAA structure, mocking strategies
version: 1.0.0
slot: section
---

## Test Writing Guidelines

- **AAA structure**: every test follows Arrange → Act → Assert with a blank line between each phase; keep each test focused on a single behaviour.
- **Descriptive names**: use `it("does X when Y")` format; the test name must be understandable without reading the body.
- **Mock at the boundary**: mock external services, file systems, and clocks — never mock the unit under test itself.
- **Use `beforeEach` for setup**, not `beforeAll`, unless the setup is truly idempotent and cheap; always clean up in `afterEach`.
- **Avoid snapshot tests** for business logic — prefer explicit `expect(result).toEqual(...)` assertions that document intent.
- **Coverage targets**: aim for 100% of public API branches; uncovered lines in error paths are the highest-risk bugs.
