import {
  ChatInputCommandInteraction,
  GuildMember,
  Message,
} from "discord.js";
import { ConfigStore } from "./config-store.js";
import { fetchMemberFresh } from "./authorization.js";
import { handleGuardCommand } from "./commands.js";
import { handleFgCommand, parseFgColorTokens, splitColorTokens } from "./fg-booster.js";
import { handleHelpCommand } from "./help.js";
import { wildMessageEmbed } from "./embeds.js";
import { WILD_ERROR_REPLY } from "./reply.js";

/**
 * Prefix (",") commands. Every slash command also works with ","
 * (one per line):
 *
 *   ,guard @role
 *   ,whitelist @user / @role
 *   ,status
 *   ,logchannel #channel (or "off")
 *   ,fg ...
 *   ,blacklist ...
 *   ,help
 *
 * The prefix names for two commands differ from their slash names on
 * purpose: Greed owns ,protect and ,setup, so Wild's prefix versions
 * are ,guard and ,logchannel instead. The slash commands /protect and
 * /setup are unchanged, and the prefix handler maps ,guard -> protect
 * and ,logchannel -> setup before calling the shared slash handlers.
 * The prefix path does NOT duplicate any guard/FG/blacklist logic. It
 * parses the message into the same arguments the slash commands take and
 * calls the same handlers (handleGuardCommand / handleFgCommand) through
 * a thin adapter that pretends to be a ChatInputCommandInteraction.
 * Slash and prefix therefore cannot drift apart.
 *
 * Greed no-clash note: Greed also uses the "," prefix, and it owns
 * ,protect (marks a member/role off-limits to Greed moderation) and
 * ,setup (auto-creates its imute/rmute/jailed roles and a mod
 * category). Wild never registers those two names — its prefix
 * versions are ,guard and ,logchannel instead (see above). Wild also
 * never uses Greed's ,boosterrole (alias ,br), ,autorole, or bare
 * ,role. Whether Greed also has ,whitelist, ,status, ,fg, or
 * ,blacklist was NOT verified — check in a test channel with both
 * bots present before relying on those four (see WILD_BOT.md).
 *
 * Ephemeral limit (Discord, not a bug): a prefix reply is always visible
 * in the channel — Discord has no invisible message replies. Mitigation:
 * the user's prefix command message is deleted after handling
 * (best-effort), and error replies auto-delete after 10 seconds
 * (best-effort). Success replies stay. Anyone who needs invisible
 * errors should use the slash versions.
 */

export const PREFIX = ",";
export const PREFIX_COMMANDS = [
  "guard",
  "whitelist",
  "status",
  "logchannel",
  "fg",
  "blacklist",
  "help",
] as const;

/** Prefix names that map to a differently-named slash command. */
const SLASH_COMMAND_NAME: Record<string, string> = {
  guard: "protect",
  logchannel: "setup",
};

/** Error replies auto-delete after this long (best-effort). */
export const ERROR_DELETE_DELAY_MS = 10_000;

const SNOWFLAKE = /^\d{5,25}$/;

interface PrefixArgs {
  roles: Record<string, string>;
  users: Record<string, string>;
  channels: Record<string, string>;
  strings: Record<string, string>;
  subcommand: string;
  subcommandGroup: string | null;
}

interface ParsedPrefix {
  command: string;
  args: PrefixArgs;
}

function emptyArgs(): PrefixArgs {
  return {
    roles: {},
    users: {},
    channels: {},
    strings: {},
    subcommand: "",
    subcommandGroup: null,
  };
}

/** "<@123>", "<@!123>", or a raw id -> user id. "<@&...>" is a role, not a user. */
function parseUserToken(token: string | undefined): string | null {
  if (!token) return null;
  const mention = token.match(/^<@!?(\d+)>$/);
  if (mention) return mention[1];
  if (SNOWFLAKE.test(token)) return token;
  return null;
}

/** "<@&123>" or a raw id -> role id. */
function parseRoleToken(token: string | undefined): string | null {
  if (!token) return null;
  const mention = token.match(/^<@&(\d+)>$/);
  if (mention) return mention[1];
  if (SNOWFLAKE.test(token)) return token;
  return null;
}

/** "<#123>" or a raw id -> channel id. */
function parseChannelToken(token: string | undefined): string | null {
  if (!token) return null;
  const mention = token.match(/^<#(\d+)>$/);
  if (mention) return mention[1];
  if (SNOWFLAKE.test(token)) return token;
  return null;
}

/**
 * Parse a "," message into a command + args, or null when the message is
 * not a Wild prefix command. Unknown "," commands return null on purpose:
 * the bot stays silent (no error spam), and the message is left alone —
 * it may belong to Greed or another bot.
 */
export function parsePrefixMessage(
  content: string,
): ParsedPrefix | { command: string; error: string } | null {
  const text = content.trim();
  if (!text.startsWith(PREFIX)) return null;
  const tokens = text.slice(PREFIX.length).trim().split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return null;
  const [command, ...rest] = tokens;
  if (!(PREFIX_COMMANDS as readonly string[]).includes(command)) return null;

  const args = emptyArgs();
  const usage = (message: string): { command: string; error: string } => ({
    command,
    error: message,
  });

  switch (command) {
    case "guard": {
      const roleId = parseRoleToken(rest[0]);
      if (!roleId) return usage("Usage: ,guard @role");
      args.roles.role = roleId;
      return { command, args };
    }
    case "whitelist": {
      // A role mention is a role; a user mention is a user; a raw id is a
      // role when it matches a role id, otherwise a user. The caller
      // resolves raw ids against the guild; here we keep the token.
      if (!rest[0]) return usage("Usage: ,whitelist @user or @role");
      const roleId = parseRoleToken(rest[0]);
      const userId = parseUserToken(rest[0]);
      if (roleId && rest[0].startsWith("<@&")) {
        args.roles.role = roleId;
      } else if (userId) {
        args.users.user = userId;
        // Keep the raw token so the adapter can check the guild's role
        // cache for a raw id that is actually a role id.
        args.strings.__rawTarget = rest[0];
      } else {
        return usage("Usage: ,whitelist @user or @role");
      }
      return { command, args };
    }
    case "status":
      return { command, args };
    case "logchannel": {
      // No argument, or "off", turns alerts off — same as /setup.
      if (!rest[0] || rest[0].toLowerCase() === "off") return { command, args };
      const channelId = parseChannelToken(rest[0]);
      if (!channelId) return usage("Usage: ,logchannel #channel or ,logchannel off");
      args.channels.channel = channelId;
      return { command, args };
    }
    case "fg":
      return parseFgPrefix(rest, args, usage);
    case "help": {
      // ,help, ,help fg, ,help fg create — the topic is everything after.
      args.strings.topic = rest.join(" ").trim();
      return { command, args };
    }
    case "blacklist": {
      const action = rest[0];
      if (action === "list") {
        args.subcommand = "list";
        return { command, args };
      }
      if (action === "add" || action === "remove") {
        const userId = parseUserToken(rest[1]);
        const roleId = parseRoleToken(rest[2]);
        if (!userId || !roleId) {
          return usage(`Usage: ,blacklist ${action} @user @role`);
        }
        args.subcommand = action;
        args.users.user = userId;
        args.roles.role = roleId;
        return { command, args };
      }
      return usage("Use ,help blacklist to see blacklist commands.");
    }
    default:
      return null;
  }
}

function parseFgPrefix(
  rest: string[],
  args: PrefixArgs,
  usage: (message: string) => { command: string; error: string },
): ParsedPrefix | { command: string; error: string } {
  const [action, ...tail] = rest;
  switch (action) {
    case "base": {
      const roleId = parseRoleToken(tail[0]);
      if (!roleId) return usage("Usage: ,fg base @role");
      args.subcommand = "base";
      args.roles.role = roleId;
      return { command: "fg", args };
    }
    case "color": {
      // ,fg color <color> [second_color] — recolor your own FG role.
      // No name anymore: the whole tail is the color spec. One hex =
      // solid, two = gradient (separated by a space or a comma),
      // `random`, `holographic`/`holo`, or `dominant` (your avatar's
      // color) on its own.
      const tokens = splitColorTokens(tail.join(" "));
      if (tokens.length === 0) {
        return usage("Usage: ,fg color <color> [second_color]");
      }
      const parsed = parseFgColorTokens(tokens);
      if ("error" in parsed) {
        return usage(
          parsed.error === "too-many"
            ? "Too many colors — give one color, or two for a gradient."
            : "Usage: ,fg color <color> [second_color]",
        );
      }
      if (parsed.consumed !== tokens.length) {
        return usage("Usage: ,fg color <color> [second_color]");
      }
      args.subcommand = "color";
      // The whole spec goes in the one color string; the shared
      // handler parses it (two colors in one option is supported).
      args.strings.color = parsed.colorText;
      return { command: "fg", args };
    }
    case "create": {
      // ,fg create <name> [@member] — name may contain spaces; a
      // trailing @mention or raw user id is the member the role is
      // for. No color anymore: the role takes the member's avatar color.
      const tokens = tail;
      const last = tokens[tokens.length - 1];
      const memberId = parseUserToken(last);
      let nameTokens = tokens;
      if (memberId && last) {
        args.users.member = memberId;
        nameTokens = tokens.slice(0, -1);
      }
      const name = nameTokens.join(" ").trim();
      if (!name) return usage("Usage: ,fg create <name> [@member]");
      args.subcommand = "create";
      args.strings.name = name;
      return { command: "fg", args };
    }
    case "rename": {
      const name = tail.join(" ").trim();
      if (!name) return usage("Usage: ,fg rename <name>");
      args.subcommand = "rename";
      args.strings.name = name;
      return { command: "fg", args };
    }
    case "icon": {
      if (!tail[0]) return usage("Usage: ,fg icon <url>");
      args.subcommand = "icon";
      args.strings.url = tail[0];
      return { command: "fg", args };
    }
    case "remove":
    case "list":
    case "cleanup":
      args.subcommand = action;
      return { command: "fg", args };
    case "share": {
      const memberId = parseUserToken(tail[0]);
      const roleId = parseRoleToken(tail[1]);
      if (!memberId || !roleId) {
        return usage("Usage: ,fg share @member @role");
      }
      args.subcommand = "share";
      args.users.member = memberId;
      args.roles.role = roleId;
      return { command: "fg", args };
    }
    case "assign": {
      const memberId = parseUserToken(tail[0]);
      const roleId = parseRoleToken(tail[1]);
      if (!memberId || !roleId) {
        return usage("Usage: ,fg assign @member @role");
      }
      args.subcommand = "assign";
      args.users.member = memberId;
      args.roles.role = roleId;
      return { command: "fg", args };
    }
    case "auth": {
      const authAction = tail[0];
      if (authAction === "list") {
        const roleId = parseRoleToken(tail[1]);
        if (!roleId) return usage("Usage: ,fg auth list @role");
        args.subcommandGroup = "auth";
        args.subcommand = "list";
        args.roles.role = roleId;
        return { command: "fg", args };
      }
      if (authAction === "add" || authAction === "remove") {
        const memberId = parseUserToken(tail[1]);
        const roleId = parseRoleToken(tail[2]);
        if (!memberId || !roleId) {
          return usage(`Usage: ,fg auth ${authAction} @member @role`);
        }
        args.subcommandGroup = "auth";
        args.subcommand = authAction;
        args.users.member = memberId;
        args.roles.role = roleId;
        return { command: "fg", args };
      }
      return usage("Use ,help fg to see FG commands.");
    }
    default:
      // Bare ,fg or an unknown subcommand: point at the help page,
      // never dump every usage variant as a wall.
      return usage("Use ,help fg to see FG commands.");
  }
}

/**
 * Build a fake ChatInputCommandInteraction around a prefix message, so
 * the slash handlers run unchanged. The fake reply sends a plain message
 * to the channel (prefix replies cannot be ephemeral); error replies —
 * flagged by the handlers with WILD_ERROR_REPLY — auto-delete after 10
 * seconds, best-effort. Success replies stay.
 */
function buildFakeInteraction(
  message: Message,
  commandName: string,
  args: PrefixArgs,
  member: GuildMember | null,
): ChatInputCommandInteraction {
  let lastSent: Message | null = null;

  const reply = async (options: Record<string | symbol, unknown>) => {
    const channel = message.channel;
    if (!("send" in channel)) {
      throw new Error("Cannot send messages in this channel.");
    }
    const sent = await channel.send({
      content: options.content as string | undefined,
      embeds: options.embeds as never,
      components: options.components as never,
      allowedMentions: options.allowedMentions as never,
    });
    lastSent = sent;
    if (options[WILD_ERROR_REPLY]) {
      const timer = setTimeout(() => {
        sent.delete().catch(() => undefined);
      }, ERROR_DELETE_DELAY_MS);
      timer.unref?.();
    }
    return sent;
  };

  // A raw id in ,whitelist may be a role id, not a user id. Check the
  // guild's role cache first, like the slash path's role option would.
  const resolveWhitelistTarget = (): { user: string | null; role: string | null } => {
    const raw = args.strings.__rawTarget;
    if (raw && SNOWFLAKE.test(raw) && message.guild?.roles.cache.has(raw)) {
      return { user: null, role: raw };
    }
    return {
      user: args.users.user ?? null,
      role: args.roles.role ?? null,
    };
  };

  // The fake interaction's member drives every permission gate the
  // shared handlers run (owner/Administrator/whitelist). It is passed in
  // already fetched fresh from the API by handlePrefixMessage:
  // `message.member` is cached and can be stale — a member who lost
  // Administrator still looks like one.
  const fake = {
    commandName,
    guild: message.guild,
    guildId: message.guild?.id ?? null,
    user: message.author,
    member,
    memberPermissions:
      member?.permissions ?? { has: () => false },
    options: {
      getRole: (name: string) => {
        if (commandName === "whitelist") {
          const roleId = resolveWhitelistTarget().role;
          return roleId ? { id: roleId } : null;
        }
        const id = args.roles[name];
        return id ? { id } : null;
      },
      getUser: (name: string) => {
        if (commandName === "whitelist") {
          const userId = resolveWhitelistTarget().user;
          return userId ? { id: userId } : null;
        }
        const id = args.users[name];
        return id ? { id } : null;
      },
      getChannel: (name: string) => {
        const id = args.channels[name];
        return id ? { id } : null;
      },
      getString: (name: string) => args.strings[name] ?? null,
      getSubcommand: () => args.subcommand,
      getSubcommandGroup: () => args.subcommandGroup,
    },
    reply,
    fetchReply: async () => lastSent,
    replied: false,
    deferred: false,
  };
  return fake as unknown as ChatInputCommandInteraction;
}

async function replyPrefixError(message: Message, content: string): Promise<void> {
  const channel = message.channel;
  if (!("send" in channel)) return;
  const sent = await channel
    .send({ embeds: [wildMessageEmbed(content)], allowedMentions: { parse: [] } })
    .catch(() => null);
  if (!sent) return;
  const timer = setTimeout(() => {
    sent.delete().catch(() => undefined);
  }, ERROR_DELETE_DELAY_MS);
  timer.unref?.();
}

/**
 * Handle one message as a possible prefix command. Returns true when the
 * message was a Wild prefix command (known name, even with bad usage);
 * false when it was not one — the caller must leave such messages alone,
 * since they may belong to Bleed or another bot. Only call this for
 * non-bot messages in guilds; DMs are ignored.
 */
export async function handlePrefixMessage(
  message: Message,
  store: ConfigStore,
): Promise<boolean> {
  if (message.author.bot || !message.guild) return false;
  const parsed = parsePrefixMessage(message.content);
  if (!parsed) return false;

  if ("error" in parsed) {
    await replyPrefixError(message, parsed.error);
    await message.delete().catch(() => undefined);
    return true;
  }

  const { command, args } = parsed;
  // ,guard and ,logchannel are prefix-only names for the /protect and
  // /setup slash commands — map them back so the shared handler routes.
  const slashCommand = SLASH_COMMAND_NAME[command] ?? command;
  // Fetch the author fresh from the API: `message.member` is cached and
  // can be stale (a member who lost Administrator still looks like one),
  // and the fake interaction's member drives every permission gate.
  // Fall back to the cached member only when the fetch fails.
  const freshMember = message.guild
    ? await fetchMemberFresh(message.guild, message.author.id)
    : null;
  const interaction = buildFakeInteraction(
    message,
    slashCommand,
    args,
    (freshMember ?? message.member ?? null) as GuildMember | null,
  );
  try {
    if (slashCommand === "fg") {
      await handleFgCommand(interaction, store);
    } else if (slashCommand === "help") {
      await handleHelpCommand(interaction, store, "prefix");
    } else {
      await handleGuardCommand(interaction, store);
    }
  } catch {
    await replyPrefixError(
      message,
      "The bot couldn't complete that command. Check its permissions and try again.",
    );
  }

  // Prefix replies cannot be ephemeral, so the command itself is removed
  // (best-effort) to keep the channel tidy. Unknown "," commands are
  // never deleted — they may be Greed's.
  await message.delete().catch(() => undefined);
  return true;
}
