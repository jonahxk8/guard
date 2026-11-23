import type { ChatInputCommandInteraction } from "discord.js";

/**
 * Symbol marking a slash-command reply as an error.
 *
 * Slash replies are always ephemeral, so the flag changes nothing on the
 * slash path. The prefix adapter (prefix.ts) reads it from the reply
 * options to decide whether a visible prefix reply should auto-delete
 * after 10 seconds. It is a symbol-keyed property, so discord.js never
 * sees it: the reply payload is built from named fields only, and
 * JSON.stringify drops symbol keys, so it cannot leak into the API call.
 */
export const WILD_ERROR_REPLY: unique symbol = Symbol("wild-error-reply");

/**
 * Symbol marking a reply as one that must NOT auto-delete.
 *
 * Used for interactive messages with a live collector (share offers,
 * the /fg remove confirmation, paged help and blacklist lists): the
 * prefix adapter reads it and skips the 90-second auto-delete. It is a
 * symbol-keyed property, so discord.js never sees it.
 */
export const WILD_KEEP_REPLY: unique symbol = Symbol("wild-keep-reply");

/**
 * Public bot replies that are not interactive auto-delete after this
 * long (1 minute 30 seconds). Prefix error replies keep their own
 * 10-second timer; ephemeral slash replies vanish on their own.
 */
export const AUTO_DELETE_DELAY_MS = 90_000;

/**
 * One-line summary of a Discord API error for the logs: the error name
 * plus its Discord error code and HTTP status when present, so the
 * Railway log names the cause without reading the whole stack.
 * `DiscordAPIError[50035] (code=50035 status=400): Invalid Form Body`,
 * `HTTPError (status=502): Bad Gateway`, or just `Error: <message>`
 * for anything else.
 */
export function describeDiscordError(error: unknown): string {
  if (typeof error !== "object" || error === null) return String(error);
  const record = error as {
    code?: unknown;
    status?: unknown;
    message?: unknown;
    name?: unknown;
  };
  const message =
    typeof record.message === "string" ? record.message : String(error);
  const name = typeof record.name === "string" ? record.name : "Error";
  const bits: string[] = [];
  if (typeof record.code === "number") bits.push(`code=${record.code}`);
  if (typeof record.status === "number") bits.push(`status=${record.status}`);
  return bits.length > 0
    ? `${name} (${bits.join(" ")}): ${message}`
    : `${name}: ${message}`;
}

/**
 * Is this error worth one retry of the send that failed? A 4xx Discord
 * error is deterministic — bad payload, missing permission, unknown
 * interaction — and retrying it is pointless. Anything else (a 5xx,
 * a network failure, a timeout) may succeed on a second attempt.
 */
export function isRetryableDiscordError(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return true;
  const status = (error as { status?: unknown }).status;
  if (typeof status === "number" && status >= 400 && status < 500) {
    return false;
  }
  return true;
}

/**
 * Silently ignore an unauthorised use of an admin-gated command: send
 * NO reply at all, not even an ephemeral error.
 *
 * Slash: a slash interaction MUST be answered or Discord shows "The
 * application did not respond", so the interaction is deferred
 * ephemerally and the deferred reply is then deleted — the user briefly
 * sees "thinking" and then nothing: no error, no message. Prefix: the
 * adapter's fake interaction has no deferReply/deleteReply, so this is
 * a no-op there and the handler simply never replies; the user's
 * command message is still deleted by handlePrefixMessage as usual.
 *
 * Only call this from an authorisation gate, before any other reply or
 * defer — never after a handler has already answered, and never for a
 * functional error (wrong usage, "you don't have an FG role", "that
 * role isn't an FG role", "that member already has an FG role", ...):
 * those still reply as before. Ignoring is reply-only: the gate is
 * still enforced server-side and nothing happens. Best-effort: it
 * never throws.
 */
export async function ignoreUnauthorized(
  interaction: ChatInputCommandInteraction,
): Promise<void> {
  const candidate = interaction as unknown as {
    deferReply?: (options: { ephemeral: boolean }) => Promise<unknown>;
    deleteReply?: () => Promise<unknown>;
  };
  try {
    if (typeof candidate.deferReply !== "function") return;
    await candidate.deferReply({ ephemeral: true });
    if (typeof candidate.deleteReply === "function") {
      await candidate.deleteReply();
    }
  } catch {
    // Best-effort: the ignore itself must never throw, and a deferred
    // reply is only deleted when this call deferred it — never delete a
    // reply this call did not create.
  }
}
