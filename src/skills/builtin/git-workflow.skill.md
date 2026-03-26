---
name: git-workflow
description: Conventional commits, branching strategy, PR hygiene
version: 1.0.0
slot: section
---

## Git Workflow Guidelines

- **Conventional commits**: use `feat:`, `fix:`, `chore:`, `docs:`, `refactor:`, `test:`, `perf:` prefixes; include scope in parens when relevant: `feat(auth): add OAuth2 support`.
- **Atomic commits**: each commit should compile, pass tests, and represent a single logical change; never mix formatting and logic in the same commit.
- **Branching**: use `feature/<ticket>-<slug>`, `fix/<ticket>-<slug>`, `release/<semver>` naming; always branch from `main` and keep branches short-lived.
- **PR descriptions**: include "Why" (motivation), "What" (summary of changes), "How to test", and links to related issues/tickets.
- **Rebase over merge** to maintain a linear history; squash fixup commits before merging; never force-push to shared branches.
- **Tag releases** with semver (`v1.2.3`) immediately after merging the release branch; include a changelog entry in the tag message.
