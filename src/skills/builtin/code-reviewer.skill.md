---
name: code-reviewer
description: Systematic code review checklist for correctness, quality, and security
version: 1.0.0
slot: section
---

## Code Review Checklist

- **Correctness**: Verify the implementation matches the stated requirements; check edge cases (empty input, null, max values, concurrent access).
- **Readability**: Names and structure should communicate intent without comments; extract magic numbers and long conditionals into named constants/functions.
- **Performance**: Flag O(n²) loops on unbounded data, unnecessary re-renders, synchronous blocking I/O, and large in-memory collections.
- **Security**: Check for injection risks (SQL, command, path traversal), hardcoded secrets, missing input validation, and over-permissioned access.
- **Test coverage**: Every public function should have at least one happy-path and one error-path test; mocks must reflect real interface contracts.
- **Error handling**: Errors must be caught at the appropriate boundary, logged with structured context, and translated to domain errors rather than leaked raw stack traces.
