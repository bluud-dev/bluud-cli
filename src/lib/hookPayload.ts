/**
 * Reading the hook payload a tool pipes to its hook command on stdin.
 *
 * Bluud's hook scripts deliberately leave stdin unread for every tool but one
 * (see `src/hooks/bluud-pull-hook.sh`): `bluud pull` needs nothing from a
 * Claude Code `SessionStart` or Cline `TaskStart` payload, because those events
 * already fire exactly once per session.
 *
 * Hermes is the exception. Its only context-injection event is `pre_llm_call`,
 * which fires before every LLM call in the conversation — so the payload's
 * `is_first_turn` flag is the only thing that distinguishes "session start"
 * from "turn 40". Reading it is what lets Bluud inject once per session on a
 * per-turn event rather than on every turn.
 */

/**
 * Upper bound on waiting for a hook payload.
 *
 * A tool that spawns a hook is expected to write its JSON payload and close
 * the pipe immediately, so the realistic wait is sub-millisecond. The timeout
 * exists for the pathological case — a harness that opens stdin and neither
 * writes nor closes it — where an unbounded read would hang the hook until the
 * tool's own timeout kills it, stalling the user's turn. 2s is orders of
 * magnitude above the honest case while staying well inside the 30s timeout
 * Bluud registers with Hermes.
 */
const STDIN_READ_TIMEOUT_MS = 2000;

/**
 * Read a hook payload from stdin, or `null` when there is none to read.
 *
 * Returns `null` rather than throwing in every failure mode — no stdin, an
 * interactive terminal, a read error, or the timeout above. Callers treat
 * `null` as "no information", which under Bluud's fail-open contract
 * (BLUUD_CONCEPT.md section 9.1) means proceeding as though this were the
 * first turn: a missing payload must never silently suppress memory.
 *
 * The TTY check matters for more than tidiness. When a human runs
 * `bluud pull --inject --format=hermes` by hand to inspect the output, stdin
 * is the terminal and no payload is ever coming; without this guard the
 * command would sit for the full timeout before printing anything.
 */
export async function readHookPayloadFromStdin(): Promise<string | null> {
  const stdin = process.stdin;
  if (!stdin || stdin.isTTY) return null;

  return new Promise<string | null>((resolve) => {
    let settled = false;
    const chunks: Buffer[] = [];

    const finish = (value: string | null): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      stdin.off("data", onData);
      stdin.off("end", onEnd);
      stdin.off("error", onError);
      // The stream was never ours to own; stop pulling from it but leave it
      // open so nothing else in the process sees a destroyed stdin.
      stdin.pause();
      resolve(value);
    };

    const onData = (chunk: Buffer): void => {
      chunks.push(chunk);
    };
    const onEnd = (): void => {
      finish(chunks.length > 0 ? Buffer.concat(chunks).toString("utf8") : null);
    };
    const onError = (): void => finish(null);

    const timer = setTimeout(() => {
      // Whatever arrived before the deadline is still worth parsing — a
      // payload can be complete even when the writer never closes the pipe.
      finish(chunks.length > 0 ? Buffer.concat(chunks).toString("utf8") : null);
    }, STDIN_READ_TIMEOUT_MS);
    // Never let this timer alone keep the process alive.
    timer.unref?.();

    stdin.on("data", onData);
    stdin.on("end", onEnd);
    stdin.on("error", onError);
    stdin.resume();
  });
}

/**
 * Whether a Hermes `pre_llm_call` payload describes the first turn of a
 * session — the one turn on which Bluud injects the memory index.
 *
 * Hermes carries the event-specific fields inside an `extra` object, but some
 * builds also surface them at the top level. Both layouts are read and
 * coalesced so the gate works regardless of which one a given Hermes version
 * sends; this mirrors how gortex decodes the same payload
 * (`internal/hooks/hermes.go`, `hermesPreLLMInput`).
 *
 * Every ambiguous case resolves to `true` (inject):
 *   - no payload at all, or one that is not JSON
 *   - a payload that carries no `is_first_turn` key in either position
 *
 * The asymmetry is deliberate and follows the fail-open contract. Wrongly
 * returning `true` injects the index one extra time — a bounded, harmless
 * cost. Wrongly returning `false` silently withholds project memory for the
 * entire session, which is the failure the contract exists to prevent.
 */
export function hermesPayloadIsFirstTurn(payload: string | null): boolean {
  if (payload === null) return true;

  let parsed: unknown;
  try {
    parsed = JSON.parse(payload);
  } catch {
    return true;
  }
  if (typeof parsed !== "object" || parsed === null) return true;

  const root = parsed as Record<string, unknown>;
  const topLevel = root["is_first_turn"];
  if (typeof topLevel === "boolean") return topLevel;

  const extra = root["extra"];
  if (typeof extra === "object" && extra !== null) {
    const nested = (extra as Record<string, unknown>)["is_first_turn"];
    if (typeof nested === "boolean") return nested;
  }

  return true;
}
