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

## 1. Read memory at the start of the session — index first, then load what's relevant

After the user's first message, once you have understood what they are actually
asking for, run:

```bash
bluud pull --inject --index
```

This prints a lightweight index: every node's `id`, an ancestor-title
breadcrumb, `updated_at`, and `description` — never a node's `body`. Scan it
for the entries relevant to the request in front of you, then load only those,
by id:

```bash
bluud pull --inject --id 550e8400-e29b-41d4-a716-446655440000 --id 6ba7b810-9dad-11d1-80b4-00c04fd430c8
```

`--id` is repeatable — pass it once per node you decide is relevant. This
prints each selected node's full `title`, `description`, and `body`, preceded
by its ancestor breadcrumb for orientation. Treat what it prints as
established context for this project and let it inform the work before you
continue.

**When to load the whole tree instead.** Some requests are genuinely
project-wide — "review the whole architecture," "audit every convention we've
recorded" — where scanning the index and picking a subset would mean picking
almost everything anyway. When you judge that's the case, run `bluud pull
--inject` with no other flags: this is the full-tree dump, unchanged, and
remains available exactly for this. It is the exception, not the default —
reach for the index-then-load workflow above first.

Three conditions where you skip all of this:

- **Memory is already in your context.** On tools that support lifecycle
  hooks, Bluud injects the full tree automatically before you see the first
  message. If a "Bluud project memory" section is already present, do not
  pull again.
- **The index shows nothing relevant.** Not every request touches recorded
  memory. Proceed without loading anything rather than loading nodes on the
  off chance they matter.
- **A command fails.** Proceed without memory and mention it once. A failed
  pull is never a reason to stop or to ask the user to fix something
  mid-request; the memory layer is not on the critical path of their task.

None of `--index`, `--id`, or plain `--inject` print a node's raw `document`
(the YAML-frontmatter-plus-body form `bluud push` expects) — they render
Markdown for reading. When you need to build an `update` diff, read the
node's current fields with `bluud pull --json` first (see section 3) and
reconstruct the `document` from those, not from anything `--inject` printed.

## 2. Decide, after each response, whether to write

Do not push after every response. After each response, ask whether the exchange
produced something a future session must not have to rediscover.

**Push when:**

- A new architectural rule, constraint, or convention was established.
- An ambiguity or previously open question was resolved.
- A task was completed, discovered, or explicitly cancelled.
- A meaningful problem, bug, or regression was root-caused and resolved —
  capture what broke, how it was discovered, the root cause, the fix, and why
  that fix is correct, so the next session inherits the diagnosis instead of
  re-deriving it.
- Substantial work landed in a domain the tree has no coverage of yet —
  architecture, infrastructure, workflows, engineering procedures, core
  project behavior, design decisions, or conventions — and that foundational
  knowledge would otherwise exist only in this session's context.
- A user preference or working convention was stated or changed.
- A decision was made that will shape future sessions.

**Do not push when:**

- The session produced code but no new rule or decision.
- The conversation explored options without reaching a conclusion.
- The exchange was informational — an explanation, a lookup, a debugging
  step that didn't surface anything reusable — with no durable outcome.
- A bug was fixed but the cause was mundane and unlikely to recur (a typo, a
  one-off environment slip) — not every fix is a lesson worth keeping.

The test is durability, not effort. A long debugging session that ends in "the
port was already in use" is not memory — nothing about it helps a future
session. One that ends in "the race was caused by X, fixed by Y" is, because
that diagnosis is exactly what the next session would otherwise redo. A
one-line "we use UTC everywhere in this codebase" is memory for the same
reason: it saves someone from rediscovering it.

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

- `bluud pull --inject --index` — lightweight index (id, breadcrumb,
  `updated_at`, description) for every node. Read this first.
- `bluud pull --inject --id <uuid>` — full content for one or more specific
  nodes (repeat `--id` for more than one). Read this second, for what the
  index says is relevant.
- `bluud pull --inject` — the full tree, every node's body. Use only when the
  whole tree is genuinely needed.
- `bluud pull --json` — full node objects including IDs, for building a diff.
- `bluud push` — apply a diff from stdin. Add `--json` for a machine-readable
  result.
- `bluud status` — project identity, role, memory size, quota.

Diagnostics and warnings go to stderr; stdout carries only the data. Piping
`bluud pull --json` into a parser is safe.
