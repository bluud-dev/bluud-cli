/**
 * Thin wrappers over `@clack/prompts`.
 *
 * Two concerns are centralized here so no command has to repeat them:
 *   1. Cancellation — every clack prompt returns a cancel symbol on Ctrl-C.
 *      The wrappers translate that into a single `CliError("cancelled")` so the
 *      top-level handler exits cleanly instead of each call site re-checking
 *      `isCancel`.
 *   2. Non-interactive safety — prompting when there is no TTY (CI, an agent
 *      driving the CLI) would hang forever. `assertInteractive` gives callers a
 *      clear, actionable failure instead.
 */

import * as clack from "@clack/prompts";
import { CliError } from "./error.js";

/** Throw if the CLI cannot prompt — callers guard before any interactive step. */
export function assertInteractive(nonInteractive: boolean, hint: string): void {
  if (nonInteractive) {
    throw new CliError(hint, { code: "auth_required" });
  }
}

function unwrap<T>(value: T | symbol): T {
  if (clack.isCancel(value)) {
    throw new CliError("Cancelled.", { code: "cancelled" });
  }
  return value as T;
}

export interface SelectOption<T extends string> {
  value: T;
  label: string;
  hint?: string;
}

// `@clack/prompts` types `select`/`multiselect` over two inferred type params
// (the options-array type and the value type), which its `Option` union does
// not cleanly accept a pre-typed array for. We keep our own precise public
// signature (`SelectOption<T>[]`) and bridge the third-party quirk with a
// single localized cast, then re-narrow the result.

export async function promptSelect<T extends string>(
  message: string,
  options: SelectOption<T>[],
): Promise<T> {
  const result = await clack.select({
    message,
    options,
  } as unknown as Parameters<typeof clack.select>[0]);
  return unwrap<T>(result as T | symbol);
}

export async function promptMultiselect<T extends string>(
  message: string,
  options: SelectOption<T>[],
  initialValues?: T[],
): Promise<T[]> {
  const result = await clack.multiselect({
    message,
    options,
    initialValues,
    required: false,
  } as unknown as Parameters<typeof clack.multiselect>[0]);
  return unwrap<T[]>(result as T[] | symbol);
}

export async function promptText(message: string, placeholder?: string): Promise<string> {
  return unwrap(await clack.text({ message, placeholder }));
}

export async function promptPassword(message: string): Promise<string> {
  return unwrap(await clack.password({ message }));
}

export async function promptConfirm(message: string, initialValue = true): Promise<boolean> {
  return unwrap(await clack.confirm({ message, initialValue }));
}

export type Spinner = ReturnType<typeof clack.spinner>;

export function spinner(): Spinner {
  return clack.spinner();
}

export const intro = clack.intro;
export const outro = clack.outro;
export const note = clack.note;
