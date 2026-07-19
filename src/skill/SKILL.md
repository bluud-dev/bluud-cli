---
name: bluud-memory
description: Persistent project memory for this repository, shared across every AI tool and every session. Read it at the start of a session so you know the project's established rules, decisions, and open work before you act; write back to it when a session produces a durable rule, decision, resolved ambiguity, task change, or stated preference. Use whenever you need to know what was already decided here, or when you have just decided something that the next session must not have to rediscover.
license: MIT
---

# Bluud memory

This project stores its agent memory in Bluud: a structured tree of Markdown
nodes, shared by every collaborator and every AI tool working on this
repository. You read it at the start of a session and write back to it when a
session produces something durable.

Memory is reached through the `bluud` CLI, which holds the project's identity
and credentials. You never call the API directly and never handle the token.

## 1. Read memory at the start of the session

After the user's first message, once you have understood what they are actually
asking for, run:

```bash
bluud pull --inject
```

This prints the memory tree as Markdown. Treat everything it prints as
established context for this project and let it inform the work before you
continue.

Two conditions where you skip this:

- **Memory is already in your context.** On tools that support lifecycle hooks,
  Bluud injects the tree automatically before you see the first message. If a
  "Bluud project memory" section is already present, do not pull again.
- **The command fails.** Proceed without memory and mention it once. A failed
  pull is never a reason to stop or to ask the user to fix something
  mid-request; the memory layer is not on the critical path of their task.

`bluud pull --inject` prints titles, descriptions, and bodies — it does not
print node IDs. When you need IDs (any update or delete), use `bluud pull
--json`, which returns the full node objects including `id` and `parent_id`.

## 2. Decide, after each response, whether to write

Do not push after every response. After each response, ask whether the exchange
produced something a future session must not have to rediscover.

**Push when:**

- A new architectural rule, constraint, or convention was established.
- An ambiguity or previously open question was resolved.
- A task was completed, discovered, or explicitly cancelled.
- A user preference or working convention was stated or changed.
- A decision was made that will shape future sessions.

**Do not push when:**

- The session produced code but no new rule or decision.
- The conversation explored options without reaching a conclusion.
- The exchange was informational — an explanation, a lookup, a debugging
  step — with no durable outcome.

The test is durability, not effort. A long debugging session that ends in "the
port was already in use" is not memory. A one-line "we use UTC everywhere in
this codebase" is.

## 3. Write a minimal diff

`bluud push` reads a JSON object on stdin and sends only what changed — never
the whole tree:

```bash
echo '{"operations":[{"op":"update","id":"550e8400-e29b-41d4-a716-446655440000","document":"---\ntitle: Architecture\ndescription: Core architectural rules\n---\n\nAll timestamps are stored in UTC."}]}' | bluud push
```

Each entry in `operations` is one of:

| `op`     | `id`     | `document` | Effect                                               |
| -------- | -------- | ---------- | ---------------------------------------------------- |
| `create` | optional | required   | Adds a node. Omit `id` to let the server assign one. |
| `update` | required | required   | Replaces that node's frontmatter and body wholesale. |
| `delete` | required | —          | Removes that node.                                   |

`update` is a **replacement**, not a merge: the document you send becomes the
node in full. Read the node first (`bluud pull --json`) and send the complete
new content, or you will silently drop the parts you left out.

Prefer updating an existing node over creating a near-duplicate. A tree of
twenty focused nodes is useful; a tree of two hundred overlapping ones is not.

### Node documents

A `document` is Markdown with YAML frontmatter:

```markdown
---
title: Architecture Decisions
description: Core architectural rules and constraints for this project
parent: 550e8400-e29b-41d4-a716-446655440000
---

## Server / client boundary

Rendering happens on the server. Client components are opt-in and must declare
why they need to be.
```

- `title` — required, non-empty.
- `description` — required, non-empty. One line on what this node holds; it is
  what a future session reads first when scanning the tree.
- `parent` — optional. The **UUID** of the parent node, not its title. Omit it
  (or set it to `null`) for a root node.

To build a parent and its children in a single push, assign the parent an
explicit `id` in its `create` and reference that same UUID as the children's
`parent`. The server validates the resulting tree as a whole, so the order of
operations within one push does not matter.

## 4. Handle the read-only state

A project whose memory exceeds its storage quota is placed in a read-only
state. Pulls keep working; writes are rejected.

- `bluud push` reports `Warning: ... read-only` and exits successfully when the
  project is already locked. Nothing was written.
- A push that _causes_ the lock is still committed, and the output says so.

When you see either, stop pushing for the rest of the session and tell the user
once that Bluud memory is over quota. Do not retry, and do not start deleting
nodes to make room unless the user asks you to.

## 5. Never handle the token

The project token lives at `~/.bluud/projects/<project_id>/token` and is read by
the CLI, not by you. Never print it, never copy it into a file, never commit it,
and never ask the user for it. If a command reports that authentication is
missing, tell the user to run `bluud` in this directory — that is the whole fix.

## Reference

- `bluud pull --inject` — memory as Markdown, for reading.
- `bluud pull --json` — full node objects including IDs, for building a diff.
- `bluud push` — apply a diff from stdin. Add `--json` for a machine-readable
  result.
- `bluud status` — project identity, role, memory size, quota.

Diagnostics and warnings go to stderr; stdout carries only the data. Piping
`bluud pull --json` into a parser is safe.
