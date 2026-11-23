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
