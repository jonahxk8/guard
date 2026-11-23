import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonInteraction,
  ButtonStyle,
  ChatInputCommandInteraction,
  ComponentType,
  Message,
  SlashCommandBuilder,
} from "discord.js";
import { WildField, wildFieldEmbed } from "./embeds.js";
import { WILD_ERROR_REPLY } from "./reply.js";

/**
 * Help pages, Greed-style: paged black embeds, one field per command,
 * buttons to move between pages. Plain text only — no emojis anywhere,
 * including on buttons ("Prev", "Next", "Back", never arrow symbols).
 *
 * Pages:
 * - Main: the 3 categories as fields, with [Guard] [FG] [Blacklist]
 *   buttons.
 * - Category: one field per command (name = slash syntax, then prefix
 *   syntax; value = purpose, then "Who: ..."). FG has 12 subcommands,
 *   so it splits into 2 pages of 6; Guard and Blacklist fit on one page.
 *   Buttons: [Prev] [Next] where there is another page, plus [Back].
 * - Single command: title is the command; fields are Syntax, What it
 *   does, Who can use it, Example. Button: [Back] to its category page.
 *
 * The same handler serves /help and ,help. Help is ephemeral on slash;
 * on prefix it is a public message (Discord has no ephemeral prefix
 * replies) and the invoking ,help message is deleted like other prefix
 * commands. Only the user who ran /help or ,help may use the buttons —
 * anyone else gets an ephemeral "This help menu isn't yours" reply.
 * Buttons stop working after 5 minutes; they are disabled then.
 */

const HELP_BUTTON_PREFIX = "wild-help:";
const HELP_BUTTON_TIMEOUT_MS = 5 * 60 * 1000;
const FG_PAGE_SIZE = 6;

interface HelpEntry {
  /** Lookup key, e.g. "fg create". */
  key: string;
  slash: string;
  prefix: string;
  purpose: string;
  who: string;
  example: string;
}

interface HelpCategory {
  key: string;
  title: string;
  summary: string;
  entries: HelpEntry[];
}

const GUARD_ENTRIES: HelpEntry[] = [
  {
    key: "protect",
    slash: "/protect @role",
    prefix: ",guard @role",
    purpose: "Protect a role, or stop protecting it",
    who: "Manage Server",
    example: "/protect @Pic",
  },
  {
    key: "whitelist",
    slash: "/whitelist @user or @role",
    prefix: ",whitelist @user or @role",
    purpose: "Whitelist a member or role so they can assign protected roles",
    who: "Manage Server",
    example: "/whitelist @Alex",
  },
  {
    key: "status",
    slash: "/status",
    prefix: ",status",
    purpose: "View protected roles, FG roles, whitelist and blacklist",
    who: "Manage Server",
    example: "/status",
  },
  {
    key: "setup",
    slash: "/setup #channel",
    prefix: ",logchannel #channel or ,logchannel off",
    purpose: "Set the alert channel, or turn alerts off",
    who: "Manage Server",
    example: "/setup #mod-log",
  },
];

const FG_ENTRIES: HelpEntry[] = [
  {
    key: "fg base",
    slash: "/fg base @role",
    prefix: ",fg base @role",
    purpose: "Set the base role FG roles sit under",
    who: "Manage Server",
    example: "/fg base @FG",
  },
  {
    key: "fg color",
    slash: "/fg color <color> <name>",
    prefix: ",fg color <color> <name> [second_color]",
    purpose: "Make your own FG role with a colour",
    who: "Server owner or whitelisted members",
    example: "/fg color #ff0000 My Role",
  },
  {
    key: "fg create",
    slash: "/fg create <name> <color> [second_color] [@member]",
    prefix: ",fg create <name> <color> [second_color] [@member]",
    purpose: "Create an FG role for yourself or a member",
    who: "Server owner or whitelisted members",
    example: "/fg create My Role #ff0000 @Alex",
  },
  {
    key: "fg rename",
    slash: "/fg rename <name>",
    prefix: ",fg rename <name>",
    purpose: "Rename your own FG role",
    who: "Anyone with an FG role",
    example: "/fg rename New Name",
  },
  {
    key: "fg icon",
    slash: "/fg icon <url>",
    prefix: ",fg icon <url>",
    purpose: "Set your own FG role's icon",
    who: "Anyone with an FG role",
    example: "/fg icon https://example.com/icon.png",
  },
  {
    key: "fg remove",
    slash: "/fg remove",
    prefix: ",fg remove",
    purpose: "Delete your own FG role",
    who: "Anyone with an FG role",
    example: "/fg remove",
  },
  {
    key: "fg list",
    slash: "/fg list",
    prefix: ",fg list",
    purpose: "List all FG roles and their owners",
    who: "Manage Server or whitelisted members",
    example: "/fg list",
  },
  {
    key: "fg cleanup",
    slash: "/fg cleanup",
    prefix: ",fg cleanup",
    purpose: "Remove FG roles whose owners left the server",
    who: "Manage Server",
    example: "/fg cleanup",
  },
  {
    key: "fg share",
    slash: "/fg share @member @role",
    prefix: ",fg share @member @role",
    purpose: "Offer one of your FG roles to a member",
    who: "FG role holder, whitelisted",
    example: "/fg share @Alex @My Role",
  },
  {
    key: "fg award set",
    slash: "/fg award set @role",
    prefix: ",fg award set @role",
    purpose: "Set the shared role given when someone makes an FG role",
    who: "Manage Server",
    example: "/fg award set @Booster",
  },
  {
    key: "fg award view",
    slash: "/fg award view",
    prefix: ",fg award view",
    purpose: "View the award role",
    who: "Manage Server",
    example: "/fg award view",
  },
  {
    key: "fg award remove",
    slash: "/fg award remove",
    prefix: ",fg award remove",
    purpose: "Clear the award role",
    who: "Manage Server",
    example: "/fg award remove",
  },
];

const BLACKLIST_ENTRIES: HelpEntry[] = [
  {
    key: "blacklist add",
    slash: "/blacklist add @user @role",
    prefix: ",blacklist add @user @role",
    purpose: "Block a member from a protected role",
    who: "Manage Server",
    example: "/blacklist add @Alex @Pic",
  },
  {
    key: "blacklist remove",
    slash: "/blacklist remove @user @role",
    prefix: ",blacklist remove @user @role",
    purpose: "Unblock a member from a protected role",
    who: "Manage Server",
    example: "/blacklist remove @Alex @Pic",
  },
  {
    key: "blacklist list",
    slash: "/blacklist list",
    prefix: ",blacklist list",
    purpose: "List everyone blacklisted from a role",
    who: "Manage Server or whitelisted members",
    example: "/blacklist list",
  },
];

export const HELP_CATEGORIES: HelpCategory[] = [
  {
    key: "guard",
    title: "Guard",
    summary: "Protect roles and whitelist the people who can assign them",
    entries: GUARD_ENTRIES,
  },
  {
    key: "fg",
    title: "FG",
    summary: "Personal FG roles - make, colour, rename, icon, share",
    entries: FG_ENTRIES,
  },
  {
    key: "blacklist",
    title: "Blacklist",
    summary: "Block members from protected roles",
    entries: BLACKLIST_ENTRIES,
  },
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

export interface HelpButtonSpec {
  /** Target after "wild-help:<ownerId>:", e.g. "category:fg:2". */
  id: string;
  label: string;
}

export interface HelpPage {
  title: string;
  description?: string;
  fields: WildField[];
  buttons: HelpButtonSpec[];
  kind: "main" | "category" | "command";
  category?: string;
  page?: number;
  totalPages?: number;
  entryKey?: string;
}

export type HelpResult =
  | { kind: "embed"; page: HelpPage }
  | { kind: "error"; message: string };

function entryField(entry: HelpEntry): WildField {
  return {
    name: `\`${entry.slash}\`\n\`${entry.prefix}\``,
    value: `${entry.purpose}\nWho: ${entry.who}`,
  };
}

function mainHelpPage(): HelpPage {
  return {
    title: "Wild help",
    description: "Pick a category below, or use /help <command> for one command.",
    fields: HELP_CATEGORIES.map((category) => ({
      name: category.title,
      value:
        `${category.summary}\n` +
        `Use /help ${category.key} - ${category.entries.length} commands`,
    })),
    buttons: HELP_CATEGORIES.map((category) => ({
      id: `category:${category.key}:1`,
      label: category.title,
    })),
    kind: "main",
  };
}

function categoryHelpPage(category: HelpCategory, page: number): HelpPage {
  const totalPages = Math.max(1, Math.ceil(category.entries.length / FG_PAGE_SIZE));
  const safePage = Math.min(Math.max(1, page), totalPages);
  const start = (safePage - 1) * FG_PAGE_SIZE;
  const entries = category.entries.slice(start, start + FG_PAGE_SIZE);
  const title =
    totalPages > 1
      ? `Wild help - ${category.title} (${safePage}/${totalPages})`
      : `Wild help - ${category.title}`;
  const buttons: HelpButtonSpec[] = [];
  if (safePage > 1) {
    buttons.push({ id: `category:${category.key}:${safePage - 1}`, label: "Prev" });
  }
  if (safePage < totalPages) {
    buttons.push({ id: `category:${category.key}:${safePage + 1}`, label: "Next" });
  }
  buttons.push({ id: "main", label: "Back" });
  return {
    title,
    description: category.summary,
    fields: entries.map(entryField),
    buttons,
    kind: "category",
    category: category.key,
    page: safePage,
    totalPages,
  };
}

function entryHelpPage(entry: HelpEntry): HelpPage {
  const category = HELP_CATEGORIES.find((item) =>
    item.entries.some((candidate) => candidate.key === entry.key),
  )!;
  const index = category.entries.findIndex(
    (candidate) => candidate.key === entry.key,
  );
  const page = Math.floor(index / FG_PAGE_SIZE) + 1;
  return {
    title: entry.key,
    fields: [
      {
        name: "Syntax",
        value: `\`${entry.slash}\`\n\`${entry.prefix}\``,
      },
      { name: "What it does", value: entry.purpose },
      { name: "Who can use it", value: entry.who },
      { name: "Example", value: `\`${entry.example}\`` },
    ],
    buttons: [{ id: `category:${category.key}:${page}`, label: "Back" }],
    kind: "command",
    category: category.key,
    page,
    entryKey: entry.key,
  };
}

/** Encode an entry key ("fg award set") for a button customId. */
function encodeEntryKey(key: string): string {
  return key.replace(/ /g, "_");
}

function decodeEntryKey(encoded: string): string {
  return encoded.replace(/_/g, " ");
}

/** Resolve a navigation target ("main", "category:fg:2", "command:fg_create"). */
export function resolveHelpTarget(target: string): HelpResult {
  const cleaned = target.trim().toLowerCase();
  if (!cleaned || cleaned === "main") {
    return { kind: "embed", page: mainHelpPage() };
  }
  const categoryMatch = cleaned.match(/^category:([a-z]+)(?::(\d+))?$/);
  if (categoryMatch) {
    const category = HELP_CATEGORIES.find(
      (entry) => entry.key === categoryMatch[1],
    );
    if (category) {
      return {
        kind: "embed",
        page: categoryHelpPage(category, Number(categoryMatch[2] ?? "1")),
      };
    }
  }
  const commandMatch = cleaned.match(/^command:(.+)$/);
  if (commandMatch) {
    const entry = ALL_ENTRIES.find(
      (item) => item.key === decodeEntryKey(commandMatch[1]),
    );
    if (entry) return { kind: "embed", page: entryHelpPage(entry) };
  }
  return {
    kind: "error",
    message: "That help page is gone. Use /help to see all commands.",
  };
}

/** Resolve a help topic to a page, or an error when it matches nothing. */
export function resolveHelpTopic(topic: string | null): HelpResult {
  const cleaned = (topic ?? "").trim().toLowerCase().replace(/^[/,]+/, "");
  if (!cleaned || cleaned === "help") {
    return { kind: "embed", page: mainHelpPage() };
  }
  const categoryMatch = cleaned.match(/^([a-z]+)(?:\s+(\d+))?$/);
  if (categoryMatch) {
    const category = HELP_CATEGORIES.find(
      (entry) => entry.key === categoryMatch[1],
    );
    if (category) {
      return {
        kind: "embed",
        page: categoryHelpPage(category, Number(categoryMatch[2] ?? "1")),
      };
    }
  }
  const direct = ALL_ENTRIES.find((entry) => entry.key === cleaned);
  if (direct) {
    return { kind: "embed", page: entryHelpPage(direct) };
  }
  // "protect" / "logchannel" are the slash/prefix names for the same
  // guard commands; "guard" alone is the Guard category (handled above).
  const alias: Record<string, string> = {
    logchannel: "setup",
  };
  const aliased = alias[cleaned]
    ? ALL_ENTRIES.find((entry) => entry.key === alias[cleaned])
    : undefined;
  if (aliased) {
    return { kind: "embed", page: entryHelpPage(aliased) };
  }
  const fgSingle = FG_SINGLE_WORDS[cleaned];
  if (fgSingle) {
    const entry = ALL_ENTRIES.find((item) => item.key === fgSingle)!;
    return { kind: "embed", page: entryHelpPage(entry) };
  }
  return {
    kind: "error",
    message: `No help for "${topic?.trim()}". Use /help to see all commands.`,
  };
}

/** Build the button row for a help page, for the user who opened it. */
export function buildHelpComponents(
  page: HelpPage,
  ownerId: string,
): ActionRowBuilder<ButtonBuilder>[] {
  if (page.buttons.length === 0) return [];
  const row = new ActionRowBuilder<ButtonBuilder>();
  for (const button of page.buttons) {
    row.addComponents(
      new ButtonBuilder()
        .setCustomId(`${HELP_BUTTON_PREFIX}${ownerId}:${button.id}`)
        .setLabel(button.label)
        .setStyle(ButtonStyle.Secondary),
    );
  }
  return [row];
}

function buildDisabledComponents(
  page: HelpPage,
  ownerId: string,
): ActionRowBuilder<ButtonBuilder>[] {
  return buildHelpComponents(page, ownerId).map((row) =>
    new ActionRowBuilder<ButtonBuilder>().addComponents(
      row.components.map((component) =>
        ButtonBuilder.from(component).setDisabled(true),
      ),
    ),
  );
}

/** Parse a help button customId into its owner and navigation target. */
export function parseHelpButton(
  customId: string,
): { ownerId: string; target: string } | null {
  if (!customId.startsWith(HELP_BUTTON_PREFIX)) return null;
  const rest = customId.slice(HELP_BUTTON_PREFIX.length);
  const separator = rest.indexOf(":");
  if (separator <= 0) return null;
  return { ownerId: rest.slice(0, separator), target: rest.slice(separator + 1) };
}

/**
 * Handle a help navigation button press. Returns the page navigated to,
 * or null when the press was rejected (wrong user) or the target is gone.
 * The caller (the help collector) uses the returned page to refresh the
 * disabled-buttons state when the menu times out.
 */
export async function handleHelpButton(
  button: ButtonInteraction,
): Promise<HelpPage | null> {
  const parsed = parseHelpButton(button.customId);
  if (!parsed) {
    await button.deferUpdate().catch(() => undefined);
    return null;
  }
  if (button.user.id !== parsed.ownerId) {
    await button
      .reply({
        content: "This help menu isn't yours - run /help to get your own.",
        ephemeral: true,
      })
      .catch(() => undefined);
    return null;
  }
  const result = resolveHelpTarget(parsed.target);
  if (result.kind === "error") {
    await button
      .reply({ content: result.message, ephemeral: true })
      .catch(() => undefined);
    return null;
  }
  await button
    .update({
      embeds: [
        wildFieldEmbed(
          result.page.title,
          result.page.fields,
          result.page.description,
        ),
      ],
      components: buildHelpComponents(result.page, parsed.ownerId),
      allowedMentions: { parse: [] },
    })
    .catch(() => undefined);
  return result.page;
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
  const page = result.page;
  const ownerId = interaction.user.id;
  await interaction.reply({
    embeds: [wildFieldEmbed(page.title, page.fields, page.description)],
    components: buildHelpComponents(page, ownerId),
    ephemeral: true,
    allowedMentions: { parse: [] },
  });

  // Greed-style navigation: buttons live for 5 minutes, then disable.
  // Best-effort only — test doubles and channels without a fetchable
  // reply simply skip the collector.
  let message: Message | null = null;
  try {
    const fetched = await interaction.fetchReply();
    if (
      fetched &&
      typeof (fetched as Message).createMessageComponentCollector === "function"
    ) {
      message = fetched as Message;
    }
  } catch {
    message = null;
  }
  if (!message) return;

  let currentPage: HelpPage = page;
  const collector = message.createMessageComponentCollector({
    componentType: ComponentType.Button,
    time: HELP_BUTTON_TIMEOUT_MS,
  });
  collector.on("collect", async (button) => {
    if (!button.customId.startsWith(HELP_BUTTON_PREFIX)) {
      await button.deferUpdate().catch(() => undefined);
      return;
    }
    const nextPage = await handleHelpButton(button);
    if (nextPage) currentPage = nextPage;
  });
  collector.on("end", async () => {
    await message
      ?.edit({ components: buildDisabledComponents(currentPage, ownerId) })
      .catch(() => undefined);
  });
}
