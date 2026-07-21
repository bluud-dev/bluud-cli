/**
 * The single native registry of every AI coding tool Bluud can detect and
 * deliver its skill into.
 *
 * This reproduces the mechanics of `vercel-labs/skills`' agent registry
 * (`vendor/skills/src/agents.ts`, ~73 entries) as Bluud's own data, the same
 * way `BLUUD_CLI_ARCHITECTURE.md` §1.4 already treats `zzet/gortex`: studied
 * from source, reimplemented from scratch, with source-level citations for
 * every entry. No file, string, or code from `vercel-labs/skills` is
 * imported, vendored, or embedded here, and nothing in Bluud shells out to it
 * at runtime — every detection probe and target directory below is native
 * TypeScript that runs in-process.
 *
 * This module is the *only* place this data lives. Three other modules used
 * to each keep their own partial, occasionally inconsistent copy of it:
 * `skills.ts`'s `skillRegistry()` (9 entries), `detect.ts`'s
 * `DIRECTORY_PROBES`/`COMMAND_PROBES` (9 entries), and the `SUPPORTED_AGENTS`
 * arrays hand-duplicated across `install.ts`/`doctor.ts`/`uninstall.ts` (10
 * entries each). `uninstall.ts` additionally had its own, separately
 * maintained `skillTargets()` map that had drifted to naming *instruction
 * files* (`.cursor/rules/bluud-memory.mdc`, `.windsurfrules`, `AIDER.md`,
 * `.github/copilot-instructions.md`) for four tools whose actual skill target
 * is a *directory* — the exact "directory shadows the file the tool reads"
 * bug `skills.ts`'s own header comment warns about. Routing every caller
 * through this one registry removes that class of drift entirely.
 *
 * `aider` is deliberately absent from `AGENTS`: verified against
 * https://aider.chat/docs/usage/conventions.html, it has no skills directory
 * and loads no instruction file automatically — a conventions file reaches it
 * only via an explicit `--read` flag or a `read:` entry in `.aider.conf.yml`.
 * It is correspondingly absent from `skills`' own registry too (only the
 * separate `aider-desk` — a different, real product with a real skills
 * directory — appears there). Bluud still offers `aider` in its own
 * supported-tools list (see `supportedAgentNames` below) so `doctor`/`install`
 * can explain *why* it is unreachable rather than silently omitting it; see
 * `skillDeliveryUnsupportedReason` in `skills.ts`.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import os from "node:os";
import { commandExists } from "./skills.js";
import { claudeHome, codexHome } from "./agentHomes.js";

/**
 * Every one of these is resolved fresh on each call rather than cached at
 * module load: several tests stub `os.homedir()` or the relevant env var
 * per-test, and a module-level constant computed once at import time would
 * never see those overrides. This mirrors how `agentHomes.ts`'s
 * `claudeHome()`/`codexHome()` already work.
 */
function home(): string {
  return os.homedir();
}

/**
 * `vendor/skills/src/agents.ts` resolves this via the `xdg-basedir` package,
 * whose whole point (per that file's own comment: "Use xdg-basedir (not
 * env-paths) to match OpenCode/Amp/Goose behavior on all platforms") is to
 * *not* branch on OS — just `XDG_CONFIG_HOME` or `~/.config`, even on
 * Windows. Reproduced natively here without adding the dependency: the
 * behavior is one line once you know that's the intended contract.
 */
function configHome(): string {
  return process.env.XDG_CONFIG_HOME?.trim() || join(home(), ".config");
}

function vibeHome(): string {
  return process.env.VIBE_HOME?.trim() || join(home(), ".vibe");
}

function hermesHome(): string {
  return process.env.HERMES_HOME?.trim() || join(home(), ".hermes");
}

function autohandHome(): string {
  return process.env.AUTOHAND_HOME?.trim() || join(home(), ".autohand");
}

/**
 * Whether `packageJsonPath` declares `dependencyName` in `dependencies` or
 * `devDependencies`. Used only by `eve`'s detector below, which is real
 * enough upstream that a directory named `agent/` is not sufficient signal by
 * itself (plenty of unrelated projects have one).
 */
function packageJsonHasDependency(packageJsonPath: string, dependencyName: string): boolean {
  try {
    const parsed = JSON.parse(readFileSync(packageJsonPath, "utf8")) as {
      dependencies?: Record<string, unknown>;
      devDependencies?: Record<string, unknown>;
    };
    return Boolean(
      parsed.dependencies?.[dependencyName] ?? parsed.devDependencies?.[dependencyName],
    );
  } catch {
    return false;
  }
}

/**
 * OpenClaw has rebranded twice; the global skills directory lives under
 * whichever of the three home directories actually exists, defaulting to the
 * current name when none does (a fresh install with nothing on disk yet).
 */
function openClawGlobalSkillsDir(): string {
  if (existsSync(join(home(), ".openclaw"))) return join(home(), ".openclaw", "skills");
  if (existsSync(join(home(), ".clawdbot"))) return join(home(), ".clawdbot", "skills");
  if (existsSync(join(home(), ".moltbot"))) return join(home(), ".moltbot", "skills");
  return join(home(), ".openclaw", "skills");
}

/** ZCode's only installed-detection signal upstream is these two paths. */
function isZCodeInstalled(): boolean {
  return existsSync(join(home(), ".zcode")) || existsSync("/Applications/ZCode.app");
}

export interface AgentDefinition {
  /** Registry key, identical to `skills`' own `AgentType` string — no reason
   * to diverge from an already-sensible, widely recognized naming scheme. */
  name: string;
  displayName: string;
  /** Directory (relative to the project root) that holds skill
   * sub-directories: the install writes `<dir>/<skill-name>/SKILL.md`. */
  projectSkillsDir: string;
  /** Resolves the absolute user-level equivalent, or `null` when the tool has
   * no global installation surface at all (`eve`, `promptscript`). A function
   * because several entries depend on an env-var override read at call time,
   * not at module-load time (matters for tests that stub the environment). */
  globalSkillsDir: (() => string) | null;
  /** Read-only probe for whether this tool is installed on this machine. */
  detect: () => Promise<boolean>;
}

async function existsAsync(path: string): Promise<boolean> {
  return existsSync(path);
}

/**
 * The full native agent registry. Every entry below was verified against the
 * corresponding record in `vendor/skills/src/agents.ts` at the time of
 * writing; entries sharing `.agents/skills` are the "universal" tools (see
 * `isUniversalAgent` below) that already read the canonical install directory
 * directly.
 */
export const AGENTS: Record<string, AgentDefinition> = {
  "aider-desk": {
    name: "aider-desk",
    displayName: "AiderDesk",
    projectSkillsDir: ".aider-desk/skills",
    globalSkillsDir: () => join(home(), ".aider-desk", "skills"),
    detect: () => existsAsync(join(home(), ".aider-desk")),
  },
  amp: {
    name: "amp",
    displayName: "Amp",
    projectSkillsDir: ".agents/skills",
    globalSkillsDir: () => join(configHome(), "agents", "skills"),
    detect: () => existsAsync(join(configHome(), "amp")),
  },
  antigravity: {
    name: "antigravity",
    displayName: "Antigravity",
    projectSkillsDir: ".agents/skills",
    globalSkillsDir: () => join(home(), ".gemini", "antigravity", "skills"),
    detect: () => existsAsync(join(home(), ".gemini", "antigravity")),
  },
  "antigravity-cli": {
    name: "antigravity-cli",
    displayName: "Antigravity CLI",
    projectSkillsDir: ".agents/skills",
    globalSkillsDir: () => join(home(), ".gemini", "antigravity-cli", "skills"),
    detect: () => existsAsync(join(home(), ".gemini", "antigravity-cli")),
  },
  astrbot: {
    name: "astrbot",
    displayName: "AstrBot",
    projectSkillsDir: "data/skills",
    globalSkillsDir: () => join(home(), ".astrbot", "data", "skills"),
    detect: async () =>
      existsSync(join(process.cwd(), "data", "skills")) || existsSync(join(home(), ".astrbot")),
  },
  "autohand-code": {
    name: "autohand-code",
    displayName: "Autohand Code CLI",
    projectSkillsDir: ".autohand/skills",
    globalSkillsDir: () => join(autohandHome(), "skills"),
    detect: () => existsAsync(autohandHome()),
  },
  augment: {
    name: "augment",
    displayName: "Augment",
    projectSkillsDir: ".augment/skills",
    globalSkillsDir: () => join(home(), ".augment", "skills"),
    detect: () => existsAsync(join(home(), ".augment")),
  },
  bob: {
    name: "bob",
    displayName: "IBM Bob",
    projectSkillsDir: ".bob/skills",
    globalSkillsDir: () => join(home(), ".bob", "skills"),
    detect: () => existsAsync(join(home(), ".bob")),
  },
  "claude-code": {
    name: "claude-code",
    displayName: "Claude Code",
    projectSkillsDir: ".claude/skills",
    globalSkillsDir: () => join(claudeHome(), "skills"),
    detect: () => existsAsync(claudeHome()),
  },
  openclaw: {
    name: "openclaw",
    displayName: "OpenClaw",
    projectSkillsDir: "skills",
    globalSkillsDir: () => openClawGlobalSkillsDir(),
    detect: async () =>
      existsSync(join(home(), ".openclaw")) ||
      existsSync(join(home(), ".clawdbot")) ||
      existsSync(join(home(), ".moltbot")),
  },
  cline: {
    name: "cline",
    displayName: "Cline",
    projectSkillsDir: ".agents/skills",
    globalSkillsDir: () => join(home(), ".agents", "skills"),
    detect: () => existsAsync(join(home(), ".cline")),
  },
  "codearts-agent": {
    name: "codearts-agent",
    displayName: "CodeArts Agent",
    projectSkillsDir: ".codeartsdoer/skills",
    globalSkillsDir: () => join(home(), ".codeartsdoer", "skills"),
    detect: () => existsAsync(join(home(), ".codeartsdoer")),
  },
  codebuddy: {
    name: "codebuddy",
    displayName: "CodeBuddy",
    projectSkillsDir: ".codebuddy/skills",
    globalSkillsDir: () => join(home(), ".codebuddy", "skills"),
    detect: async () =>
      existsSync(join(process.cwd(), ".codebuddy")) || existsSync(join(home(), ".codebuddy")),
  },
  codemaker: {
    name: "codemaker",
    displayName: "Codemaker",
    projectSkillsDir: ".codemaker/skills",
    globalSkillsDir: () => join(home(), ".codemaker", "skills"),
    detect: () => existsAsync(join(home(), ".codemaker")),
  },
  codestudio: {
    name: "codestudio",
    displayName: "Code Studio",
    projectSkillsDir: ".codestudio/skills",
    globalSkillsDir: () => join(home(), ".codestudio", "skills"),
    detect: () => existsAsync(join(home(), ".codestudio")),
  },
  codex: {
    name: "codex",
    displayName: "Codex",
    projectSkillsDir: ".agents/skills",
    globalSkillsDir: () => join(codexHome(), "skills"),
    detect: async () => existsSync(codexHome()) || existsSync("/etc/codex"),
  },
  "command-code": {
    name: "command-code",
    displayName: "Command Code",
    projectSkillsDir: ".commandcode/skills",
    globalSkillsDir: () => join(home(), ".commandcode", "skills"),
    detect: () => existsAsync(join(home(), ".commandcode")),
  },
  continue: {
    name: "continue",
    displayName: "Continue",
    projectSkillsDir: ".continue/skills",
    globalSkillsDir: () => join(home(), ".continue", "skills"),
    detect: async () =>
      existsSync(join(process.cwd(), ".continue")) || existsSync(join(home(), ".continue")),
  },
  cortex: {
    name: "cortex",
    displayName: "Cortex Code",
    projectSkillsDir: ".cortex/skills",
    globalSkillsDir: () => join(home(), ".snowflake", "cortex", "skills"),
    detect: () => existsAsync(join(home(), ".snowflake", "cortex")),
  },
  crush: {
    name: "crush",
    displayName: "Crush",
    projectSkillsDir: ".crush/skills",
    globalSkillsDir: () => join(home(), ".config", "crush", "skills"),
    detect: () => existsAsync(join(home(), ".config", "crush")),
  },
  cursor: {
    name: "cursor",
    displayName: "Cursor",
    projectSkillsDir: ".agents/skills",
    globalSkillsDir: () => join(home(), ".cursor", "skills"),
    detect: () => existsAsync(join(home(), ".cursor")),
  },
  deepagents: {
    name: "deepagents",
    displayName: "Deep Agents",
    projectSkillsDir: ".agents/skills",
    globalSkillsDir: () => join(home(), ".deepagents", "agent", "skills"),
    detect: () => existsAsync(join(home(), ".deepagents")),
  },
  devin: {
    name: "devin",
    displayName: "Devin for Terminal",
    projectSkillsDir: ".devin/skills",
    globalSkillsDir: () => join(configHome(), "devin", "skills"),
    detect: () => existsAsync(join(configHome(), "devin")),
  },
  dexto: {
    name: "dexto",
    displayName: "Dexto",
    projectSkillsDir: ".agents/skills",
    globalSkillsDir: () => join(home(), ".agents", "skills"),
    detect: () => existsAsync(join(home(), ".dexto")),
  },
  droid: {
    name: "droid",
    displayName: "Droid",
    projectSkillsDir: ".factory/skills",
    globalSkillsDir: () => join(home(), ".factory", "skills"),
    detect: () => existsAsync(join(home(), ".factory")),
  },
  eve: {
    name: "eve",
    displayName: "Eve",
    projectSkillsDir: "agent/skills",
    globalSkillsDir: null,
    detect: async () => {
      const cwd = process.cwd();
      return (
        existsSync(join(cwd, "agent")) && packageJsonHasDependency(join(cwd, "package.json"), "eve")
      );
    },
  },
  firebender: {
    name: "firebender",
    displayName: "Firebender",
    projectSkillsDir: ".agents/skills",
    globalSkillsDir: () => join(home(), ".firebender", "skills"),
    detect: () => existsAsync(join(home(), ".firebender")),
  },
  forgecode: {
    name: "forgecode",
    displayName: "ForgeCode",
    projectSkillsDir: ".forge/skills",
    globalSkillsDir: () => join(home(), ".forge", "skills"),
    detect: () => existsAsync(join(home(), ".forge")),
  },
  "gemini-cli": {
    name: "gemini-cli",
    displayName: "Gemini CLI",
    projectSkillsDir: ".agents/skills",
    globalSkillsDir: () => join(home(), ".gemini", "skills"),
    detect: () => existsAsync(join(home(), ".gemini")),
  },
  "github-copilot": {
    name: "github-copilot",
    displayName: "GitHub Copilot",
    projectSkillsDir: ".agents/skills",
    globalSkillsDir: () => join(home(), ".copilot", "skills"),
    detect: () => existsAsync(join(home(), ".copilot")),
  },
  goose: {
    name: "goose",
    displayName: "Goose",
    projectSkillsDir: ".goose/skills",
    globalSkillsDir: () => join(configHome(), "goose", "skills"),
    detect: () => existsAsync(join(configHome(), "goose")),
  },
  "hermes-agent": {
    name: "hermes-agent",
    displayName: "Hermes Agent",
    projectSkillsDir: ".hermes/skills",
    globalSkillsDir: () => join(hermesHome(), "skills"),
    detect: () => existsAsync(hermesHome()),
  },
  "inference-sh": {
    name: "inference-sh",
    displayName: "inference.sh",
    projectSkillsDir: ".inferencesh/skills",
    globalSkillsDir: () => join(home(), ".inferencesh", "skills"),
    detect: () => existsAsync(join(home(), ".inferencesh")),
  },
  jazz: {
    name: "jazz",
    displayName: "Jazz",
    projectSkillsDir: ".jazz/skills",
    globalSkillsDir: () => join(home(), ".jazz", "skills"),
    detect: async () =>
      existsSync(join(home(), ".jazz")) || existsSync(join(process.cwd(), ".jazz")),
  },
  junie: {
    name: "junie",
    displayName: "Junie",
    projectSkillsDir: ".junie/skills",
    globalSkillsDir: () => join(home(), ".junie", "skills"),
    detect: () => existsAsync(join(home(), ".junie")),
  },
  "iflow-cli": {
    name: "iflow-cli",
    displayName: "iFlow CLI",
    projectSkillsDir: ".iflow/skills",
    globalSkillsDir: () => join(home(), ".iflow", "skills"),
    detect: () => existsAsync(join(home(), ".iflow")),
  },
  kilo: {
    name: "kilo",
    displayName: "Kilo Code",
    projectSkillsDir: ".kilocode/skills",
    globalSkillsDir: () => join(home(), ".kilocode", "skills"),
    detect: () => existsAsync(join(home(), ".kilocode")),
  },
  "kimi-code-cli": {
    name: "kimi-code-cli",
    displayName: "Kimi Code CLI",
    projectSkillsDir: ".agents/skills",
    globalSkillsDir: () => join(home(), ".agents", "skills"),
    detect: async () => existsSync(join(home(), ".kimi-code")) || existsSync(join(home(), ".kimi")),
  },
  "kiro-cli": {
    name: "kiro-cli",
    displayName: "Kiro CLI",
    projectSkillsDir: ".kiro/skills",
    globalSkillsDir: () => join(home(), ".kiro", "skills"),
    detect: () => existsAsync(join(home(), ".kiro")),
  },
  kode: {
    name: "kode",
    displayName: "Kode",
    projectSkillsDir: ".kode/skills",
    globalSkillsDir: () => join(home(), ".kode", "skills"),
    detect: () => existsAsync(join(home(), ".kode")),
  },
  lingma: {
    name: "lingma",
    displayName: "Lingma",
    projectSkillsDir: ".lingma/skills",
    globalSkillsDir: () => join(home(), ".lingma", "skills"),
    detect: () => existsAsync(join(home(), ".lingma")),
  },
  loaf: {
    name: "loaf",
    displayName: "Loaf",
    projectSkillsDir: ".agents/skills",
    globalSkillsDir: () => join(home(), ".agents", "skills"),
    detect: () => existsAsync(join(home(), ".loaf")),
  },
  mcpjam: {
    name: "mcpjam",
    displayName: "MCPJam",
    projectSkillsDir: ".mcpjam/skills",
    globalSkillsDir: () => join(home(), ".mcpjam", "skills"),
    detect: () => existsAsync(join(home(), ".mcpjam")),
  },
  "mistral-vibe": {
    name: "mistral-vibe",
    displayName: "Mistral Vibe",
    projectSkillsDir: ".vibe/skills",
    globalSkillsDir: () => join(vibeHome(), "skills"),
    detect: () => existsAsync(vibeHome()),
  },
  moxby: {
    name: "moxby",
    displayName: "Moxby",
    projectSkillsDir: ".moxby/skills",
    globalSkillsDir: () => join(home(), ".moxby", "skills"),
    detect: () => existsAsync(join(home(), ".moxby")),
  },
  mux: {
    name: "mux",
    displayName: "Mux",
    projectSkillsDir: ".mux/skills",
    globalSkillsDir: () => join(home(), ".mux", "skills"),
    detect: () => existsAsync(join(home(), ".mux")),
  },
  opencode: {
    name: "opencode",
    displayName: "OpenCode",
    projectSkillsDir: ".agents/skills",
    globalSkillsDir: () => join(configHome(), "opencode", "skills"),
    detect: () => existsAsync(join(configHome(), "opencode")),
  },
  openhands: {
    name: "openhands",
    displayName: "OpenHands",
    projectSkillsDir: ".openhands/skills",
    globalSkillsDir: () => join(home(), ".openhands", "skills"),
    detect: () => existsAsync(join(home(), ".openhands")),
  },
  ona: {
    name: "ona",
    displayName: "Ona",
    projectSkillsDir: ".ona/skills",
    globalSkillsDir: () => join(home(), ".ona", "skills"),
    detect: () => existsAsync(join(home(), ".ona")),
  },
  pi: {
    name: "pi",
    displayName: "Pi",
    projectSkillsDir: ".pi/skills",
    globalSkillsDir: () => join(home(), ".pi", "agent", "skills"),
    detect: () => existsAsync(join(home(), ".pi", "agent")),
  },
  qoder: {
    name: "qoder",
    displayName: "Qoder",
    projectSkillsDir: ".qoder/skills",
    globalSkillsDir: () => join(home(), ".qoder", "skills"),
    detect: () => existsAsync(join(home(), ".qoder")),
  },
  "qoder-cn": {
    name: "qoder-cn",
    displayName: "Qoder CN",
    // Shares its project dir with `qoder` but not its global dir — verified
    // against the upstream registry, not a copy-paste slip.
    projectSkillsDir: ".qoder/skills",
    globalSkillsDir: () => join(home(), ".qoder-cn", "skills"),
    detect: () => existsAsync(join(home(), ".qoder-cn")),
  },
  "qwen-code": {
    name: "qwen-code",
    displayName: "Qwen Code",
    projectSkillsDir: ".qwen/skills",
    globalSkillsDir: () => join(home(), ".qwen", "skills"),
    detect: () => existsAsync(join(home(), ".qwen")),
  },
  replit: {
    name: "replit",
    displayName: "Replit",
    projectSkillsDir: ".agents/skills",
    globalSkillsDir: () => join(configHome(), "agents", "skills"),
    detect: () => existsAsync(join(process.cwd(), ".replit")),
  },
  reasonix: {
    name: "reasonix",
    displayName: "Reasonix",
    projectSkillsDir: ".reasonix/skills",
    globalSkillsDir: () => join(home(), ".reasonix", "skills"),
    detect: () => existsAsync(join(home(), ".reasonix")),
  },
  rovodev: {
    name: "rovodev",
    displayName: "Rovo Dev",
    projectSkillsDir: ".rovodev/skills",
    globalSkillsDir: () => join(home(), ".rovodev", "skills"),
    detect: () => existsAsync(join(home(), ".rovodev")),
  },
  roo: {
    name: "roo",
    displayName: "Roo Code",
    projectSkillsDir: ".roo/skills",
    globalSkillsDir: () => join(home(), ".roo", "skills"),
    detect: () => existsAsync(join(home(), ".roo")),
  },
  "tabnine-cli": {
    name: "tabnine-cli",
    displayName: "Tabnine CLI",
    projectSkillsDir: ".tabnine/agent/skills",
    globalSkillsDir: () => join(home(), ".tabnine", "agent", "skills"),
    detect: () => existsAsync(join(home(), ".tabnine")),
  },
  terramind: {
    name: "terramind",
    displayName: "Terramind",
    projectSkillsDir: ".terramind/skills",
    globalSkillsDir: () => join(home(), ".terramind", "skills"),
    detect: () => existsAsync(join(home(), ".terramind")),
  },
  tinycloud: {
    name: "tinycloud",
    displayName: "Tinycloud",
    projectSkillsDir: ".tinycloud/skills",
    globalSkillsDir: () => join(home(), ".tinycloud", "skills"),
    detect: () => existsAsync(join(home(), ".tinycloud")),
  },
  trae: {
    name: "trae",
    displayName: "Trae",
    projectSkillsDir: ".trae/skills",
    globalSkillsDir: () => join(home(), ".trae", "skills"),
    detect: () => existsAsync(join(home(), ".trae")),
  },
  "trae-cn": {
    name: "trae-cn",
    displayName: "Trae CN",
    projectSkillsDir: ".trae/skills",
    globalSkillsDir: () => join(home(), ".trae-cn", "skills"),
    detect: () => existsAsync(join(home(), ".trae-cn")),
  },
  warp: {
    name: "warp",
    displayName: "Warp",
    projectSkillsDir: ".agents/skills",
    globalSkillsDir: () => join(home(), ".agents", "skills"),
    detect: () => existsAsync(join(home(), ".warp")),
  },
  windsurf: {
    name: "windsurf",
    displayName: "Windsurf",
    projectSkillsDir: ".windsurf/skills",
    globalSkillsDir: () => join(home(), ".codeium", "windsurf", "skills"),
    detect: () => existsAsync(join(home(), ".codeium", "windsurf")),
  },
  zed: {
    name: "zed",
    displayName: "Zed",
    projectSkillsDir: ".agents/skills",
    globalSkillsDir: () => join(home(), ".agents", "skills"),
    // Per Zed's own `config_dir()` (crates/paths/src/paths.rs): XDG config
    // home first, then Windows %APPDATA%\Zed, then the Flatpak sandbox's
    // redirected XDG config home.
    detect: async () => {
      const appData = process.env.APPDATA?.trim();
      const flatpak = process.env.FLATPAK_XDG_CONFIG_HOME?.trim();
      return (
        existsSync(join(configHome(), "zed")) ||
        (Boolean(appData) && existsSync(join(appData as string, "Zed"))) ||
        (Boolean(flatpak) && existsSync(join(flatpak as string, "zed")))
      );
    },
  },
  zcode: {
    name: "zcode",
    displayName: "ZCode",
    projectSkillsDir: ".zcode/skills",
    globalSkillsDir: () => join(home(), ".zcode", "skills"),
    detect: async () => isZCodeInstalled(),
  },
  zencoder: {
    name: "zencoder",
    displayName: "Zencoder",
    projectSkillsDir: ".zencoder/skills",
    globalSkillsDir: () => join(home(), ".zencoder", "skills"),
    detect: () => existsAsync(join(home(), ".zencoder")),
  },
  zenflow: {
    name: "zenflow",
    displayName: "Zenflow",
    // Genuinely shares Zencoder's directories upstream — not a typo here.
    projectSkillsDir: ".zencoder/skills",
    globalSkillsDir: () => join(home(), ".zencoder", "skills"),
    detect: () => existsAsync(join(home(), ".zencoder")),
  },
  neovate: {
    name: "neovate",
    displayName: "Neovate",
    projectSkillsDir: ".neovate/skills",
    globalSkillsDir: () => join(home(), ".neovate", "skills"),
    detect: () => existsAsync(join(home(), ".neovate")),
  },
  pochi: {
    name: "pochi",
    displayName: "Pochi",
    projectSkillsDir: ".pochi/skills",
    globalSkillsDir: () => join(home(), ".pochi", "skills"),
    detect: () => existsAsync(join(home(), ".pochi")),
  },
  promptscript: {
    name: "promptscript",
    displayName: "PromptScript",
    projectSkillsDir: ".agents/skills",
    globalSkillsDir: null,
    detect: async () =>
      existsSync(join(process.cwd(), ".promptscript")) ||
      existsSync(join(process.cwd(), "promptscript.yaml")),
  },
  adal: {
    name: "adal",
    displayName: "AdaL",
    projectSkillsDir: ".adal/skills",
    globalSkillsDir: () => join(home(), ".adal", "skills"),
    detect: () => existsAsync(join(home(), ".adal")),
  },
};

/** Every registry key, in declaration order. */
export function allAgentNames(): string[] {
  return Object.keys(AGENTS);
}

/**
 * Every tool `install`/`doctor`/`uninstall` offer the user, in one place:
 * every agent with a real skill-delivery mechanism, plus `aider`, which has
 * none (see the module header) but is still listed so those commands can
 * explain why rather than silently omit it.
 */
export function supportedAgentNames(): string[] {
  return [...allAgentNames(), "aider"];
}

export function getAgentDefinition(name: string): AgentDefinition | null {
  return AGENTS[name] ?? null;
}

/**
 * A "universal" agent already reads the canonical `.agents/skills` directory
 * directly — installing into it must not try to symlink that directory onto
 * itself. Computed rather than stored so it can never drift from
 * `projectSkillsDir`.
 */
export function isUniversalAgent(name: string): boolean {
  return AGENTS[name]?.projectSkillsDir === ".agents/skills";
}

/**
 * Command-only agents with no config directory to probe — detected via PATH
 * lookup instead. `aider` has no persistent home directory (it is a
 * pip-installed CLI); it is also not a member of `AGENTS` at all (see the
 * module header), so it needs its own probe entry here.
 */
const COMMAND_PROBES: Record<string, string> = {
  aider: "aider",
};

/**
 * Detect whether `agent` appears installed on this machine. Unknown agent
 * names resolve to `false` rather than throwing, so callers can probe
 * speculatively.
 */
export async function detectAgent(agent: string): Promise<boolean> {
  const definition = AGENTS[agent];
  if (definition) return definition.detect();
  const command = COMMAND_PROBES[agent];
  if (command) return commandExists(command);
  return false;
}
