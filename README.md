<div align="center">

# Bluud CLI

**Your agent forgets everything when the session ends. This gives it a permanent memory.**

`bluud` installs the Bluud memory skill into your AI coding tools and keeps your project's memory in sync — automatically, across every tool, every session, every machine.

[bluud.dev](https://bluud.dev) · [Documentation](https://bluud.dev/docs)

</div>

---

Before Bluud, every session starts with an introduction — your stack, your conventions, the rule you agreed on last week, pasted in again. After Bluud, every session starts with a continuation. Your agent already knows the project before you send your first message.

Bluud stores your project's memory as a tree of plain Markdown in the cloud. The CLI is how that memory reaches your tools: one command installs the skill, and from then on your agent pulls the latest memory at the start of a session and pushes durable updates back when a conversation produces something worth keeping.

## Install

No install step. Run it with `npx` in any project:

```bash
npx bluud
```

This authenticates the machine, detects the AI tools in your project, installs the memory skill into each one, and registers the project. It's the only command you ever run by hand.

Requires **Node.js 20 or newer**.

## Commands

```bash
npx bluud              # Onboard the current directory (auth → detect → register → install)
npx bluud login        # Authenticate this machine
npx bluud logout       # Remove stored session credentials
npx bluud status       # Show project identity, token status, and memory size
npx bluud pull         # Fetch memory for the current project
npx bluud push         # Push a memory diff for the current project (reads JSON from stdin)
npx bluud sync         # Re-fetch the active project token
npx bluud rotate       # Rotate the project token (owner only)
npx bluud relink       # Re-link this directory to an existing project (e.g. a new machine)
npx bluud reassign     # Reassign this directory to a different owned project
npx bluud doctor       # Show what is configured per tool, without writing anything
npx bluud uninstall    # Remove the Bluud skill from selected tools
```

## How it works

**Identity is automatic.** Bluud identifies a project by its Git remote URL, falling back to the directory path when there's no remote. You never set a project ID by hand.

**Pull happens first.** At the start of a session your agent runs `bluud pull` and loads the project's full memory tree — rules, decisions, active tasks, preferences — before your first message is even sent.

**Push happens when it matters.** When a conversation produces something durable — a new convention, a resolved question, a completed task — your agent sends a minimal diff back. Quietly, without asking. Sessions that only produce code don't write anything.

**The memory is yours to read.** It's plain Markdown with YAML frontmatter — no proprietary format, no hidden state. Owners can browse, edit, and restore any version from the [dashboard](https://bluud.dev).

Tokens are stored under `~/.bluud/` on your machine and never checked into version control.

## Supported tools

The CLI installs the memory skill into the AI tools it finds in your project:

- Claude Code
- Codex
- Cursor
- Windsurf
- Aider
- GitHub Copilot

New tools are added as they reach adoption. When they are, your memory works on them too — without reinstalling anything.

## Development

```bash
npm install
npm run build      # bundle with tsup
npm test           # run the vitest suite
npm run lint       # eslint
npm run typecheck  # tsc --noEmit
```

## License

Released under the [MIT License](./LICENSE). Bluud CLI is part of the [Bluud](https://bluud.dev) platform.
