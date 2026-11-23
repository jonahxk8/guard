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
