import {
  ChatInputCommandInteraction,
  SlashCommandBuilder,
} from "discord.js";
import { wildEmbed } from "./embeds.js";
import { WILD_ERROR_REPLY } from "./reply.js";

/**
 * Help pages, Greed/Bleed style: one black embed, grouped by category,
 * one command per line with a one-line purpose — never a pipe-separated
 * usage wall. The same handler serves /help and ,help.
 *
 * Categories: Guard, FG, Blacklist. A topic can be a category
 * ("guard", "fg", "blacklist") or one command ("fg create",
 * "blacklist add", "protect"). Unknown topic -> short plain error
 * pointing at /help.
 */

interface HelpEntry {
  /** Lookup key, e.g. "fg create". */
  key: string;
  slash: string;
  prefix: string;
  purpose: string;
  who: string;
}

interface HelpCategory {
  key: string;
  title: string;
  entries: HelpEntry[];
}

const GUARD_ENTRIES: HelpEntry[] = [
  {
    key: "protect",
    slash: "/protect @role",
    prefix: ",guard @role",
    purpose: "Protect a role, or stop protecting it",
    who: "Manage Server",
  },
  {
    key: "whitelist",
    slash: "/whitelist @user or @role",
    prefix: ",whitelist @user or @role",
    purpose: "Whitelist a member or role so they can assign protected roles",
    who: "Manage Server",
  },
  {
    key: "status",
    slash: "/status",
    prefix: ",status",
    purpose: "View protected roles, FG roles, whitelist and blacklist",
    who: "Manage Server",
  },
  {
    key: "setup",
    slash: "/setup #channel",
    prefix: ",logchannel #channel or ,logchannel off",
    purpose: "Set the alert channel, or turn alerts off",
    who: "Manage Server",
  },
];

const FG_ENTRIES: HelpEntry[] = [
  {
    key: "fg base",
    slash: "/fg base @role",
    prefix: ",fg base @role",
    purpose: "Set the base role FG roles sit under",
    who: "Manage Server",
  },
  {
    key: "fg color",
    slash: "/fg color <color> <name>",
    prefix: ",fg color <color> <name> [second_color]",
    purpose: "Make your own FG role with a colour",
    who: "Server owner or whitelisted members",
  },
  {
    key: "fg create",
    slash: "/fg create <name> <color> [second_color] [@member]",
    prefix: ",fg create <name> <color> [second_color] [@member]",
    purpose: "Create an FG role for yourself or a member",
    who: "Server owner or whitelisted members",
  },
  {
    key: "fg rename",
    slash: "/fg rename <name>",
    prefix: ",fg rename <name>",
    purpose: "Rename your own FG role",
    who: "Anyone with an FG role",
  },
  {
    key: "fg icon",
    slash: "/fg icon <url>",
    prefix: ",fg icon <url>",
    purpose: "Set your own FG role's icon",
    who: "Anyone with an FG role",
  },
  {
    key: "fg remove",
    slash: "/fg remove",
    prefix: ",fg remove",
    purpose: "Delete your own FG role",
    who: "Anyone with an FG role",
  },
  {
    key: "fg list",
    slash: "/fg list",
    prefix: ",fg list",
    purpose: "List all FG roles and their owners",
    who: "Manage Server or whitelisted members",
  },
  {
    key: "fg cleanup",
    slash: "/fg cleanup",
    prefix: ",fg cleanup",
    purpose: "Remove FG roles whose owners left the server",
    who: "Manage Server",
  },
  {
    key: "fg share",
    slash: "/fg share @member @role",
    prefix: ",fg share @member @role",
    purpose: "Offer one of your FG roles to a member",
    who: "FG role holder, whitelisted",
  },
  {
    key: "fg award set",
    slash: "/fg award set @role",
    prefix: ",fg award set @role",
    purpose: "Set the shared role given when someone makes an FG role",
    who: "Manage Server",
  },
  {
    key: "fg award view",
    slash: "/fg award view",
    prefix: ",fg award view",
    purpose: "View the award role",
    who: "Manage Server",
  },
  {
    key: "fg award remove",
    slash: "/fg award remove",
    prefix: ",fg award remove",
    purpose: "Clear the award role",
    who: "Manage Server",
  },
];

const BLACKLIST_ENTRIES: HelpEntry[] = [
  {
    key: "blacklist add",
    slash: "/blacklist add @user @role",
    prefix: ",blacklist add @user @role",
    purpose: "Block a member from a protected role",
    who: "Manage Server",
  },
  {
    key: "blacklist remove",
    slash: "/blacklist remove @user @role",
    prefix: ",blacklist remove @user @role",
    purpose: "Unblock a member from a protected role",
    who: "Manage Server",
  },
  {
    key: "blacklist list",
    slash: "/blacklist list",
    prefix: ",blacklist list",
    purpose: "List everyone blacklisted from a role",
    who: "Manage Server or whitelisted members",
  },
];

export const HELP_CATEGORIES: HelpCategory[] = [
  { key: "guard", title: "Guard", entries: GUARD_ENTRIES },
  { key: "fg", title: "FG", entries: FG_ENTRIES },
  { key: "blacklist", title: "Blacklist", entries: BLACKLIST_ENTRIES },
];

const ALL_ENTRIES: HelpEntry[] = HELP_CATEGORIES.flatMap(
  (category) => category.entries,
);

/** One-word FG subcommands that resolve to their FG entry. */
const FG_SINGLE_WORDS: Record<string, string> = {
  base: "fg base",
  color: "fg color",
  create: "fg create",
  rename: "fg rename",
  icon: "fg icon",
  remove: "fg remove",
  cleanup: "fg cleanup",
  share: "fg share",
};

export const helpCommand = new SlashCommandBuilder()
  .setName("help")
  .setDescription("Show Wild's commands, or help for one command")
  .addStringOption((option) =>
    option
      .setName("topic")
      .setDescription(
        "A category (guard, fg, blacklist) or a command (fg create, blacklist add)",
      ),
  );

function mainHelpDescription(): string {
  const lines: string[] = [];
  for (const category of HELP_CATEGORIES) {
    lines.push(`**${category.title}**`);
    for (const entry of category.entries) {
      lines.push(`${entry.slash} — ${entry.purpose}`);
    }
  }
  lines.push(
    "Prefix works too: swap / for , — ,guard is /protect and ,logchannel is /setup.",
    "Use /help fg, /help guard, or /help blacklist for one category, or /help <command> for one command.",
  );
  return lines.join("\n");
}

function categoryHelpDescription(category: HelpCategory): string {
  return category.entries
    .map(
      (entry) =>
        `${entry.slash}  •  ${entry.prefix}\n${entry.purpose} — ${entry.who}`,
    )
    .join("\n");
}

function entryHelpDescription(entry: HelpEntry): string {
  return [
    entry.purpose,
    `Slash: ${entry.slash}`,
    `Prefix: ${entry.prefix}`,
    `Who can use it: ${entry.who}`,
  ].join("\n");
}

type HelpResult =
  | { kind: "embed"; title: string; description: string }
  | { kind: "error"; message: string };

/** Resolve a help topic to a page, or an error when it matches nothing. */
export function resolveHelpTopic(topic: string | null): HelpResult {
  const cleaned = (topic ?? "").trim().toLowerCase().replace(/^[/,]+/, "");
  if (!cleaned || cleaned === "help") {
    return { kind: "embed", title: "Wild help", description: mainHelpDescription() };
  }
  const category = HELP_CATEGORIES.find((entry) => entry.key === cleaned);
  if (category) {
    return {
      kind: "embed",
      title: `Wild help — ${category.title}`,
      description: categoryHelpDescription(category),
    };
  }
  const direct = ALL_ENTRIES.find((entry) => entry.key === cleaned);
  if (direct) {
    return {
      kind: "embed",
      title: direct.key,
      description: entryHelpDescription(direct),
    };
  }
  // "protect" / "logchannel" are the slash/prefix names for the same
  // guard commands; "guard" alone is the Guard category (handled above).
  const alias: Record<string, string> = {
    logchannel: "setup",
  };
  const aliased = alias[cleaned] ? ALL_ENTRIES.find((entry) => entry.key === alias[cleaned]) : undefined;
  if (aliased) {
    return {
      kind: "embed",
      title: aliased.key,
      description: entryHelpDescription(aliased),
    };
  }
  const fgSingle = FG_SINGLE_WORDS[cleaned];
  if (fgSingle) {
    const entry = ALL_ENTRIES.find((item) => item.key === fgSingle)!;
    return {
      kind: "embed",
      title: entry.key,
      description: entryHelpDescription(entry),
    };
  }
  return {
    kind: "error",
    message: `No help for "${topic?.trim()}". Use /help to see all commands.`,
  };
}

export async function handleHelpCommand(
  interaction: ChatInputCommandInteraction,
): Promise<void> {
  const topic = interaction.options.getString("topic");
  const result = resolveHelpTopic(topic);
  if (result.kind === "error") {
    await interaction.reply({
      content: result.message,
      ephemeral: true,
      [WILD_ERROR_REPLY]: true,
    } as Parameters<ChatInputCommandInteraction["reply"]>[0]);
    return;
  }
  await interaction.reply({
    embeds: [wildEmbed(result.title, result.description)],
    ephemeral: true,
    allowedMentions: { parse: [] },
  });
}
