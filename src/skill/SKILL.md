# Bluud Memory Skill

You are working in a project that uses **Bluud** for persistent, cross-session agent memory.

## What Bluud does

Bluud stores a structured memory tree for this project in the cloud. The tree is shared across all collaborators and all AI tools that support custom instructions. You automatically read the latest memory after the user's first message, once you have thoroughly understood the context of the request, and write back durable updates when the conversation produces something worth remembering.

## Your responsibilities

1. **Pull memory after the user's first message.**
   After the user's first message and after you have thoroughly understood the context of the request, run:

   ```bash
   bluud pull --inject
   ```

   The command prints the current memory tree as structured Markdown. Load everything it prints into the conversation context before continuing to work on the request.

2. **Evaluate after every response whether to push.**
   Do not push automatically after every response. Push only when the conversation has produced something durable, such as:
   - A new architectural rule, constraint, or convention.
   - A resolved ambiguity or previously open question.
   - A completed, discovered, or explicitly cancelled task.
   - A user preference or working convention that was stated or modified.
   - A significant decision that will affect future sessions.

   Do not push when:
   - The session only produced code without new rules or decisions.
   - The conversation was exploratory and reached no conclusion.
   - The exchange was informational (explanations, lookups, debugging steps) with no durable output.

3. **When pushing, send a minimal diff.**
   Build a `PATCH /memory/{project_id}` diff containing only new or changed nodes. Use valid Markdown with YAML frontmatter including `title` and `description`. Prefer updating an existing node over creating a duplicate. Run:

   ```bash
   bluud push
   ```

   The command reads the diff from stdin. Pipe the diff as JSON:

   ```bash
   echo '{"operations":[...]}' | bluud push
   ```

4. **Honor read-only state.**
   If a push returns `423 Locked` or a successful push reports `read_only: true`, stop pushing and tell the user the project memory is over quota. Pulls continue to work normally.

5. **Do not expose tokens.**
   The project token is stored in `~/.bluud/projects/{project_id}/token`. Read it from there. Never print it, never check it into version control, and never ask the user for it.

## Memory node format

Each node is Markdown with YAML frontmatter:

```markdown
---
title: "Architecture Decisions"
description: "Core architectural rules and decisions for this project"
parent: null
---

## Server / Client Boundary

...
```

`title` and `description` are required. `parent` is the title of the parent node, or `null` for a root node. `created_at` and `updated_at` are set by the server.
