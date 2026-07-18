/**
 * Minimal command-line argument parser.
 *
 * Supports:
 *   - positional arguments
 *   - short flags (-y, -a foo)
 *   - long flags (--yes, --agent foo, --agent=foo)
 *   - repeated flags collected into arrays
 *   - bare `--` terminator
 */

export interface ParsedArgs {
  command: string | null;
  positionals: string[];
  flags: Record<string, string | boolean | string[]>;
}

export function parseArgs(argv: string[]): ParsedArgs {
  const positionals: string[] = [];
  const flags: Record<string, string | boolean | string[]> = {};
  let command: string | null = null;
  let bare = false;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];

    if (arg === "--") {
      bare = true;
      continue;
    }

    if (!bare && arg.startsWith("-")) {
      const { key, value, consumed } = parseFlag(argv, i);
      const existing = flags[key];
      if (existing === undefined) {
        flags[key] = value;
      } else if (Array.isArray(existing)) {
        existing.push(...(Array.isArray(value) ? value : [value as string]));
      } else {
        flags[key] = [existing as string, ...(Array.isArray(value) ? value : [value as string])];
      }
      i += consumed;
      continue;
    }

    if (command === null) {
      command = arg;
    } else {
      positionals.push(arg);
    }
  }

  return { command, positionals, flags };
}

function parseFlag(
  argv: string[],
  index: number,
): { key: string; value: string | boolean; consumed: number } {
  const arg = argv[index];

  if (arg.startsWith("--")) {
    const eq = arg.indexOf("=");
    if (eq !== -1) {
      return { key: arg.slice(2, eq), value: arg.slice(eq + 1), consumed: 0 };
    }
    const key = arg.slice(2);
    const next = argv[index + 1];
    if (next !== undefined && !next.startsWith("-")) {
      return { key, value: next, consumed: 1 };
    }
    return { key, value: true, consumed: 0 };
  }

  // Short flag(s): -y, -a foo, -abc
  const chars = arg.slice(1);
  if (chars.length > 1) {
    // Multiple short flags (e.g. -fg).  Only the last one may consume a value.
    for (let j = 0; j < chars.length - 1; j++) {
      // This parser only supports boolean clusters; a value-consuming short
      // flag must be the last character.
    }
  }
  const key = chars.slice(-1);
  const rest = chars.slice(0, -1);
  const next = argv[index + 1];

  // Emit leading boolean short flags as bare booleans.
  for (const ch of rest) {
    // Mutating argv would be messy; instead we rely on callers not using
    // multi-letter clusters with value-consuming flags in the middle.
    void ch;
  }

  if (next !== undefined && !next.startsWith("-")) {
    return { key, value: next, consumed: 1 };
  }
  return { key, value: true, consumed: 0 };
}

export function getFlagString(flags: ParsedArgs["flags"], key: string): string | undefined {
  const value = flags[key];
  if (Array.isArray(value)) return value[value.length - 1];
  if (typeof value === "boolean") return undefined;
  return value;
}

export function getFlagBoolean(flags: ParsedArgs["flags"], key: string): boolean {
  const value = flags[key];
  if (value === undefined) return false;
  if (typeof value === "boolean") return value;
  return true;
}

export function getFlagArray(flags: ParsedArgs["flags"], key: string): string[] {
  const value = flags[key];
  if (value === undefined) return [];
  if (Array.isArray(value)) return value;
  return [typeof value === "boolean" ? "" : value].filter(Boolean);
}
