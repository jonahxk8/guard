import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonInteraction,
  ButtonStyle,
  ChatInputCommandInteraction,
  ComponentType,
  GuildMember,
  Message,
  PermissionFlagsBits,
  SlashCommandBuilder,
} from "discord.js";
import { ConfigStore, GuildSettings } from "./config-store.js";
import { isWhitelisted } from "./authorization.js";
import { WildField, wildFieldEmbed } from "./embeds.js";
import { WILD_ERROR_REPLY } from "./reply.js";

/**
 * Help pages, Greed-style: paged embeds, one field per command, buttons
 * to move between pages. Plain text only — no emojis anywhere, including
 * on buttons ("Prev", "Next", "Back", never arrow symbols). No colour
 * set on any embed, so the pages blend into the chat background.
 *
 * Who sees what (gating): privileged means the server owner, a member
 * with the Discord Administrator permission, a whitelisted user, or a
 * member holding a whitelisted role. Privileged users see the full menu
 * (Guard, FG, Blacklist). A normal user sees FG only — no Guard or
 * Blacklist buttons, fields, or syntax — and FG pages hide the
 * admin-only subcommands (base, list, cleanup, award) entirely. Asking
 * for an admin-only command as a normal user gets a short error, never
 * the command's syntax.
 *
 * Sleek layout: help shows only the syntax for the form it was invoked
 * with — /help shows slash forms, ,help shows prefix forms. One field
 * per command: name is the syntax in backticks, value is a short purpose
 * (a few words) plus a short "Who: ..." tag. No em dashes, no extra
 * intro paragraphs.
 *
 * Pages:
 * - Main: the visible categories as fields, with buttons to jump to
 *   each one.
 * - Category: one field per visible command. FG has 12 subcommands for
 *   privileged users, so it splits into 2 pages of 6; for a normal user
 *   only 6 FG commands are visible, so it fits on one page. Guard and
 *   Blacklist fit on one page. Buttons: [Prev] [Next] where there is
 *   another page, plus [Back].
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

export const ADMIN_ONLY_HELP_ERROR =
  "That command is for admins and whitelisted members.";
export const ADMIN_ONLY_CATEGORY_ERROR =
  "That help is for admins and whitelisted members.";

export type HelpMode = "slash" | "prefix";

export interface HelpContext {
  privileged: boolean;
  mode: HelpMode;
}

export const DEFAULT_HELP_CONTEXT: HelpContext = {
  privileged: true,
  mode: "slash",
};

/**
 * Privileged for help: the server owner, a member with the Discord
 * Administrator permission, a whitelisted user, or a member holding a
 * whitelisted role. When there is no member to check (DMs, test
 * doubles), treat the user as privileged — there is no server to
 * gate against.
 */
export function isHelpPrivileged(
  member: unknown,
  guildOwnerId: string | null | undefined,
  settings: GuildSettings | null | undefined,
): boolean {
  if (!member || typeof member !== "object") return true;
  const candidate = member as {
    id?: unknown;
    permissions?: { has?: unknown };
  };
  if (
    typeof candidate.id === "string" &&
    guildOwnerId &&
    candidate.id === guildOwnerId
  ) {
    return true;
  }
  const has = candidate.permissions?.has;
  if (typeof has === "function") {
    try {
      if (
        (has as (permission: bigint) => boolean).call(
          candidate.permissions,
          PermissionFlagsBits.Administrator,
        )
      ) {
        return true;
      }
    } catch {
      // A member shape without usable permissions is not privileged
      // by permission — fall through to the whitelist check.
    }
  }
  if (settings) {
    try {
      if (isWhitelisted(member as GuildMember, settings)) return true;
    } catch {
      // A member shape the whitelist cannot read is not privileged.
    }
  }
  return false;
}

interface HelpEntry {
  /** Lookup key, e.g. "fg create". */
  key: string;
  slash: string;
  prefix: string;
  purpose: string;
  who: string;
  example: string;
  examplePrefix: string;
  /** True when only privileged users may see or use this command. */
  privilegedOnly?: boolean;
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
    purpose: "Protect a role",
    who: "Manage Server",
    example: "/protect @Pic",
    examplePrefix: ",guard @Pic",
    privilegedOnly: true,
  },
  {
    key: "whitelist",
    slash: "/whitelist @user or @role",
    prefix: ",whitelist @user or @role",
    purpose: "Whitelist a member or role",
    who: "Manage Server",
    example: "/whitelist @Alex",
    examplePrefix: ",whitelist @Alex",
    privilegedOnly: true,
  },
  {
    key: "status",
    slash: "/status",
    prefix: ",status",
    purpose: "View protection settings",
    who: "Manage Server",
    example: "/status",
    examplePrefix: ",status",
    privilegedOnly: true,
  },
  {
    key: "setup",
    slash: "/setup #channel",
    prefix: ",logchannel #channel or ,logchannel off",
    purpose: "Set the alert channel",
    who: "Manage Server",
    example: "/setup #mod-log",
    examplePrefix: ",logchannel #mod-log",
    privilegedOnly: true,
  },
];

const FG_ENTRIES: HelpEntry[] = [
  {
    key: "fg base",
    slash: "/fg base @role",
    prefix: ",fg base @role",
    purpose: "Set the FG base role",
    who: "Manage Server",
    example: "/fg base @FG",
    examplePrefix: ",fg base @FG",
    privilegedOnly: true,
  },
  {
    key: "fg color",
    slash: "/fg color <color> <name>",
    prefix: ",fg color <color> <name> [second_color]",
    purpose: "Make your own FG role",
    who: "Owner / whitelisted",
    example: "/fg color #ff0000 My Role",
    examplePrefix: ",fg color #ff0000 My Role",
  },
  {
    key: "fg create",
    slash: "/fg create <name> <color> [second_color] [@member]",
    prefix: ",fg create <name> <color> [second_color] [@member]",
    purpose: "Create an FG role",
    who: "Owner / whitelisted",
    example: "/fg create My Role #ff0000 @Alex",
    examplePrefix: ",fg create My Role #ff0000 @Alex",
  },
  {
    key: "fg rename",
    slash: "/fg rename <name>",
    prefix: ",fg rename <name>",
    purpose: "Rename your FG role",
    who: "FG role holder",
    example: "/fg rename New Name",
    examplePrefix: ",fg rename New Name",
  },
  {
    key: "fg icon",
    slash: "/fg icon <url>",
    prefix: ",fg icon <url>",
    purpose: "Set your FG role icon",
    who: "FG role holder",
    example: "/fg icon https://example.com/icon.png",
    examplePrefix: ",fg icon https://example.com/icon.png",
  },
  {
    key: "fg remove",
    slash: "/fg remove",
    prefix: ",fg remove",
    purpose: "Delete your FG role",
    who: "FG role holder",
    example: "/fg remove",
    examplePrefix: ",fg remove",
  },
  {
    key: "fg list",
    slash: "/fg list",
    prefix: ",fg list",
    purpose: "List FG roles and owners",
    who: "Manage Server / whitelisted",
    example: "/fg list",
    examplePrefix: ",fg list",
    privilegedOnly: true,
  },
  {
    key: "fg cleanup",
    slash: "/fg cleanup",
    prefix: ",fg cleanup",
    purpose: "Remove FG roles of leavers",
    who: "Manage Server",
    example: "/fg cleanup",
    examplePrefix: ",fg cleanup",
    privilegedOnly: true,
  },
  {
    key: "fg share",
    slash: "/fg share @member @role",
    prefix: ",fg share @member @role",
    purpose: "Offer your FG role",
    who: "FG holder / whitelisted",
    example: "/fg share @Alex @My Role",
    examplePrefix: ",fg share @Alex @My Role",
  },
  {
    key: "fg award set",
    slash: "/fg award set @role",
    prefix: ",fg award set @role",
    purpose: "Set the FG award role",
    who: "Manage Server",
    example: "/fg award set @Booster",
    examplePrefix: ",fg award set @Booster",
    privilegedOnly: true,
  },
  {
    key: "fg award view",
    slash: "/fg award view",
    prefix: ",fg award view",
    purpose: "View the award role",
    who: "Manage Server",
    example: "/fg award view",
    examplePrefix: ",fg award view",
    privilegedOnly: true,
  },
  {
    key: "fg award remove",
    slash: "/fg award remove",
    prefix: ",fg award remove",
    purpose: "Clear the award role",
    who: "Manage Server",
    example: "/fg award remove",
    examplePrefix: ",fg award remove",
    privilegedOnly: true,
  },
];

const BLACKLIST_ENTRIES: HelpEntry[] = [
  {
    key: "blacklist add",
    slash: "/blacklist add @user @role",
    prefix: ",blacklist add @user @role",
    purpose: "Block a member from a role",
    who: "Manage Server",
    example: "/blacklist add @Alex @Pic",
    examplePrefix: ",blacklist add @Alex @Pic",
    privilegedOnly: true,
  },
  {
    key: "blacklist remove",
    slash: "/blacklist remove @user @role",
    prefix: ",blacklist remove @user @role",
    purpose: "Unblock a member",
    who: "Manage Server",
    example: "/blacklist remove @Alex @Pic",
    examplePrefix: ",blacklist remove @Alex @Pic",
    privilegedOnly: true,
  },
  {
    key: "blacklist list",
    slash: "/blacklist list",
    prefix: ",blacklist list",
    purpose: "List blacklisted members",
    who: "Manage Server / whitelisted",
    example: "/blacklist list",
    examplePrefix: ",blacklist list",
    privilegedOnly: true,
  },
];

export const HELP_CATEGORIES: HelpCategory[] = [
  {
    key: "guard",
    title: "Guard",
    summary: "Protect roles and whitelist assigners",
    entries: GUARD_ENTRIES,
  },
  {
    key: "fg",
    title: "FG",
    summary: "Personal FG roles",
    entries: FG_ENTRIES,
  },
  {
    key: "blacklist",
    title: "Blacklist",
    summary: "Block members from roles",
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

function visibleEntries(category: HelpCategory, ctx: HelpContext): HelpEntry[] {
  return ctx.privileged
    ? category.entries
    : category.entries.filter((entry) => !entry.privilegedOnly);
}

function visibleCategories(ctx: HelpContext): HelpCategory[] {
  // Guard and Blacklist are entirely privileged-only, so a normal user
  // sees FG alone.
  return ctx.privileged
    ? HELP_CATEGORIES
    : HELP_CATEGORIES.filter((category) => category.key === "fg");
}

function entrySyntax(entry: HelpEntry, mode: HelpMode): string {
  return mode === "prefix" ? entry.prefix : entry.slash;
}

function entryExample(entry: HelpEntry, mode: HelpMode): string {
  return mode === "prefix" ? entry.examplePrefix : entry.example;
}

function entryField(entry: HelpEntry, mode: HelpMode): WildField {
  return {
    name: `\`${entrySyntax(entry, mode)}\``,
    value: `${entry.purpose}\nWho: ${entry.who}`,
  };
}

function mainHelpPage(ctx: HelpContext): HelpPage {
  const categories = visibleCategories(ctx);
  const helpWord = ctx.mode === "prefix" ? ",help" : "/help";
  return {
    title: "Wild help",
    description: ctx.privileged
      ? `Pick a category, or ${helpWord} <command>.`
      : "Guard and Blacklist help is for admins and whitelisted members.",
    fields: categories.map((category) => ({
      name: category.title,
      value: `${category.summary}\n${visibleEntries(category, ctx).length} commands`,
    })),
    buttons: categories.map((category) => ({
      id: `category:${category.key}:1`,
      label: category.title,
    })),
    kind: "main",
  };
}

function categoryHelpPage(
  category: HelpCategory,
  page: number,
  ctx: HelpContext,
): HelpPage {
  const entries = visibleEntries(category, ctx);
  const totalPages = Math.max(1, Math.ceil(entries.length / FG_PAGE_SIZE));
  const safePage = Math.min(Math.max(1, page), totalPages);
  const start = (safePage - 1) * FG_PAGE_SIZE;
  const pageEntries = entries.slice(start, start + FG_PAGE_SIZE);
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
    fields: pageEntries.map((entry) => entryField(entry, ctx.mode)),
    buttons,
    kind: "category",
    category: category.key,
    page: safePage,
    totalPages,
  };
}

function entryHelpPage(entry: HelpEntry, ctx: HelpContext): HelpPage {
  const category = HELP_CATEGORIES.find((item) =>
    item.entries.some((candidate) => candidate.key === entry.key),
  )!;
  const visible = visibleEntries(category, ctx);
  const index = visible.findIndex(
    (candidate) => candidate.key === entry.key,
  );
  const page = Math.floor(Math.max(0, index) / FG_PAGE_SIZE) + 1;
  return {
    title: entry.key,
    fields: [
      {
        name: "Syntax",
        value: `\`${entrySyntax(entry, ctx.mode)}\``,
      },
      { name: "What it does", value: entry.purpose },
      { name: "Who can use it", value: entry.who },
      { name: "Example", value: `\`${entryExample(entry, ctx.mode)}\`` },
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
export function resolveHelpTarget(
  target: string,
  ctx: HelpContext = DEFAULT_HELP_CONTEXT,
): HelpResult {
  const cleaned = target.trim().toLowerCase();
  if (!cleaned || cleaned === "main") {
    return { kind: "embed", page: mainHelpPage(ctx) };
  }
  const categoryMatch = cleaned.match(/^category:([a-z]+)(?::(\d+))?$/);
  if (categoryMatch) {
    const category = HELP_CATEGORIES.find(
      (entry) => entry.key === categoryMatch[1],
    );
    if (category) {
      if (!ctx.privileged && category.key !== "fg") {
        return { kind: "error", message: ADMIN_ONLY_CATEGORY_ERROR };
      }
      return {
        kind: "embed",
        page: categoryHelpPage(category, Number(categoryMatch[2] ?? "1"), ctx),
      };
    }
  }
  const commandMatch = cleaned.match(/^command:(.+)$/);
  if (commandMatch) {
    const entry = ALL_ENTRIES.find(
      (item) => item.key === decodeEntryKey(commandMatch[1]),
    );
    if (entry) {
      if (!ctx.privileged && entry.privilegedOnly) {
        return { kind: "error", message: ADMIN_ONLY_HELP_ERROR };
      }
      return { kind: "embed", page: entryHelpPage(entry, ctx) };
    }
  }
  return {
    kind: "error",
    message: "That help page is gone. Use /help to see all commands.",
  };
}

/** Resolve a help topic to a page, or an error when it matches nothing. */
export function resolveHelpTopic(
  topic: string | null,
  ctx: HelpContext = DEFAULT_HELP_CONTEXT,
): HelpResult {
  const cleaned = (topic ?? "").trim().toLowerCase().replace(/^[/,]+/, "");
  if (!cleaned || cleaned === "help") {
    return { kind: "embed", page: mainHelpPage(ctx) };
  }
  const categoryMatch = cleaned.match(/^([a-z]+)(?:\s+(\d+))?$/);
  if (categoryMatch) {
    const category = HELP_CATEGORIES.find(
      (entry) => entry.key === categoryMatch[1],
    );
    if (category) {
      if (!ctx.privileged && category.key !== "fg") {
        return { kind: "error", message: ADMIN_ONLY_CATEGORY_ERROR };
      }
      return {
        kind: "embed",
        page: categoryHelpPage(category, Number(categoryMatch[2] ?? "1"), ctx),
      };
    }
  }
  const direct = ALL_ENTRIES.find((entry) => entry.key === cleaned);
  if (direct) {
    if (!ctx.privileged && direct.privilegedOnly) {
      return { kind: "error", message: ADMIN_ONLY_HELP_ERROR };
    }
    return { kind: "embed", page: entryHelpPage(direct, ctx) };
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
    if (!ctx.privileged && aliased.privilegedOnly) {
      return { kind: "error", message: ADMIN_ONLY_HELP_ERROR };
    }
    return { kind: "embed", page: entryHelpPage(aliased, ctx) };
  }
  const fgSingle = FG_SINGLE_WORDS[cleaned];
  if (fgSingle) {
    const entry = ALL_ENTRIES.find((item) => item.key === fgSingle)!;
    if (!ctx.privileged && entry.privilegedOnly) {
      return { kind: "error", message: ADMIN_ONLY_HELP_ERROR };
    }
    return { kind: "embed", page: entryHelpPage(entry, ctx) };
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

export interface HelpButtonOptions {
  privileged?: boolean;
  mode?: HelpMode;
}

/**
 * Handle a help navigation button press. Returns the page navigated to,
 * or null when the press was rejected (wrong user, or a page the user is
 * no longer privileged to see) or the target is gone. The caller (the
 * help collector) uses the returned page to refresh the disabled-buttons
 * state when the menu times out.
 */
export async function handleHelpButton(
  button: ButtonInteraction,
  options: HelpButtonOptions = {},
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
  const ctx: HelpContext = {
    privileged: options.privileged ?? true,
    mode: options.mode ?? "slash",
  };
  const result = resolveHelpTarget(parsed.target, ctx);
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

function helpSettingsFor(
  interaction: ChatInputCommandInteraction,
  store: ConfigStore | undefined,
): GuildSettings | null {
  if (!store || !interaction.guildId) return null;
  try {
    return store.get(interaction.guildId);
  } catch {
    return null;
  }
}

export async function handleHelpCommand(
  interaction: ChatInputCommandInteraction,
  store?: ConfigStore,
  mode: HelpMode = "slash",
): Promise<void> {
  const topic = interaction.options.getString("topic");
  const settings = helpSettingsFor(interaction, store);
  const privileged = isHelpPrivileged(
    interaction.member,
    interaction.guild?.ownerId ?? null,
    settings,
  );
  const ctx: HelpContext = { privileged, mode };
  const result = resolveHelpTopic(topic, ctx);
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
    // Re-check privilege on every press: a member who lost their
    // whitelist (or admin) since opening the menu must not be able to
    // reach Guard/Blacklist pages through its buttons.
    const freshSettings = helpSettingsFor(interaction, store);
    const freshPrivileged = isHelpPrivileged(
      button.member,
      interaction.guild?.ownerId ?? null,
      freshSettings,
    );
    const nextPage = await handleHelpButton(button, {
      privileged: freshPrivileged,
      mode,
    });
    if (nextPage) currentPage = nextPage;
  });
  collector.on("end", async () => {
    await message
      ?.edit({ components: buildDisabledComponents(currentPage, ownerId) })
      .catch(() => undefined);
  });
}
