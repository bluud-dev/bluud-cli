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

export function formatBytes(bytes: number): string {
  if (bytes === 0) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  const i = Math.min(units.length - 1, Math.floor(Math.log10(bytes) / 3));
  const value = bytes / Math.pow(1000, i);
  return `${value.toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}
