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
import { WildField, wildFieldEmbed, wildMessageEmbed } from "./embeds.js";
import { WILD_ERROR_REPLY } from "./reply.js";

/**
 * Help pages, Greed-style: paged embeds, one field per command, buttons
 * to move between pages. Plain text only — no emojis anywhere, including
 * on buttons ("Prev", "Next", "Back", never arrow symbols). No color
 * set on any embed, so the pages blend into the chat background.
 *
 * Personalised help: there are no "Who:" lines anywhere. Instead, every
 * listing shows only the commands THAT user can actually use right now,
 * evaluated live from the member, their roles, fgRoleOwners,
 * fgRoleSharers, the whitelist, Administrator, Manage Server, and the
 * server owner. A normal member sees FG only; an FG owner also sees
 * rename/icon/remove/share/auth; whitelisted staff see Guard, Blacklist,
 * and more. A plain member with no FG role sees the FG category
 * with a short note and no commands they can't touch. Capability is
 * re-checked on every button press.
 *
 * Sleek layout: help shows only the syntax for the form it was invoked
 * with — /help shows slash forms, ,help shows prefix forms. One field
 * per command: name is the syntax in backticks, value is a short purpose
 * (a few words). No em dashes, no extra intro paragraphs.
 *
 * Pages:
 * - Main: the visible categories as fields (FG is always shown, even
 *   when the user can use none of its commands — then it carries the
 *   "no FG role yet" note; Guard and Blacklist appear only when the
 *   user can use at least one of their commands), with buttons to jump
 *   to each one.
 * - Category: one field per visible command. FG has 15 subcommands for
 *   a fully privileged user, so it splits into 3 pages of 7, 7, and 1; for
 *   other users the pages are re-computed after filtering. Guard and
 *   Blacklist fit on one page. Buttons: [Prev] [Next] where there is
 *   another page, plus [Back].
 * - Single command: title is the command; fields are Syntax, What it
 *   does, Example. Button: [Back] to its category page. Asking for a
 *   command the user can't use gets "You can't use that command.",
 *   never the syntax.
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
const FG_PAGE_SIZE = 7;

export const CANNOT_USE_COMMAND_ERROR = "You can't use that command.";

export type HelpMode = "slash" | "prefix";

/**
 * What one user can actually do, evaluated live from their member
 * object, their roles, fgRoleOwners, fgRoleSharers, the whitelist,
 * Administrator, Manage Server, and the server owner. Every help
 * listing is filtered through these flags — there are no "Who:" lines
 * anymore, because a command you can't use never appears at all.
 */
export interface HelpCapabilities {
  /** Server owner. */
  owner: boolean;
  /** Has the Discord Administrator permission. */
  admin: boolean;
  /** Whitelisted user, or holding a whitelisted role. */
  whitelisted: boolean;
  /** Has Manage Server (owners and Administrators count). */
  manageServer: boolean;
  /** Currently owns an FG role. */
  ownsFgRole: boolean;
  /** Currently holds an FG role (owner or assigned). */
  holdsFgRole: boolean;
  /** Listed in fgRoleSharers for at least one FG role. */
  listedSharer: boolean;
  /** May share at least one FG role (owner/whitelisted/FG owner/listed). */
  canShareAny: boolean;
  /** May auth others for at least one FG role (owner/whitelisted/FG owner). */
  canAuthAny: boolean;
  /** Owner, Administrator, or whitelisted. */
  privileged: boolean;
}

/** Fill in capability defaults and derive the combined flags. */
export function deriveCaps(
  partial: Partial<HelpCapabilities> = {},
): HelpCapabilities {
  const owner = partial.owner ?? false;
  const admin = partial.admin ?? false;
  const whitelisted = partial.whitelisted ?? false;
  const ownsFgRole = partial.ownsFgRole ?? false;
  const listedSharer = partial.listedSharer ?? false;
  const privileged = owner || admin || whitelisted;
  return {
    owner,
    admin,
    whitelisted,
    manageServer: partial.manageServer ?? (owner || admin),
    ownsFgRole,
    holdsFgRole: partial.holdsFgRole ?? ownsFgRole,
    listedSharer,
    canShareAny:
      partial.canShareAny ??
      (owner || admin || whitelisted || ownsFgRole || listedSharer),
    canAuthAny:
      partial.canAuthAny ?? (owner || admin || whitelisted || ownsFgRole),
    privileged,
  };
}

/** Every capability on: the "can do everything" persona (tests, DMs). */
export const ALL_CAPS: HelpCapabilities = deriveCaps({
  owner: true,
  admin: true,
  whitelisted: true,
  manageServer: true,
  ownsFgRole: true,
  holdsFgRole: true,
  listedSharer: true,
});

export interface HelpContext {
  caps: HelpCapabilities;
  mode: HelpMode;
}

export const DEFAULT_HELP_CONTEXT: HelpContext = {
  caps: ALL_CAPS,
  mode: "slash",
};

type PermissionsLike = { has: (permission: bigint) => boolean } | null | undefined;

function permissionHas(
  permissions: PermissionsLike,
  permission: bigint,
): boolean {
  if (!permissions || typeof permissions.has !== "function") return false;
  try {
    return permissions.has(permission);
  } catch {
    return false;
  }
}

function memberHasRole(member: unknown, roleId: string): boolean {
  const cache = (member as { roles?: { cache?: unknown } } | null)?.roles?.cache as
    | { has?: unknown; some?: unknown }
    | undefined;
  if (!cache) return false;
  if (typeof cache.has === "function") {
    try {
      return (cache.has as (id: string) => boolean)(roleId);
    } catch {
      return false;
    }
  }
  if (typeof cache.some === "function") {
    try {
      return (cache.some as (predicate: (role: { id: string }) => boolean) => boolean)(
        (role) => role.id === roleId,
      );
    } catch {
      return false;
    }
  }
  return false;
}

/**
 * Compute one user's capabilities live from their member object and
 * the server's settings. When there is no member to check (DMs, test
 * doubles), treat the user as able to do everything — there is no
 * server to gate against.
 */
export function computeHelpCapabilities(
  member: unknown,
  permissions: PermissionsLike,
  guildOwnerId: string | null | undefined,
  settings: GuildSettings | null | undefined,
): HelpCapabilities {
  if (!member || typeof member !== "object") return ALL_CAPS;
  const userId =
    typeof (member as { id?: unknown }).id === "string"
      ? ((member as { id: string }).id as string)
      : null;
  if (!userId) return ALL_CAPS;
  const owner = Boolean(guildOwnerId) && userId === guildOwnerId;
  const admin =
    owner || permissionHas(permissions, PermissionFlagsBits.Administrator);
  let whitelisted = false;
  if (settings) {
    try {
      whitelisted = isWhitelisted(member as GuildMember, settings);
    } catch {
      whitelisted = false;
    }
  }
  const manageServer =
    owner || admin || permissionHas(permissions, PermissionFlagsBits.ManageGuild);
  const ownsFgRole = settings
    ? Object.values(settings.fgRoleOwners ?? {}).includes(userId)
    : false;
  const holdsFgRole = settings
    ? Object.keys(settings.fgRoleOwners ?? {}).some((roleId) =>
        memberHasRole(member, roleId),
      )
    : false;
  const listedSharer = settings
    ? Object.values(settings.fgRoleSharers ?? {}).some((userIds) =>
        userIds.includes(userId),
      )
    : false;
  return deriveCaps({
    owner,
    admin,
    whitelisted,
    manageServer,
    ownsFgRole,
    holdsFgRole,
    listedSharer,
  });
}

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
  return computeHelpCapabilities(
    member,
    (member as { permissions?: PermissionsLike } | null | undefined)
      ?.permissions ?? null,
    guildOwnerId,
    settings,
  ).privileged;
}

/** Which capability a command needs. One gate per command entry. */
export type HelpGate =
  | "privileged"
  | "manageServer"
  | "manageOrWhitelisted"
  | "ownerOrWhitelisted"
  | "fgOwner"
  | "fgOwnerOrPrivileged"
  | "holdsFgRole"
  | "canShare"
  | "canAuth";

export function canSeeEntry(
  gate: HelpGate,
  caps: HelpCapabilities,
): boolean {
  switch (gate) {
    case "privileged":
      return caps.privileged;
    case "manageServer":
      return caps.manageServer;
    case "manageOrWhitelisted":
      return caps.manageServer || caps.whitelisted;
    case "ownerOrWhitelisted":
      // Administrators count as owner here, exactly like the command
      // handlers: an admin can create and auth FG roles.
      return caps.owner || caps.admin || caps.whitelisted;
    case "fgOwner":
      return caps.ownsFgRole;
    case "fgOwnerOrPrivileged":
      // Recoloring is for FG owners (like Bleed, the owner customises
      // their own role) and for privileged members, who can create a
      // role first and then recolor it.
      return caps.ownsFgRole || caps.privileged;
    case "holdsFgRole":
      // Dropping is for anyone holding an FG role (owner or shared
      // holder). Owners see it too — the handler itself points them
      // at /fg remove instead.
      return caps.holdsFgRole;
    case "canShare":
      return caps.canShareAny;
    case "canAuth":
      return caps.canAuthAny;
  }
}

interface HelpEntry {
  /** Lookup key, e.g. "fg create". */
  key: string;
  slash: string;
  prefix: string;
  purpose: string;
  example: string;
  examplePrefix: string;
  /** Which capability gates this command. */
  gate: HelpGate;
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
    example: "/protect @Pic",
    examplePrefix: ",guard @Pic",
    gate: "privileged",
  },
  {
    key: "whitelist",
    slash: "/whitelist @user or @role",
    prefix: ",whitelist @user or @role",
    purpose: "Whitelist a member or role",
    example: "/whitelist @Alex",
    examplePrefix: ",whitelist @Alex",
    gate: "privileged",
  },
  {
    key: "status",
    slash: "/status",
    prefix: ",status",
    purpose: "View protection settings",
    example: "/status",
    examplePrefix: ",status",
    gate: "privileged",
  },
  {
    key: "setup",
    slash: "/setup #channel",
    prefix: ",logchannel #channel or ,logchannel off",
    purpose: "Set the alert channel",
    example: "/setup #mod-log",
    examplePrefix: ",logchannel #mod-log",
    gate: "privileged",
  },
];

const FG_ENTRIES: HelpEntry[] = [
  {
    key: "fg base",
    slash: "/fg base @role",
    prefix: ",fg base @role",
    purpose: "Set the FG base role",
    example: "/fg base @FG",
    examplePrefix: ",fg base @FG",
    gate: "manageServer",
  },
  {
    key: "fg color",
    slash: "/fg color <color> [second_color]",
    prefix: ",fg color <color> [second_color]",
    purpose: "Recolor your FG role (hex, random, holographic, dominant)",
    example: "/fg color #ff0000",
    examplePrefix: ",fg color #ff0000",
    gate: "fgOwnerOrPrivileged",
  },
  {
    key: "fg create",
    slash: "/fg create <name> [@member]",
    prefix: ",fg create <name> [@member]",
    purpose: "Create an FG role (color from their picture)",
    example: "/fg create My Role @Alex",
    examplePrefix: ",fg create My Role @Alex",
    gate: "ownerOrWhitelisted",
  },
  {
    key: "fg add",
    slash: "/fg add @role [@member]",
    prefix: ",fg add @role [@member]",
    purpose: "Add an existing role as an FG role",
    example: "/fg add @My Role @Alex",
    examplePrefix: ",fg add @My Role @Alex",
    gate: "ownerOrWhitelisted",
  },
  {
    key: "fg rename",
    slash: "/fg rename <name>",
    prefix: ",fg rename <name>",
    purpose: "Rename your FG role",
    example: "/fg rename New Name",
    examplePrefix: ",fg rename New Name",
    gate: "fgOwner",
  },
  {
    key: "fg icon",
    slash: "/fg icon <url>",
    prefix: ",fg icon <url>",
    purpose: "Set your FG role icon",
    example: "/fg icon https://example.com/icon.png",
    examplePrefix: ",fg icon https://example.com/icon.png",
    gate: "fgOwner",
  },
  {
    key: "fg remove",
    slash: "/fg remove",
    prefix: ",fg remove",
    purpose: "Delete your FG role",
    example: "/fg remove",
    examplePrefix: ",fg remove",
    gate: "fgOwner",
  },
  {
    key: "fg drop",
    slash: "/fg drop",
    prefix: ",fg drop",
    purpose: "Give back an FG role someone shared with you",
    example: "/fg drop",
    examplePrefix: ",fg drop",
    gate: "holdsFgRole",
  },
  {
    key: "fg holders",
    slash: "/fg holders",
    prefix: ",fg holders",
    purpose: "List who holds your FG role",
    example: "/fg holders",
    examplePrefix: ",fg holders",
    gate: "canShare",
  },
  {
    key: "fg list",
    slash: "/fg list",
    prefix: ",fg list",
    purpose: "List FG roles and owners",
    example: "/fg list",
    examplePrefix: ",fg list",
    gate: "manageOrWhitelisted",
  },
  {
    key: "fg cleanup",
    slash: "/fg cleanup",
    prefix: ",fg cleanup",
    purpose: "Remove FG roles of leavers",
    example: "/fg cleanup",
    examplePrefix: ",fg cleanup",
    gate: "manageServer",
  },
  {
    key: "fg share",
    slash: "/fg share @member",
    prefix: ",fg share @member",
    purpose: "Offer your FG role",
    example: "/fg share @Alex",
    examplePrefix: ",fg share @Alex",
    gate: "canShare",
  },
  {
    key: "fg auth add",
    slash: "/fg auth add @member",
    prefix: ",fg auth add @member",
    purpose: "Let a member share an FG role",
    example: "/fg auth add @Alex",
    examplePrefix: ",fg auth add @Alex",
    gate: "canAuth",
  },
  {
    key: "fg auth remove",
    slash: "/fg auth remove @member",
    prefix: ",fg auth remove @member",
    purpose: "Stop a member sharing an FG role",
    example: "/fg auth remove @Alex",
    examplePrefix: ",fg auth remove @Alex",
    gate: "canAuth",
  },
  {
    key: "fg auth list",
    slash: "/fg auth list [@role]",
    prefix: ",fg auth list [@role]",
    purpose: "List who can share an FG role",
    example: "/fg auth list",
    examplePrefix: ",fg auth list",
    gate: "canAuth",
  },
];

const BLACKLIST_ENTRIES: HelpEntry[] = [
  {
    key: "blacklist add",
    slash: "/blacklist add @user @role",
    prefix: ",blacklist add @user @role",
    purpose: "Block a member from a role",
    example: "/blacklist add @Alex @Pic",
    examplePrefix: ",blacklist add @Alex @Pic",
    gate: "privileged",
  },
  {
    key: "blacklist remove",
    slash: "/blacklist remove @user @role",
    prefix: ",blacklist remove @user @role",
    purpose: "Unblock a member",
    example: "/blacklist remove @Alex @Pic",
    examplePrefix: ",blacklist remove @Alex @Pic",
    gate: "privileged",
  },
  {
    key: "blacklist list",
    slash: "/blacklist list",
    prefix: ",blacklist list",
    purpose: "List blacklisted members",
    example: "/blacklist list",
    examplePrefix: ",blacklist list",
    gate: "privileged",
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
  add: "fg add",
  rename: "fg rename",
  icon: "fg icon",
  remove: "fg remove",
  drop: "fg drop",
  holders: "fg holders",
  list: "fg list",
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

/** The note a plain member with no FG role sees instead of commands. */
export const NO_FG_ROLE_NOTE =
  "You don't have an FG role yet — ask an admin or whitelisted member to create one for you.";

function visibleEntries(category: HelpCategory, ctx: HelpContext): HelpEntry[] {
  return category.entries.filter((entry) => canSeeEntry(entry.gate, ctx.caps));
}

function visibleCategories(ctx: HelpContext): HelpCategory[] {
  // FG is always shown (with the no-FG-role note when the user can use
  // none of its commands). Guard and Blacklist appear only when the
  // user can use at least one of their commands.
  return HELP_CATEGORIES.filter(
    (category) =>
      category.key === "fg" || visibleEntries(category, ctx).length > 0,
  );
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
    value: entry.purpose,
  };
}

function mainHelpPage(ctx: HelpContext): HelpPage {
  const categories = visibleCategories(ctx);
  const helpWord = ctx.mode === "prefix" ? ",help" : "/help";
  return {
    title: "Help",
    description: `Pick a category, or ${helpWord} <command>.`,
    fields: categories.map((category) => {
      const count = visibleEntries(category, ctx).length;
      if (category.key === "fg" && count === 0) {
        return { name: category.title, value: NO_FG_ROLE_NOTE };
      }
      return {
        name: category.title,
        value: `${category.summary}\n${count} command${count === 1 ? "" : "s"}`,
      };
    }),
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
      ? `Help - ${category.title} (${safePage}/${totalPages})`
      : `Help - ${category.title}`;
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
    description:
      entries.length === 0 && category.key === "fg"
        ? NO_FG_ROLE_NOTE
        : category.summary,
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
      { name: "Example", value: `\`${entryExample(entry, ctx.mode)}\`` },
    ],
    buttons: [{ id: `category:${category.key}:${page}`, label: "Back" }],
    kind: "command",
    category: category.key,
    page,
    entryKey: entry.key,
  };
}

/** Encode an entry key ("fg auth add") for a button customId. */
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
      if (
        category.key !== "fg" &&
        visibleEntries(category, ctx).length === 0
      ) {
        return { kind: "error", message: CANNOT_USE_COMMAND_ERROR };
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
      if (!canSeeEntry(entry.gate, ctx.caps)) {
        return { kind: "error", message: CANNOT_USE_COMMAND_ERROR };
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
      if (
        category.key !== "fg" &&
        visibleEntries(category, ctx).length === 0
      ) {
        return { kind: "error", message: CANNOT_USE_COMMAND_ERROR };
      }
      return {
        kind: "embed",
        page: categoryHelpPage(category, Number(categoryMatch[2] ?? "1"), ctx),
      };
    }
  }
  const direct = ALL_ENTRIES.find((entry) => entry.key === cleaned);
  if (direct) {
    if (!canSeeEntry(direct.gate, ctx.caps)) {
      return { kind: "error", message: CANNOT_USE_COMMAND_ERROR };
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
    if (!canSeeEntry(aliased.gate, ctx.caps)) {
      return { kind: "error", message: CANNOT_USE_COMMAND_ERROR };
    }
    return { kind: "embed", page: entryHelpPage(aliased, ctx) };
  }
  const fgSingle = FG_SINGLE_WORDS[cleaned];
  if (fgSingle) {
    const entry = ALL_ENTRIES.find((item) => item.key === fgSingle)!;
    if (!canSeeEntry(entry.gate, ctx.caps)) {
      return { kind: "error", message: CANNOT_USE_COMMAND_ERROR };
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
  caps?: HelpCapabilities;
  mode?: HelpMode;
}

/**
 * Handle a help navigation button press. Returns the page navigated to,
 * or null when the press was rejected (wrong user, or a page the user can
 * no longer use) or the target is gone. The caller (the help collector)
 * uses the returned page to refresh the disabled-buttons state when the
 * menu times out.
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
        embeds: [wildMessageEmbed("This help menu isn't yours - run /help to get your own.")],
        ephemeral: true,
      })
      .catch(() => undefined);
    return null;
  }
  const ctx: HelpContext = {
    caps: options.caps ?? ALL_CAPS,
    mode: options.mode ?? "slash",
  };
  const result = resolveHelpTarget(parsed.target, ctx);
  if (result.kind === "error") {
    await button
      .reply({ embeds: [wildMessageEmbed(result.message)], ephemeral: true })
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
  const caps = computeHelpCapabilities(
    interaction.member,
    interaction.memberPermissions ?? null,
    interaction.guild?.ownerId ?? null,
    settings,
  );
  const ctx: HelpContext = { caps, mode };
  const result = resolveHelpTopic(topic, ctx);
  if (result.kind === "error") {
    await interaction.reply({
      embeds: [wildMessageEmbed(result.message)],
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
    // Re-check capability on every press: a member who lost their FG
    // role or whitelist since opening the menu must not be able to
    // reach pages through its buttons.
    const freshSettings = helpSettingsFor(interaction, store);
    const freshCaps = computeHelpCapabilities(
      button.member,
      button.memberPermissions ?? null,
      interaction.guild?.ownerId ?? null,
      freshSettings,
    );
    const nextPage = await handleHelpButton(button, {
      caps: freshCaps,
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
