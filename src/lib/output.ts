/**
 * User-facing output helpers.
 *
 * All console interaction goes through here so the rest of the codebase does
 * not depend directly on process.stdout/stderr.  In test environments the
 * writers can be replaced by injecting a custom Output.
 */
import pc from "picocolors";

export interface Output {
  write(message: string): void;
  writeLine(message?: string): void;
  error(message: string): void;
  errorLine(message?: string): void;
}

export const defaultOutput: Output = {
  write(message: string): void {
    process.stdout.write(message);
  },
  writeLine(message = ""): void {
    process.stdout.write(`${message}\n`);
  },
  error(message: string): void {
    process.stderr.write(message);
  },
  errorLine(message = ""): void {
    process.stderr.write(`${message}\n`);
  },
};

export function formatError(message: string): string {
  return `${pc.red("Error:")} ${message}`;
}

export function formatWarning(message: string): string {
  return `${pc.yellow("Warning:")} ${message}`;
}

export function formatSuccess(message: string): string {
  return `${pc.green("✓")} ${message}`;
}
