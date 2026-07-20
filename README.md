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

## How it works

**Identity is automatic.** Bluud identifies a project by its Git remote URL, falling back to a hash of the directory path when there's no remote. You never set a project ID by hand.

**Pull happens first.** At the start of a session your agent runs `bluud pull` and loads the project's full memory tree — rules, decisions, active tasks, preferences — before your first message is even sent. On tools with lifecycle hooks (Claude Code, Codex, Gemini CLI, Antigravity, Kimi Code CLI, Cline) this is a real `SessionStart` hook Bluud writes into the tool's own config; everywhere else, the bundled skill instructs the agent to run `bluud pull --inject` itself.

**Push happens when it matters.** When a conversation produces something durable — a new convention, a resolved question, a completed task — your agent sends a minimal diff back with `bluud push`. Quietly, without asking. Sessions that only produce code don't write anything. Push is always agent-directed, on every tool, because deciding *whether* something is worth remembering is a judgment call no lifecycle hook can make — only pull is mechanical enough to automate.

**The memory is yours to read.** It's plain Markdown with YAML frontmatter — no proprietary format, no hidden state. Owners can browse, edit, and restore any version from the [dashboard](https://bluud.dev).

Tokens are stored under `~/.bluud/` on your machine and never checked into version control:

```
~/.bluud/auth.json                    session (or personal access token)
~/.bluud/projects/<project_id>/token  per-project shared memory token
```

## Command reference

Every command accepts `-h/--help`, `-v/--version`, `-V/--verbose` (debug logging), and `-q/--quiet` (errors only). `BLUUD_LOG` sets the log level directly; `BLUUD_API_URL` overrides the backend for local development.

### `bluud` (default command)

Onboard the current directory: authenticate, detect installed AI tools, register the project, install the skill, and configure lifecycle hooks. This is what runs when you invoke `bluud` with no subcommand.

```bash
npx bluud
npx bluud --yes                          # accept every prompt, non-interactive
npx bluud -a claude-code -a cursor       # only install into these tools
npx bluud --agents-skip windsurf         # install into everything detected except this
npx bluud --global                       # install to user-level dirs instead of the project
npx bluud --copy                         # force file copies instead of symlinks
npx bluud --dry-run                      # show what would change, write nothing
npx bluud --json                         # machine-readable summary for scripts
```

| Flag | Effect |
|---|---|
| `-y, --yes` | Accept all prompts; also implied by `CI`, `BLUUD_NON_INTERACTIVE`, `--json`, or running inside a detected AI agent. |
| `-a, --agent <name>` | Install into this tool only (repeatable). Skips detection/selection entirely. |
| `--agents-skip <name>` | Exclude a tool from the detected/selected set (repeatable). |
| `-g, --global` | Write to each tool's user-level config instead of the project directory. |
| `--copy` | Skip the canonical-skill-plus-symlink layout and copy files directly into each tool's directory. |
| `--dry-run` | Report what would be installed/written without touching disk. |
| `--token <PAT>` | Authenticate non-interactively with a personal access token instead of the browser flow. |
| `--json` | Emit a single JSON object (identity, project, detected/selected agents, skill install results, hook results) instead of formatted output. |

Auth: browser (or `--token`). Tier: free.

### `bluud login`

Authenticate this machine. Opens the default browser to the Bluud consent screen (OAuth 2.0 PKCE loopback) unless `--token <PAT>` is given.

```bash
npx bluud login
npx bluud login --token bluud_pat_...
```

Non-interactive shells (`CI`, `--yes`, no TTY) must pass `--token` — there is no headless browser fallback beyond printing the authorize URL when the OS can't launch a browser.

Auth: none required to run. Tier: free.

### `bluud logout`

Revoke the current session's refresh token server-side (skipped for a personal access token, which has none to revoke) and remove `~/.bluud/auth.json`. The local file is always cleared, even if the server-side revoke call fails.

```bash
npx bluud logout
```

Auth: none required. Tier: free.

### `bluud status`

Show this directory's project identity, role, memory size, quota usage, and local/remote token state.

```bash
npx bluud status
npx bluud status --json
```

Auth: session (login required — unlike `doctor`, this command fails outright if you're signed out). Tier: free.

### `bluud pull`

Fetch the current project's memory tree. Used by the skill/hook at session start; also useful standalone.

```bash
npx bluud pull                       # "Pulled N node(s), N bytes."
npx bluud pull --json                # full node objects, including IDs — needed to build a push diff
npx bluud pull --inject              # memory rendered as Markdown, for injecting into agent context
npx bluud pull --inject --format gemini   # Gemini CLI hook-output shape
npx bluud pull --inject --format cline    # Cline hook-output shape
```

`--format` only applies with `--inject` and only accepts `gemini` or `cline`; omit it for the default Markdown rendering used by every other tool. A quota warning (approaching the storage limit) prints to stderr regardless of format.

Auth: project token (no session/login needed — this is what the hook/skill calls on your behalf). Tier: free.

### `bluud push`

Send a memory diff for the current project. Reads a JSON payload from stdin — never called with arguments.

```bash
echo '{"operations":[{"op":"create","document":"---\ntitle: X\ndescription: Y\n---\n\nBody."}]}' | npx bluud push
npx bluud push --json
```

Each `operations[]` entry is `{"op": "create"|"update"|"delete", "id"?, "document"?}` — see the bundled skill (`src/skill/SKILL.md`) for the full node/frontmatter contract. A push that trips the storage quota is still committed; the project becomes read-only afterward and the CLI reports it as a warning, exit code 0 — it does not fail the agent's session. A push against an already-locked project reports the warning and does nothing, also exit code 0.

Auth: project token. Tier: free (subject to the read-only lock once quota is exceeded).

### `bluud sync`

Re-fetch the current active project token, overwriting the local copy. Use this after a teammate rotates the token, or when the local token file was lost.

```bash
npx bluud sync
```

Auth: session. Tier: paid.

### `bluud rotate`

Invalidate the project's current token and mint a new one, storing it locally. Every other collaborator must run `bluud sync` afterward — their old token stops working immediately.

```bash
npx bluud rotate
```

Auth: session, project owner only. Tier: paid.

### `bluud relink`

Attach the current directory to an existing project's identity and sync its token locally — the fix for "I cloned this repo on a new machine" or "the git remote changed."

```bash
npx bluud relink
```

Auth: session, any project member. Tier: paid.

### `bluud reassign`

Point the current directory at a *different* project you own, without changing the directory's own computed identity. Interactively prompts with your owned projects; non-interactively, pass the target project ID as the first positional argument.

```bash
npx bluud reassign
npx bluud reassign --yes 3f9a1c2b...
```

Auth: session, owner of the target project. Tier: paid.

### `bluud doctor`

Read-only diagnostic report: project identity, local token presence, detected AI tools and whether each has the skill installed, hook-adapter status per tool, and (when signed in) the same role/quota/token detail as `status`. Never writes anything — `--dry-run`/`--force` do not apply here because every check doctor performs already is one.

```bash
npx bluud doctor
npx bluud doctor --global
npx bluud doctor --json
```

Unlike `status`, `doctor` degrades gracefully rather than failing: it works before the project is registered and before you've signed in, reporting what it can from the local filesystem alone.

Auth: none required; enriches its output when a session is present. Tier: free.

### `bluud uninstall`

Remove the Bluud skill and any hook configuration from selected tools. Interactively multiselects (defaulting to all supported tools) unless `-a`/`--agents-skip` narrows the set.

```bash
npx bluud uninstall
npx bluud uninstall -a claude-code
npx bluud uninstall --dry-run
npx bluud uninstall --json
```

Auth: none required. Tier: free.

## Supported tools

The CLI natively detects and installs the memory skill into 73 AI coding tools — every probe and installer below runs in-process; nothing shells out to an external CLI to do it. Six get a real lifecycle hook (`SessionStart` runs `bluud pull --inject` automatically); the rest get the bundled skill's instructions, which tell the agent to pull and push itself. Several share the same `.agents/skills` convention, which Bluud's installer recognizes so it never tries to symlink that directory onto itself.

| Tool | Hook | Skill delivery |
|---|---|---|
| AdaL | — | `.adal/skills/bluud-memory` |
| Aider | — | not supported — Aider has no skills directory and loads no instruction file automatically; see `bluud doctor` for the exact manual step it prints |
| AiderDesk | — | `.aider-desk/skills/bluud-memory` |
| Amp | — | `.agents/skills/bluud-memory` |
| Antigravity | ✓ | `.agents/skills/bluud-memory` |
| Antigravity CLI | — | `.agents/skills/bluud-memory` |
| AstrBot | — | `data/skills/bluud-memory` |
| Augment | — | `.augment/skills/bluud-memory` |
| Autohand Code CLI | — | `.autohand/skills/bluud-memory` |
| Claude Code | ✓ | `.claude/skills/bluud-memory` |
| Cline | ✓ | `.agents/skills/bluud-memory` |
| Code Studio | — | `.codestudio/skills/bluud-memory` |
| CodeArts Agent | — | `.codeartsdoer/skills/bluud-memory` |
| CodeBuddy | — | `.codebuddy/skills/bluud-memory` |
| Codemaker | — | `.codemaker/skills/bluud-memory` |
| Codex | ✓ | `.agents/skills/bluud-memory` |
| Command Code | — | `.commandcode/skills/bluud-memory` |
| Continue | — | `.continue/skills/bluud-memory` |
| Cortex Code | — | `.cortex/skills/bluud-memory` |
| Crush | — | `.crush/skills/bluud-memory` |
| Cursor | — | `.agents/skills/bluud-memory` |
| Deep Agents | — | `.agents/skills/bluud-memory` |
| Devin for Terminal | — | `.devin/skills/bluud-memory` |
| Dexto | — | `.agents/skills/bluud-memory` |
| Droid | — | `.factory/skills/bluud-memory` |
| Eve | — | `agent/skills/bluud-memory` |
| Firebender | — | `.agents/skills/bluud-memory` |
| ForgeCode | — | `.forge/skills/bluud-memory` |
| Gemini CLI | ✓ | `.agents/skills/bluud-memory` |
| GitHub Copilot | — | `.agents/skills/bluud-memory` |
| Goose | — | `.goose/skills/bluud-memory` |
| Hermes Agent | — | `.hermes/skills/bluud-memory` |
| IBM Bob | — | `.bob/skills/bluud-memory` |
| iFlow CLI | — | `.iflow/skills/bluud-memory` |
| inference.sh | — | `.inferencesh/skills/bluud-memory` |
| Jazz | — | `.jazz/skills/bluud-memory` |
| Junie | — | `.junie/skills/bluud-memory` |
| Kilo Code | — | `.kilocode/skills/bluud-memory` |
| Kimi Code CLI | ✓ | `.agents/skills/bluud-memory` |
| Kiro CLI | — | `.kiro/skills/bluud-memory` |
| Kode | — | `.kode/skills/bluud-memory` |
| Lingma | — | `.lingma/skills/bluud-memory` |
| Loaf | — | `.agents/skills/bluud-memory` |
| MCPJam | — | `.mcpjam/skills/bluud-memory` |
| Mistral Vibe | — | `.vibe/skills/bluud-memory` |
| Moxby | — | `.moxby/skills/bluud-memory` |
| Mux | — | `.mux/skills/bluud-memory` |
| Neovate | — | `.neovate/skills/bluud-memory` |
| Ona | — | `.ona/skills/bluud-memory` |
| OpenClaw | — | `skills/bluud-memory` |
| OpenCode | — | `.agents/skills/bluud-memory` |
| OpenHands | — | `.openhands/skills/bluud-memory` |
| Pi | — | `.pi/skills/bluud-memory` |
| Pochi | — | `.pochi/skills/bluud-memory` |
| PromptScript | — | `.agents/skills/bluud-memory` |
| Qoder | — | `.qoder/skills/bluud-memory` |
| Qoder CN | — | `.qoder/skills/bluud-memory` |
| Qwen Code | — | `.qwen/skills/bluud-memory` |
| Reasonix | — | `.reasonix/skills/bluud-memory` |
| Replit | — | `.agents/skills/bluud-memory` |
| Roo Code | — | `.roo/skills/bluud-memory` |
| Rovo Dev | — | `.rovodev/skills/bluud-memory` |
| Tabnine CLI | — | `.tabnine/agent/skills/bluud-memory` |
| Terramind | — | `.terramind/skills/bluud-memory` |
| Tinycloud | — | `.tinycloud/skills/bluud-memory` |
| Trae | — | `.trae/skills/bluud-memory` |
| Trae CN | — | `.trae/skills/bluud-memory` |
| Warp | — | `.agents/skills/bluud-memory` |
| Windsurf | — | `.windsurf/skills/bluud-memory` |
| ZCode | — | `.zcode/skills/bluud-memory` |
| Zed | — | `.agents/skills/bluud-memory` |
| Zencoder | — | `.zencoder/skills/bluud-memory` |
| Zenflow | — | `.zencoder/skills/bluud-memory` |

New tools are added natively, as entries in Bluud's own agent registry (`src/lib/agentRegistry.ts`) — reproducing a new tool's detection and skill-directory convention as data, not a runtime dependency on anything external. When one is added, your memory works on it too — without reinstalling anything.

## Attribution — patterns reproduced, not files copied

Two open-source projects shaped this CLI's design, and neither of their source trees — nor any runtime dependency on either — ships inside `bluud`:

- **[`vercel-labs/skills`](https://github.com/vercel-labs/skills)** (MIT) has no runtime dependency here at all. It is a Node/TypeScript CLI, but its `package.json` ships no `exports`/`main`, so it was never importable as a library — an earlier version of this CLI worked around that by shelling out to it as a subprocess (`npx skills add …`) instead. That subprocess dependency has since been removed entirely: its ~73-tool agent registry (detection probes and per-tool skill-directory conventions) and its canonical-copy-plus-symlink installer strategy (including the "universal agents don't get symlinked onto themselves" rule) were **studied from its TypeScript source and reimplemented from scratch as native Bluud code** (`src/lib/agentRegistry.ts`, `src/lib/skills.ts`). No file, string, or dependency from `vercel-labs/skills` is imported, vendored, embedded, or shelled out to at runtime — `bluud` never invokes `npx skills` or any other external process to detect or install a skill.
- **[`zzet/gortex`](https://github.com/zzet/gortex)** (Apache-2.0) has no analogous runtime dependency either: `gortex` is a Go binary with no Node/TypeScript surface to call into. What Bluud adopted from it is architectural — the `Detect → Plan → Apply` adapter contract, marker-guarded idempotent config merging, and atomic-write-plus-rename — all **studied from its Go source and reimplemented from scratch in TypeScript** (`src/lib/adapters/`). No Go source, string, or file from `gortex` appears in this package.

`BLUUD_CLI_ARCHITECTURE.md` (in the main Bluud repository) is the design document recording exactly which pattern came from which file in each reference project, with source-level citations, for anyone auditing this attribution.

## Development

```bash
npm install
npm run build      # bundle with tsup
npm test           # run the vitest suite
npm run test:e2e   # end-to-end suite (vitest.e2e.config.ts)
npm run lint       # eslint
npm run typecheck  # tsc --noEmit
```

## License

Released under the [MIT License](./LICENSE). Bluud CLI is part of the [Bluud](https://bluud.dev) platform.
