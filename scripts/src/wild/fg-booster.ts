import { randomInt } from "node:crypto";
import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonInteraction,
  ButtonStyle,
  ChatInputCommandInteraction,
  ComponentType,
  Constants,
  EmbedBuilder,
  Guild,
  GuildMember,
  PermissionFlagsBits,
  Role,
  SlashCommandBuilder,
} from "discord.js";
import { ConfigStore, GuildSettings } from "./config-store.js";
import {
  DEFAULT_AVATAR_COLOR,
  getMemberAvatarDominantColor,
} from "./avatar-color.js";
import { wildFieldEmbed, wildMessageEmbed } from "./embeds.js";
import {
  canAuthFgRole,
  fetchMemberFresh,
  isBotAdmin,
  isBotAdminPermissions,
  isFgSharer,
  isWhitelisted,
} from "./authorization.js";
import { memberDisplayName, roleDisplayName, roleMention } from "./names.js";
import { WILD_ERROR_REPLY } from "./reply.js";

/**
 * FG roles, Bleed booster-role style.
 *
 * Bleed's booster roles are unique, personal, cosmetic roles that a member
 * customises themselves (name, color, icon) and that sit under one base
 * role. Wild copies that model, with Wild adaptations (labelled as such
 * in the docs, NOT Bleed behaviour):
 *  - Eligibility is being whitelisted, not boosting the server.
 *  - One FG role per member (Wild rule).
 *  - /fg share is Wild-only. Bleed documents no share command.
 *
 * Sharing, Wild-only assign + auth model (the award role system was
 * removed — it confused people): the server owner, Administrators, or
 * whitelisted staff assign an FG role to a member with /fg assign,
 * which also makes that member authorised to share it. The FG role's
 * owner can authorise other people to share their role with /fg auth
 * add — auth is permission to share only, they do not get the role
 * itself. Only the server owner, Administrators, whitelisted staff,
 * the FG role owner, and people assigned or authed for that role may
 * share it.
 *
 * All slash replies are ephemeral embeds (short text in the description
 * of a colorless embed), except /fg list and the public share offer
 * (colorless field embeds, no footer/timestamp). Errors are never public.
 */

const SHARE_TIMEOUT_MS = 5 * 60 * 1_000;
const MAX_FG_NAME_LENGTH = 90;

/**
 * Parse a color: a hex code only — #rrggbb, rrggbb, #rgb, rgb, or
 * 0xrrggbb (strictly 3 or 6 hex digits). Color names do not exist here:
 * "blue", "red", "crimson" and every other name is invalid. Returns a
 * lowercase "#rrggbb" string, or null when the input is not a hex color.
 */
export function parseFgColor(input: string): string | null {
  let hex = input.trim().toLowerCase();
  if (hex.startsWith("0x")) hex = hex.slice(2);
  else if (hex.startsWith("#")) hex = hex.slice(1);
  if (/^[0-9a-f]{6}$/.test(hex)) return `#${hex}`;
  if (/^[0-9a-f]{3}$/.test(hex)) {
    return `#${hex[0]}${hex[0]}${hex[1]}${hex[1]}${hex[2]}${hex[2]}`;
  }
  return null;
}

/** Split color input on whitespace and commas; empty pieces dropped. */
export function splitColorTokens(input: string): string[] {
  return input
    .split(/[\s,]+/)
    .map((token) => token.trim())
    .filter((token) => token.length > 0);
}

/** A random hex color, "#rrggbb". */
export function randomFgColor(): string {
  return `#${randomInt(0, 0x1000000).toString(16).padStart(6, "0")}`;
}

/**
 * Discord's fixed holographic preset, straight from discord.js
 * (Constants.HolographicStyle: Primary 11127295, Secondary 16759788,
 * Tertiary 16761760). The API enforces these exact values whenever a
 * tertiary color is sent, so a holographic role is always these three
 * colors — it can't be recolored.
 */
export const HOLOGRAPHIC_COLORS = {
  primary: `#${Constants.HolographicStyle.Primary.toString(16).padStart(6, "0")}`,
  secondary: `#${Constants.HolographicStyle.Secondary.toString(16).padStart(6, "0")}`,
  tertiary: `#${Constants.HolographicStyle.Tertiary.toString(16).padStart(6, "0")}`,
} as const;

export type FgColorKind = "solid" | "gradient" | "holographic" | "dominant";

export interface FgColorChoice {
  kind: FgColorKind;
  /**
   * Lowercase "#rrggbb". For holographic, the preset primary. For
   * dominant, "" until the handler resolves it from the avatar.
   */
  primary: string;
  /** Lowercase "#rrggbb", or null for solid. Holographic stores its preset secondary here. */
  secondary: string | null;
}

interface MatchedColor {
  /** Lowercase "#rrggbb", or null for holographic / dominant. */
  hex: string | null;
  holographic: boolean;
  dominant: boolean;
  /** How many tokens this color used. */
  length: number;
}

/**
 * Try to match one color at tokens[start]: `holographic`/`holo`,
 * `random`, `dominant` (the caller's avatar color, resolved later),
 * or a single hex code. Null when the token there isn't a color.
 * Hex codes are one token; color names do not exist.
 */
function matchOneColor(tokens: string[], start: number): MatchedColor | null {
  const token = tokens[start]?.toLowerCase();
  if (!token) return null;
  if (token === "holographic" || token === "holo") {
    return { hex: null, holographic: true, dominant: false, length: 1 };
  }
  if (token === "random") {
    return { hex: randomFgColor(), holographic: false, dominant: false, length: 1 };
  }
  if (token === "dominant") {
    return { hex: null, holographic: false, dominant: true, length: 1 };
  }
  const parsed = parseFgColor(token);
  if (parsed) {
    return { hex: parsed, holographic: false, dominant: false, length: 1 };
  }
  return null;
}

export type FgColorParseError = "invalid" | "too-many";

export type FgColorParseResult =
  | { choice: FgColorChoice; consumed: number; colorText: string }
  | { error: FgColorParseError };

/**
 * Parse Greed/Bleed-style colors from the front of a token list: one
 * color = solid, two = gradient, `holographic`/`holo` on its own,
 * `random` = a random hex, `dominant` = the caller's avatar color
 * (resolved by the handler, not here). Colors are hex codes only —
 * `#rrggbb`, `rrggbb`, `#rgb`, `rgb`, `0xrrggbb` — separated by spaces
 * or commas. Returns how many tokens the colors used, so the caller
 * knows where the rest starts. More than two colors is an error
 * ("too-many"), never silently ignored.
 */
export function parseFgColorTokens(tokens: string[]): FgColorParseResult {
  const first = matchOneColor(tokens, 0);
  if (!first) return { error: "invalid" };
  if (first.holographic) {
    return {
      choice: {
        kind: "holographic",
        primary: HOLOGRAPHIC_COLORS.primary,
        secondary: HOLOGRAPHIC_COLORS.secondary,
      },
      consumed: 1,
      colorText: tokens.slice(0, 1).join(" "),
    };
  }
  if (first.dominant) {
    if (matchOneColor(tokens, 1)) return { error: "too-many" };
    return {
      choice: { kind: "dominant", primary: "", secondary: null },
      consumed: 1,
      colorText: tokens.slice(0, 1).join(" "),
    };
  }
  const colors: string[] = [first.hex!];
  let pos = first.length;
  const second = matchOneColor(tokens, pos);
  if (second) {
    if (second.holographic || second.dominant) return { error: "too-many" };
    colors.push(second.hex!);
    pos += second.length;
    if (matchOneColor(tokens, pos)) return { error: "too-many" };
  }
  const choice: FgColorChoice =
    colors.length === 1
      ? { kind: "solid", primary: colors[0], secondary: null }
      : { kind: "gradient", primary: colors[0], secondary: colors[1] };
  return { choice, consumed: pos, colorText: tokens.slice(0, pos).join(" ") };
}

/**
 * Parse a whole color spec string ("#ff0000 #0000ff", "#ff0000,#0000ff",
 * "random", "holographic", "dominant"). Returns null unless the ENTIRE
 * string is one or two hex colors (or holographic / dominant on its own).
 */
export function parseFgColorSpec(input: string): FgColorChoice | null {
  const tokens = splitColorTokens(input);
  if (tokens.length === 0) return null;
  const parsed = parseFgColorTokens(tokens);
  if ("error" in parsed) return null;
  if (parsed.consumed !== tokens.length) return null;
  return parsed.choice;
}

function isValidFgName(name: string): boolean {
  const trimmed = name.trim();
  return (
    trimmed.length >= 1 &&
    trimmed.length <= MAX_FG_NAME_LENGTH &&
    !trimmed.includes("@everyone") &&
    !trimmed.includes("@here")
  );
}

export const fgCommand = new SlashCommandBuilder()
  .setName("fg")
  .setDescription("Your own FG role — color, name, icon, and sharing")
  .addSubcommand((command) =>
    command
      .setName("base")
      .setDescription("Set the base role FG roles sit under")
      .addRoleOption((option) =>
        option.setName("role").setDescription("Base role").setRequired(true),
      ),
  )
  .addSubcommand((command) =>
    command
      .setName("color")
      .setDescription("Recolor your own FG role")
      .addStringOption((option) =>
        option.setName("color").setDescription("Hex color, random, holographic, or dominant").setRequired(true),
      )
      .addStringOption((option) =>
        option.setName("second_color").setDescription("Second hex color for a gradient"),
      ),
  )
  .addSubcommand((command) =>
    command
      .setName("create")
      .setDescription("Create an FG role for yourself or a member")
      .addStringOption((option) =>
        option
          .setName("name")
          .setDescription("Name for the FG role")
          .setMinLength(1)
          .setMaxLength(MAX_FG_NAME_LENGTH)
          .setRequired(true),
      )
      .addUserOption((option) =>
        option.setName("member").setDescription("Member the FG role is for (default: you)"),
      ),
  )
  .addSubcommand((command) =>
    command
      .setName("rename")
      .setDescription("Rename your own FG role")
      .addStringOption((option) =>
        option
          .setName("name")
          .setDescription("New name for your FG role")
          .setMinLength(1)
          .setMaxLength(MAX_FG_NAME_LENGTH)
          .setRequired(true),
      ),
  )
  .addSubcommand((command) =>
    command
      .setName("icon")
      .setDescription("Set your FG role's icon")
      .addStringOption((option) =>
        option
          .setName("url")
          .setDescription("Image link, emoji, or custom emoji")
          .setRequired(true),
      ),
  )
  .addSubcommand((command) =>
    command.setName("remove").setDescription("Delete your own FG role"),
  )
  .addSubcommand((command) =>
    command.setName("list").setDescription("List all FG roles"),
  )
  .addSubcommand((command) =>
    command
      .setName("cleanup")
      .setDescription("Remove FG roles whose owners left the server"),
  )
  .addSubcommand((command) =>
    command
      .setName("share")
      .setDescription("Offer one of your FG roles to a member")
      .addUserOption((option) =>
        option.setName("member").setDescription("Member to offer the role to").setRequired(true),
      )
      .addRoleOption((option) =>
        option.setName("role").setDescription("FG role to share").setRequired(true),
      ),
  )
  .addSubcommand((command) =>
    command
      .setName("assign")
      .setDescription("Give an FG role to a member and let them share it")
      .addUserOption((option) =>
        option.setName("member").setDescription("Member to assign the role to").setRequired(true),
      )
      .addRoleOption((option) =>
        option.setName("role").setDescription("FG role to assign").setRequired(true),
      ),
  )
  .addSubcommandGroup((group) =>
    group
      .setName("auth")
      .setDescription("Who may share an FG role")
      .addSubcommand((command) =>
        command
          .setName("add")
          .setDescription("Let a member share an FG role (they don't get the role)")
          .addUserOption((option) =>
            option.setName("member").setDescription("Member to authorise").setRequired(true),
          )
          .addRoleOption((option) =>
            option.setName("role").setDescription("FG role to share").setRequired(true),
          ),
      )
      .addSubcommand((command) =>
        command
          .setName("remove")
          .setDescription("Stop a member sharing an FG role")
          .addUserOption((option) =>
            option.setName("member").setDescription("Member to remove").setRequired(true),
          )
          .addRoleOption((option) =>
            option.setName("role").setDescription("FG role").setRequired(true),
          ),
      )
      .addSubcommand((command) =>
        command
          .setName("list")
          .setDescription("List who may share an FG role")
          .addRoleOption((option) =>
            option.setName("role").setDescription("FG role").setRequired(true),
          ),
      ),
  );

async function replyText(
  interaction: ChatInputCommandInteraction,
  content: string,
  isError = true,
): Promise<void> {
  // Small replies are embeds, not plain text: the short message goes in
  // the description of a colorless embed with no title (see embeds.ts).
  // Most replies from the FG commands are errors, so the default is
  // error. Success replies pass false explicitly (see saveSettings and
  // the color/rename/icon confirmations). The flag is a symbol-keyed
  // property: discord.js builds the reply payload from named fields
  // only, so it never reaches Discord. The prefix adapter reads it to
  // auto-delete visible error replies.
  await interaction.reply({
    embeds: [wildMessageEmbed(content)],
    ephemeral: true,
    [WILD_ERROR_REPLY]: isError,
  } as Parameters<ChatInputCommandInteraction["reply"]>[0]);
}

function hasManageServer(interaction: ChatInputCommandInteraction): boolean {
  return Boolean(
    interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild),
  );
}

async function requireManageServer(
  interaction: ChatInputCommandInteraction,
): Promise<boolean> {
  // Administrators and the server owner count too — do not rely on the
  // Manage Server bit being inherited.
  if (
    isBotAdminPermissions(
      interaction.memberPermissions,
      interaction.user.id,
      interaction.guild?.ownerId ?? null,
    ) ||
    hasManageServer(interaction)
  ) {
    return true;
  }
  await replyText(interaction, "You need Manage Server for that.");
  return false;
}

async function saveSettings(
  interaction: ChatInputCommandInteraction,
  store: ConfigStore,
  settings: GuildSettings,
  successMessage: string,
): Promise<void> {
  try {
    await store.set(interaction.guildId!, settings);
    await replyText(interaction, successMessage, false);
  } catch {
    await replyText(
      interaction,
      "Couldn't save that. Check the bot's settings storage and try again.",
    );
  }
}

/** The caller's own FG role, if they have one that still exists. */
function findOwnFgRole(
  guild: Guild,
  settings: GuildSettings,
  userId: string,
): { roleId: string; role: Role } | null {
  for (const [roleId, ownerId] of Object.entries(settings.fgRoleOwners)) {
    if (ownerId !== userId) continue;
    const role = guild.roles.cache.get(roleId);
    if (role) return { roleId, role };
  }
  return null;
}

function findAnyFgRole(
  guild: Guild,
  settings: GuildSettings,
  userId: string,
): string | null {
  return findOwnFgRole(guild, settings, userId)?.roleId ?? null;
}

async function handleBaseCommand(
  interaction: ChatInputCommandInteraction,
  store: ConfigStore,
): Promise<void> {
  if (!(await requireManageServer(interaction))) return;
  const guild = interaction.guild!;
  const settings = store.get(guild.id);
  const selectedRole = interaction.options.getRole("role", true);
  const role = guild.roles.cache.get(selectedRole.id);
  if (!role) {
    await replyText(interaction, "That role is no longer available in this server.");
    return;
  }
  if (role.id === guild.id || role.managed) {
    await replyText(interaction, "That role can't be the FG base role.");
    return;
  }

  const botMember =
    guild.members.me ?? (await guild.members.fetchMe().catch(() => null));
  const warning =
    botMember && botMember.roles.highest.comparePositionTo(role) <= 0
      ? " Warning: move the bot's role above the base role, or FG roles may not sit under it."
      : "";
  await saveSettings(
    interaction,
    store,
    { ...settings, fgBaseRoleId: role.id },
    `${roleDisplayName(role)} is now the FG base role. FG roles sit just under it.${warning}`,
  );
}

/**
 * Shared FG-role creation, used only by /fg create (for yourself or a
 * named member). The caller must already have passed the
 * owner-or-whitelisted gate. A base role must be set. The role's color
 * is the dominant color of the assignee's profile picture (Bleed-style);
 * when the avatar can't be read, the role is made in the default color
 * instead and the reply says so — creation never fails over the color.
 */
async function createFgRole(
  interaction: ChatInputCommandInteraction,
  store: ConfigStore,
  targetId: string,
  nameInput: string,
): Promise<void> {
  const guild = interaction.guild!;
  const settings = store.get(guild.id);
  const forSelf = targetId === interaction.user.id;
  const target = await guild.members.fetch(targetId).catch(() => null);
  if (!target) {
    await replyText(interaction, "That person must be a member of this server first.");
    return;
  }
  if (findAnyFgRole(guild, settings, targetId)) {
    await replyText(
      interaction,
      forSelf
        ? "You already have an FG role — use /fg rename or /fg remove first."
        : "They already have an FG role — use /fg remove first.",
    );
    return;
  }

  const name = nameInput.trim();
  if (!isValidFgName(name)) {
    await replyText(interaction, "Pick a name between 1 and 90 characters.");
    return;
  }

  const botMember =
    guild.members.me ?? (await guild.members.fetchMe().catch(() => null));
  if (!botMember?.permissions.has(PermissionFlagsBits.ManageRoles)) {
    await replyText(interaction, "The bot needs Manage Roles to create FG roles.");
    return;
  }

  if (!settings.fgBaseRoleId) {
    await replyText(interaction, "Set an FG base role first with /fg base @role.");
    return;
  }
  const baseRole = settings.fgBaseRoleId
    ? guild.roles.cache.get(settings.fgBaseRoleId)
    : undefined;
  if (
    baseRole &&
    botMember.roles.highest.comparePositionTo(baseRole) <= 0
  ) {
    await replyText(
      interaction,
      "Move the bot's role above the FG base role first.",
    );
    return;
  }

  // The role takes the color of the assignee's profile picture. When
  // the avatar can't be read, use the default color and say so.
  const avatarColor = await getMemberAvatarDominantColor(target);
  const primary = avatarColor ?? DEFAULT_AVATAR_COLOR;
  const colorNote = avatarColor
    ? " Its color matches their profile picture."
    : ` The bot couldn't read their profile picture, so it used ${DEFAULT_AVATAR_COLOR} instead.`;

  const createOptions = {
    name,
    colors: { primaryColor: primary as `#${string}` },
    permissions: [],
    hoist: false,
    mentionable: false,
    position: baseRole ? Math.max(0, baseRole.position - 1) : undefined,
    reason: `FG role created by ${interaction.user.id} for ${targetId}`,
  };
  let role: Role;
  try {
    role = await guild.roles.create(createOptions);
  } catch {
    await replyText(
      interaction,
      "The bot couldn't create that FG role. Check its permissions and role order and try again.",
    );
    return;
  }

  const nextSettings = store.get(guild.id);
  nextSettings.fgRoles[role.id] = {
    assignUserIds: [],
    assignRoleIds: [],
    shareUserIds: [],
    shareRoleIds: [],
  };
  nextSettings.fgRoleOwners[role.id] = targetId;
  if (!nextSettings.protectedRoleIds.includes(role.id)) {
    nextSettings.protectedRoleIds.push(role.id);
  }
  try {
    await store.set(guild.id, nextSettings);
  } catch {
    await role.delete("FG role configuration could not be saved").catch(() => undefined);
    await replyText(
      interaction,
      "The bot couldn't save that FG role. Try again.",
    );
    return;
  }

  await replyText(
    interaction,
    forSelf
      ? `${roleDisplayName(role)} is your FG role now.${colorNote} It's protected, so only whitelisted people can give it to anyone else.`
      : `Created FG role ${roleDisplayName(role)} for ${memberDisplayName(target)}.${colorNote} It's protected, so only whitelisted people can give it to anyone else.`,
    false,
  );
}

/**
 * Resolve a recolor spec from /fg color's options: one hex = solid,
 * two = gradient, `holographic`/`holo` on its own, `random` = a random
 * hex, `dominant` = the caller's avatar color (resolved by the caller).
 * Returns an error message when the spec is invalid.
 */
function resolveRecolorChoice(
  colorInput: string,
  secondColorInput: string | null,
): { choice: FgColorChoice } | { error: string } {
  const spec = parseFgColorSpec(colorInput);
  if (!spec) {
    return {
      error:
        "That isn't a hex color. Use a hex color like #ff0000, random, holographic, or dominant.",
    };
  }
  if (spec.kind === "dominant") {
    if (secondColorInput) {
      return { error: "Dominant can't be used with a second color." };
    }
    return { choice: spec };
  }
  if (secondColorInput) {
    if (spec.kind !== "solid") {
      return { error: "Too many colors — give one color, or two for a gradient." };
    }
    const second = parseFgColorSpec(secondColorInput);
    if (!second || second.kind !== "solid") {
      return {
        error:
          second?.kind === "holographic"
            ? "Holographic can't be a second color — use it on its own."
            : second?.kind === "dominant"
              ? "Dominant can't be a second color — use it on its own."
              : "That second color isn't a hex color.",
      };
    }
    return {
      choice: { kind: "gradient", primary: spec.primary, secondary: second.primary },
    };
  }
  return { choice: spec };
}

type RoleColorSet = {
  primaryColor: `#${string}`;
  secondaryColor?: `#${string}`;
  tertiaryColor?: `#${string}`;
};

/** The Discord color set for a choice (gradient / holographic / solid). */
function roleColorsForChoice(choice: FgColorChoice): RoleColorSet {
  return choice.kind === "holographic"
    ? {
        primaryColor: HOLOGRAPHIC_COLORS.primary,
        secondaryColor: HOLOGRAPHIC_COLORS.secondary,
        tertiaryColor: HOLOGRAPHIC_COLORS.tertiary,
      }
    : choice.kind === "gradient"
      ? {
          primaryColor: choice.primary as `#${string}`,
          secondaryColor: choice.secondary! as `#${string}`,
        }
      : { primaryColor: choice.primary as `#${string}` };
}

/** Short description of a choice for the reply, e.g. "now #ff0000". */
function describeRecolor(choice: FgColorChoice): string {
  if (choice.kind === "holographic") return "now holographic";
  if (choice.kind === "gradient") {
    return `now a gradient from ${choice.primary} to ${choice.secondary}`;
  }
  return `now ${choice.primary}`;
}

/** Owner-or-whitelisted gate for FG creation. Returns the caller or null. */
async function requireFgCreator(
  interaction: ChatInputCommandInteraction,
  store: ConfigStore,
): Promise<GuildMember | null> {
  const guild = interaction.guild!;
  const settings = store.get(guild.id);
  const member = await fetchMemberFresh(guild, interaction.user.id);
  if (!member) {
    await replyText(interaction, "You need to be a member of this server first.");
    return null;
  }
  // Wild rule: eligibility is being whitelisted (or the server owner
  // or an Administrator), not boosting. Bleed gates this on boosting
  // instead.
  if (!isBotAdmin(member, guild.ownerId) && !isWhitelisted(member, settings)) {
    await replyText(
      interaction,
      "Only the server owner, administrators, or whitelisted members can create FG roles.",
    );
    return null;
  }
  return member;
}

/**
 * /fg color — recolor your own FG role. It never creates a role: if
 * you don't have one yet, it tells you to make one with /fg create.
 * Any FG owner may recolor their own role (whitelisted or not — like
 * Bleed, the owner customises their own role).
 */
async function handleColorCommand(
  interaction: ChatInputCommandInteraction,
  store: ConfigStore,
): Promise<void> {
  const guild = interaction.guild!;
  const settings = store.get(guild.id);
  const own = findOwnFgRole(guild, settings, interaction.user.id);
  if (!own) {
    await replyText(
      interaction,
      "You don't have an FG role yet — make one with /fg create first.",
    );
    return;
  }
  const resolved = resolveRecolorChoice(
    interaction.options.getString("color", true),
    interaction.options.getString("second_color"),
  );
  if ("error" in resolved) {
    await replyText(interaction, resolved.error);
    return;
  }
  let choice = resolved.choice;
  let avatarNote = "";
  if (choice.kind === "dominant") {
    // The role takes the color of your profile picture.
    const member = await guild.members
      .fetch(interaction.user.id)
      .catch(() => null);
    const avatarColor = member
      ? await getMemberAvatarDominantColor(member)
      : null;
    choice = {
      kind: "solid",
      primary: avatarColor ?? DEFAULT_AVATAR_COLOR,
      secondary: null,
    };
    avatarNote = avatarColor
      ? " It matches your profile picture."
      : ` The bot couldn't read your profile picture, so it used ${DEFAULT_AVATAR_COLOR} instead.`;
  }

  // Gradients and holographic are Discord's Enhanced Role Styles. If
  // the server hasn't unlocked the perk (3 server boosts on it),
  // Discord rejects the style — like Greed, fall back to a solid role
  // in the first color and say why, instead of failing.
  let styleNote = "";
  try {
    await own.role.setColors(
      roleColorsForChoice(choice),
      `FG role recolored by ${interaction.user.id}`,
    );
  } catch {
    if (choice.kind === "solid") {
      await replyText(
        interaction,
        "The bot couldn't recolor that role. Check its permissions and try again.",
      );
      return;
    }
    try {
      await own.role.setColors(
        { primaryColor: choice.primary as `#${string}` },
        `FG role recolored by ${interaction.user.id}`,
      );
    } catch {
      await replyText(
        interaction,
        "The bot couldn't recolor that role. Check its permissions and try again.",
      );
      return;
    }
    styleNote =
      choice.kind === "holographic"
        ? ` Holographic needs the Enhanced Role Styles perk (3 server boosts on it), so your role is solid ${choice.primary} for now.`
        : ` Gradients need the Enhanced Role Styles perk (3 server boosts on it), so your role is solid ${choice.primary} for now.`;
  }
  await replyText(
    interaction,
    `Your FG role is ${describeRecolor(choice)}.${avatarNote}${styleNote}`,
    false,
  );
}

async function handleCreateCommand(
  interaction: ChatInputCommandInteraction,
  store: ConfigStore,
): Promise<void> {
  if (!(await requireFgCreator(interaction, store))) return;
  const target = interaction.options.getUser("member");
  await createFgRole(
    interaction,
    store,
    target?.id ?? interaction.user.id,
    interaction.options.getString("name", true),
  );
}

async function handleRenameCommand(
  interaction: ChatInputCommandInteraction,
  store: ConfigStore,
): Promise<void> {
  const guild = interaction.guild!;
  const settings = store.get(guild.id);
  const own = findOwnFgRole(guild, settings, interaction.user.id);
  if (!own) {
    await replyText(
      interaction,
      "You don't have an FG role yet — make one with /fg create first.",
    );
    return;
  }
  const name = interaction.options.getString("name", true).trim();
  if (!isValidFgName(name)) {
    await replyText(interaction, "Pick a name between 1 and 90 characters.");
    return;
  }
  try {
    await own.role.setName(name, `FG role renamed by ${interaction.user.id}`);
  } catch {
    await replyText(
      interaction,
      "The bot couldn't rename that role. Check its permissions and try again.",
    );
    return;
  }
  await replyText(interaction, `Your FG role is now called ${roleDisplayName(own.role)}.`, false);
}

async function handleIconCommand(
  interaction: ChatInputCommandInteraction,
  store: ConfigStore,
): Promise<void> {
  const guild = interaction.guild!;
  const settings = store.get(guild.id);
  const own = findOwnFgRole(guild, settings, interaction.user.id);
  if (!own) {
    await replyText(
      interaction,
      "You don't have an FG role yet — make one with /fg create first.",
    );
    return;
  }
  const input = interaction.options.getString("url", true).trim();
  const customEmoji = input.match(/^<a?:\w+:(\d+)>$/);
  try {
    if (customEmoji) {
      const extension = input.startsWith("<a:") ? "gif" : "png";
      await own.role.setIcon(
        `https://cdn.discordapp.com/emojis/${customEmoji[1]}.${extension}`,
        `FG role icon set by ${interaction.user.id}`,
      );
    } else if (/^https?:\/\//.test(input)) {
      await own.role.setIcon(input, `FG role icon set by ${interaction.user.id}`);
    } else {
      // A Unicode emoji: Discord stores it as the role's emoji, not an image.
      await own.role.setUnicodeEmoji(
        input,
        `FG role icon set by ${interaction.user.id}`,
      );
    }
  } catch {
    await replyText(
      interaction,
      "That icon didn't work. Use an image link, an emoji, or a custom emoji.",
    );
    return;
  }
  // Role icons only show on Boost Level 2+ servers.
  const tierNote =
    (guild.premiumTier ?? 0) < 2
      ? " Note: role icons only show on Boost Level 2+ servers, so yours may not show yet."
      : "";
  await replyText(interaction, `Your FG role icon is set.${tierNote}`, false);
}

async function handleRemoveCommand(
  interaction: ChatInputCommandInteraction,
  store: ConfigStore,
): Promise<void> {
  const guild = interaction.guild!;
  const settings = store.get(guild.id);
  const own = findOwnFgRole(guild, settings, interaction.user.id);
  const ownedRoleId = Object.entries(settings.fgRoleOwners).find(
    ([, ownerId]) => ownerId === interaction.user.id,
  )?.[0];
  if (!own && !ownedRoleId) {
    await replyText(interaction, "You don't have an FG role to remove.");
    return;
  }
  const roleId = own?.roleId ?? ownedRoleId!;
  const role = own?.role ?? guild.roles.cache.get(roleId);
  const roleName = role ? roleDisplayName(role) : "your FG role";

  // Ask first, delete after — same Yes/No pattern as the share offer.
  // Slash: ephemeral. Prefix: public (the fake interaction ignores the
  // ephemeral flag and sends to the channel).
  await interaction.reply({
    embeds: [
      wildFieldEmbed(
        "Remove FG role",
        [{ name: "Role", value: role ? roleMention(role) : "FG role" }],
        `Delete ${roleName} for good? Tap Yes to delete it.`,
      ),
    ],
    components: [buildDecisionButtons("fg-remove")],
    ephemeral: true,
    allowedMentions: { parse: [] },
  });
  const confirm = await interaction.fetchReply();
  const collector = confirm.createMessageComponentCollector({
    componentType: ComponentType.Button,
    time: SHARE_TIMEOUT_MS,
  });

  let finishing = false;
  collector.on("collect", async (button) => {
    if (button.customId !== "fg-remove:yes" && button.customId !== "fg-remove:no") {
      await button.deferUpdate();
      return;
    }
    if (button.user.id !== interaction.user.id) {
      await button
        .reply({
          embeds: [wildMessageEmbed("This confirmation isn't for you.")],
          ephemeral: true,
        })
        .catch(() => undefined);
      return;
    }
    if (finishing) {
      await button.deferUpdate();
      return;
    }
    finishing = true;
    try {
      if (button.customId === "fg-remove:no") {
        await button.update({
          embeds: [wildMessageEmbed("Your FG role was kept.")],
          components: [],
          allowedMentions: { parse: [] },
        });
      } else {
        // Re-check at click time: the role may already be gone, or no
        // longer theirs (removed by staff, or cleanup ran).
        const fresh = store.get(guild.id);
        const stillOwns =
          fresh.fgRoleOwners[roleId] === interaction.user.id &&
          Boolean(fresh.fgRoles[roleId]);
        const liveRole = guild.roles.cache.get(roleId);
        if (!stillOwns) {
          await button.update({
            embeds: [wildMessageEmbed("That FG role is already gone.")],
            components: [],
            allowedMentions: { parse: [] },
          });
        } else {
          if (liveRole) {
            await liveRole
              .delete(`FG role removed by ${interaction.user.id}`)
              .catch(() => undefined);
          }
          const nextSettings = store.get(guild.id);
          delete nextSettings.fgRoles[roleId];
          delete nextSettings.fgRoleOwners[roleId];
          delete nextSettings.fgRoleSharers[roleId];
          nextSettings.protectedRoleIds = nextSettings.protectedRoleIds.filter(
            (id) => id !== roleId,
          );
          try {
            await store.set(guild.id, nextSettings);
          } catch {
            await button.update({
              embeds: [
                wildMessageEmbed("The bot couldn't save that change. Try again."),
              ],
              components: [],
              allowedMentions: { parse: [] },
            });
            collector.stop("answered");
            return;
          }
          await button.update({
            embeds: [wildMessageEmbed("Your FG role is gone.")],
            components: [],
            allowedMentions: { parse: [] },
          });
        }
      }
    } catch {
      if (!button.replied && !button.deferred) {
        await button
          .reply({
            embeds: [
              wildMessageEmbed("The bot couldn't finish removing that FG role."),
            ],
            ephemeral: true,
          })
          .catch(() => undefined);
      }
    }
    collector.stop("answered");
  });

  collector.on("end", async (_collected, reason) => {
    if (reason !== "time") return;
    await confirm
      .edit({
        embeds: [
          wildMessageEmbed("FG role removal expired — your FG role was kept."),
        ],
        components: [buildDecisionButtons("fg-remove", true)],
        allowedMentions: { parse: [] },
      })
      .catch(() => undefined);
  });
}

async function handleListCommand(
  interaction: ChatInputCommandInteraction,
  store: ConfigStore,
): Promise<void> {
  const guild = interaction.guild!;
  const settings = store.get(guild.id);
  // Fresh fetch: a cached member could still show an Administrator bit
  // or whitelisted role that was already removed.
  const member = await fetchMemberFresh(guild, interaction.user.id);
  if (
    !isBotAdmin(member, guild.ownerId) &&
    !hasManageServer(interaction) &&
    !(member && isWhitelisted(member, settings))
  ) {
    await replyText(
      interaction,
      "Only Manage Server members or whitelisted members can list FG roles.",
    );
    return;
  }
  const entries = Object.entries(settings.fgRoleOwners).slice(0, 25);
  const fields = entries.map(([roleId, ownerId]) => {
    const role = guild.roles.cache.get(roleId);
    return {
      name: role ? roleDisplayName(role) : `Deleted role \`${roleId}\``,
      value: `Owner: <@${ownerId}>`,
    };
  });
  const extra = Object.keys(settings.fgRoleOwners).length - entries.length;
  await interaction.reply({
    embeds: [
      wildFieldEmbed(
        "FG roles",
        fields,
        fields.length === 0
          ? "No FG roles yet."
          : extra > 0
            ? `Showing ${fields.length} of ${Object.keys(settings.fgRoleOwners).length} FG roles.`
            : undefined,
      ),
    ],
    ephemeral: true,
    allowedMentions: { parse: [] },
  });
}

async function handleCleanupCommand(
  interaction: ChatInputCommandInteraction,
  store: ConfigStore,
): Promise<void> {
  if (!(await requireManageServer(interaction))) return;
  const guild = interaction.guild!;
  const settings = store.get(guild.id);
  const nextSettings = store.get(guild.id);
  let removed = 0;
  let unregistered = 0;
  for (const [roleId, ownerId] of Object.entries(settings.fgRoleOwners)) {
    const role = guild.roles.cache.get(roleId);
    if (!role) {
      delete nextSettings.fgRoles[roleId];
      delete nextSettings.fgRoleOwners[roleId];
      delete nextSettings.fgRoleSharers[roleId];
      nextSettings.protectedRoleIds = nextSettings.protectedRoleIds.filter(
        (id) => id !== roleId,
      );
      unregistered += 1;
      continue;
    }
    const owner = await guild.members.fetch(ownerId).catch(() => null);
    if (!owner) {
      await role.delete("FG role owner left the server").catch(() => undefined);
      delete nextSettings.fgRoles[roleId];
      delete nextSettings.fgRoleOwners[roleId];
      delete nextSettings.fgRoleSharers[roleId];
      nextSettings.protectedRoleIds = nextSettings.protectedRoleIds.filter(
        (id) => id !== roleId,
      );
      removed += 1;
    }
  }
  // FG roles with no owner record whose Discord role is gone.
  for (const roleId of Object.keys(settings.fgRoles)) {
    if (settings.fgRoleOwners[roleId]) continue;
    if (!guild.roles.cache.get(roleId)) {
      delete nextSettings.fgRoles[roleId];
      delete nextSettings.fgRoleSharers[roleId];
      nextSettings.protectedRoleIds = nextSettings.protectedRoleIds.filter(
        (id) => id !== roleId,
      );
      unregistered += 1;
    }
  }
  if (removed === 0 && unregistered === 0) {
    await replyText(interaction, "Nothing to clean up — every FG role has an owner here.", false);
    return;
  }
  await saveSettings(
    interaction,
    store,
    nextSettings,
    `Cleaned up ${removed} FG role${removed === 1 ? "" : "s"} whose owner left, and removed ${unregistered} stale entr${unregistered === 1 ? "y" : "ies"}.`,
  );
}

/**
 * Resolve an FG role from the interaction's role option, or null when
 * the role is not an FG role (or no longer exists). Replies with an
 * error in the null case.
 */
async function resolveFgRole(
  interaction: ChatInputCommandInteraction,
  settings: GuildSettings,
): Promise<Role | null> {
  const guild = interaction.guild!;
  const selectedRole = interaction.options.getRole("role", true);
  const role = guild.roles.cache.get(selectedRole.id);
  if (!role || !settings.fgRoles[role.id]) {
    await replyText(
      interaction,
      "That isn't an FG role. Make one with /fg create first.",
    );
    return null;
  }
  return role;
}

/**
 * /fg assign @member @role — server owner, administrators, or
 * whitelisted staff only.
 * Gives the FG role to the member AND makes them authorised to share
 * it. If they already hold the role, just authorises them to share it.
 */
async function handleAssignCommand(
  interaction: ChatInputCommandInteraction,
  store: ConfigStore,
): Promise<void> {
  if (!(await requireFgCreator(interaction, store))) return;
  const guild = interaction.guild!;
  const settings = store.get(guild.id);
  const role = await resolveFgRole(interaction, settings);
  if (!role) return;
  const targetUser = interaction.options.getUser("member", true);
  const target = await guild.members.fetch(targetUser.id).catch(() => null);
  if (!target) {
    await replyText(interaction, "That person must be a member of this server first.");
    return;
  }

  const nextSettings = store.get(guild.id);
  const sharers = nextSettings.fgRoleSharers[role.id] ?? [];
  const alreadyHasRole = target.roles.cache.has(role.id);
  const alreadyAuthorised = sharers.includes(target.id);

  if (!alreadyHasRole) {
    const botMember =
      guild.members.me ?? (await guild.members.fetchMe().catch(() => null));
    if (
      !botMember?.permissions.has(PermissionFlagsBits.ManageRoles) ||
      botMember.roles.highest.comparePositionTo(role) <= 0
    ) {
      await replyText(
        interaction,
        "The bot can't manage that FG role. Move its role above it first.",
      );
      return;
    }
    try {
      await target.roles.add(role, `FG role assigned by ${interaction.user.id}`);
    } catch {
      await replyText(
        interaction,
        "The bot couldn't give them that FG role. Check its permissions and try again.",
      );
      return;
    }
  }

  if (!alreadyAuthorised) {
    nextSettings.fgRoleSharers[role.id] = [...sharers, target.id];
  }
  await saveSettings(
    interaction,
    store,
    nextSettings,
    alreadyHasRole
      ? alreadyAuthorised
        ? `${memberDisplayName(target)} is already authorised to share ${roleDisplayName(role)}.`
        : `${memberDisplayName(target)} can now share ${roleDisplayName(role)}.`
      : `${memberDisplayName(target)} now has ${roleDisplayName(role)} and can share it.`,
  );
}

/**
 * /fg auth add/remove/list @member @role — the FG role's owner, the
 * server owner, or a whitelisted member. Auth is permission to share
 * only: the member does NOT get the role itself.
 */
async function handleAuthCommand(
  interaction: ChatInputCommandInteraction,
  store: ConfigStore,
  action: string,
): Promise<void> {
  const guild = interaction.guild!;
  const settings = store.get(guild.id);
  const role = await resolveFgRole(interaction, settings);
  if (!role) return;
  // Fresh fetch: a cached member could still show an Administrator bit
  // or whitelisted role that was already removed.
  const member = await fetchMemberFresh(guild, interaction.user.id);
  if (!member) {
    await replyText(interaction, "You need to be a member of this server first.");
    return;
  }
  if (
    !isBotAdmin(member, guild.ownerId) &&
    !canAuthFgRole(member, role.id, settings)
  ) {
    await replyText(
      interaction,
      "Only the FG role owner, the server owner, administrators, or whitelisted members can do that.",
    );
    return;
  }

  if (action === "list") {
    const ownerId = settings.fgRoleOwners[role.id];
    const sharerIds = settings.fgRoleSharers[role.id] ?? [];
    const lines: string[] = [];
    if (ownerId) {
      const owner = await guild.members.fetch(ownerId).catch(() => null);
      lines.push(`Owner: ${owner ? memberDisplayName(owner) : `<@${ownerId}>`}`);
    }
    for (const userId of sharerIds.slice(0, 24)) {
      const sharer = await guild.members.fetch(userId).catch(() => null);
      lines.push(sharer ? memberDisplayName(sharer) : `<@${userId}>`);
    }
    await interaction.reply({
      embeds: [
        wildFieldEmbed(
          `Who can share ${roleDisplayName(role)}`,
          [{ name: "Authorised sharers", value: lines.join("\n") || "Nobody yet." }],
        ),
      ],
      ephemeral: true,
      allowedMentions: { parse: [] },
    });
    return;
  }

  const targetUser = interaction.options.getUser("member", true);
  const target = await guild.members.fetch(targetUser.id).catch(() => null);
  if (!target) {
    await replyText(interaction, "That person must be a member of this server first.");
    return;
  }
  const nextSettings = store.get(guild.id);
  const sharers = nextSettings.fgRoleSharers[role.id] ?? [];

  if (action === "add") {
    if (settings.fgRoleOwners[role.id] === target.id) {
      await replyText(
        interaction,
        `${memberDisplayName(target)} already owns ${roleDisplayName(role)}, so they can already share it.`,
      );
      return;
    }
    if (sharers.includes(target.id)) {
      await replyText(
        interaction,
        `${memberDisplayName(target)} is already authorised to share ${roleDisplayName(role)}.`,
      );
      return;
    }
    nextSettings.fgRoleSharers[role.id] = [...sharers, target.id];
    await saveSettings(
      interaction,
      store,
      nextSettings,
      `${memberDisplayName(target)} can now share ${roleDisplayName(role)}. They don't get the role itself.`,
    );
    return;
  }

  // action === "remove"
  if (settings.fgRoleOwners[role.id] === target.id) {
    await replyText(
      interaction,
      "You can't remove the FG role owner from sharing their own role.",
    );
    return;
  }
  if (!sharers.includes(target.id)) {
    await replyText(
      interaction,
      `${memberDisplayName(target)} isn't authorised to share ${roleDisplayName(role)}.`,
    );
    return;
  }
  nextSettings.fgRoleSharers[role.id] = sharers.filter((id) => id !== target.id);
  await saveSettings(
    interaction,
    store,
    nextSettings,
    `${memberDisplayName(target)} can no longer share ${roleDisplayName(role)}. They keep the role itself if they have it.`,
  );
}

function buildShareEmbed(
  title: string,
  requesterId: string,
  targetId: string,
  role: Role | null,
  status?: string,
): EmbedBuilder {
  return wildFieldEmbed(
    title,
    [
      { name: "Role", value: role ? roleMention(role) : "FG role" },
      { name: "From", value: `<@${requesterId}>` },
      { name: "To", value: `<@${targetId}>` },
    ],
    status ?? "Tap Yes to accept.",
  );
}

function buildDecisionButtons(prefix = "fg-share", disabled = false): ActionRowBuilder<ButtonBuilder> {
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(`${prefix}:yes`)
      .setLabel("Yes")
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(disabled),
    new ButtonBuilder()
      .setCustomId(`${prefix}:no`)
      .setLabel("No")
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(disabled),
  );
}

async function finishShareOffer(
  button: ButtonInteraction,
  guild: Guild,
  requesterId: string,
  targetId: string,
  roleId: string,
  store: ConfigStore,
): Promise<boolean> {
  if (button.user.id !== targetId) {
    await button.reply({
      embeds: [wildMessageEmbed("This FG role offer is for the mentioned member.")],
      ephemeral: true,
    });
    return false;
  }

  const role = guild.roles.cache.get(roleId);
  const settings = store.get(guild.id);
  if (!role || !settings.fgRoles[roleId]) {
    await button.update({
      embeds: [
        buildShareEmbed(
          "FG role offer ended",
          requesterId,
          targetId,
          role ?? null,
          "This FG role is no longer available.",
        ),
      ],
      components: [],
      allowedMentions: { parse: [] },
    });
    return true;
  }

  if (button.customId === "fg-share:no") {
    await button.update({
      embeds: [
        buildShareEmbed(
          "FG role declined",
          requesterId,
          targetId,
          role,
          `<@${targetId}> declined ${roleMention(role)}.`,
        ),
      ],
      components: [],
      allowedMentions: { parse: [] },
    });
    return true;
  }

  const requester = await fetchMemberFresh(guild, requesterId);
  if (
    !requester ||
    (!isBotAdmin(requester, guild.ownerId) && !isFgSharer(requester, roleId, settings))
  ) {
    await button.update({
      embeds: [
        buildShareEmbed(
          "FG role offer ended",
          requesterId,
          targetId,
          role,
          "The person who shared this role no longer has share access.",
        ),
      ],
      components: [],
      allowedMentions: { parse: [] },
    });
    return true;
  }

  const target = await guild.members.fetch(targetId).catch(() => null);
  const botMember = guild.members.me ?? (await guild.members.fetchMe().catch(() => null));
  if (
    !target ||
    !botMember?.permissions.has(PermissionFlagsBits.ManageRoles) ||
    botMember.roles.highest.comparePositionTo(role) <= 0
  ) {
    await button.update({
      embeds: [
        buildShareEmbed(
          "FG role could not be applied",
          requesterId,
          targetId,
          role,
          "The bot can't manage this role right now. Ask server staff to check its role order and permissions.",
        ),
      ],
      components: [],
      allowedMentions: { parse: [] },
    });
    return true;
  }

  if (target.roles.cache.has(role.id)) {
    await button.update({
      embeds: [
        buildShareEmbed(
          "FG role already assigned",
          requesterId,
          targetId,
          role,
          `<@${targetId}> already has ${roleMention(role)}.`,
        ),
      ],
      components: [],
      allowedMentions: { parse: [] },
    });
    return true;
  }

  try {
    await target.roles.add(role, `FG role accepted by ${targetId}`);
    await button.update({
      embeds: [
        buildShareEmbed(
          "FG role accepted",
          requesterId,
          targetId,
          role,
          `<@${targetId}> accepted ${roleMention(role)}.`,
        ),
      ],
      components: [],
      allowedMentions: { parse: [] },
    });
  } catch {
    await button.update({
      embeds: [
        buildShareEmbed(
          "FG role could not be applied",
          requesterId,
          targetId,
          role,
          "The bot couldn't assign this role. Ask server staff to check its permissions.",
        ),
      ],
      components: [],
      allowedMentions: { parse: [] },
    });
  }
  return true;
}

async function handleShareCommand(
  interaction: ChatInputCommandInteraction,
  store: ConfigStore,
): Promise<void> {
  // Wild-only extra: Bleed documents no share command. All errors here are
  // ephemeral plain text; only the offer itself is public.
  const guild = interaction.guild!;
  const settings = store.get(guild.id);
  const memberUser = interaction.options.getUser("member", true);
  const selectedRole = interaction.options.getRole("role", true);
  const role = guild.roles.cache.get(selectedRole.id);

  if (!role || !settings.fgRoles[role.id]) {
    await replyText(
      interaction,
      "That isn't an FG role. Make one with /fg create first.",
    );
    return;
  }
  if (memberUser.id === interaction.user.id) {
    await replyText(interaction, "You can't share a role with yourself.");
    return;
  }

  // Fresh fetch for the requester: their share access is an
  // authorisation decision, so a cached member could still show an
  // Administrator bit or whitelisted role that was already removed.
  const requester = await fetchMemberFresh(guild, interaction.user.id);
  const target = await guild.members.fetch(memberUser.id).catch(() => null);
  if (!requester || !target) {
    await replyText(interaction, "Both people need to be members of this server.");
    return;
  }
  // Assign + auth model: the caller may share when they are the server
  // owner, an Administrator, whitelisted, the FG role's owner, or listed
  // as an authorised sharer for that role (assigned by staff or authed
  // by the owner). Holding the role alone is not enough, and an authed
  // member who does not hold the role can still share it.
  if (
    !isBotAdmin(requester, guild.ownerId) &&
    !isFgSharer(requester, role.id, settings)
  ) {
    await replyText(
      interaction,
      "You aren't authorised to share that FG role. Only the server owner, administrators, whitelisted members, the FG role owner, and people assigned or authed for it can share it.",
    );
    return;
  }
  if (target.roles.cache.has(role.id)) {
    await replyText(interaction, "They already have that FG role.");
    return;
  }

  const botMember =
    guild.members.me ?? (await guild.members.fetchMe().catch(() => null));
  if (
    !botMember?.permissions.has(PermissionFlagsBits.ManageRoles) ||
    botMember.roles.highest.comparePositionTo(role) <= 0
  ) {
    await replyText(
      interaction,
      "The bot can't manage that FG role. Move its role above it first.",
    );
    return;
  }

  await interaction.reply({
    embeds: [buildShareEmbed("FG role share", requester.id, target.id, role)],
    components: [buildDecisionButtons()],
    allowedMentions: { parse: [], users: [target.id] },
  });
  const offer = await interaction.fetchReply();
  const collector = offer.createMessageComponentCollector({
    componentType: ComponentType.Button,
    time: SHARE_TIMEOUT_MS,
  });

  let finishing = false;
  collector.on("collect", async (button) => {
    if (button.customId !== "fg-share:yes" && button.customId !== "fg-share:no") {
      await button.deferUpdate();
      return;
    }
    if (button.user.id !== target.id) {
      await finishShareOffer(button, guild, requester.id, target.id, role.id, store);
      return;
    }
    if (finishing) {
      await button.deferUpdate();
      return;
    }
    finishing = true;
    let answered = false;
    try {
      answered = await finishShareOffer(
        button,
        guild,
        requester.id,
        target.id,
        role.id,
        store,
      );
    } catch {
      if (!button.replied && !button.deferred) {
        await button
          .reply({
            embeds: [wildMessageEmbed("The bot couldn't complete this FG role offer.")],
            ephemeral: true,
          })
          .catch(() => undefined);
      }
      answered = true;
    }
    if (answered) {
      collector.stop("answered");
    } else {
      finishing = false;
    }
  });

  collector.on("end", async (_collected, reason) => {
    if (reason !== "time") return;
    await offer
      .edit({
        embeds: [
          buildShareEmbed(
            "FG role offer expired",
            requester.id,
            target.id,
            role,
            "This offer expired without a response.",
          ),
        ],
        components: [buildDecisionButtons("fg-share", true)],
        allowedMentions: { parse: [] },
      })
      .catch(() => undefined);
  });
}

export async function handleFgCommand(
  interaction: ChatInputCommandInteraction,
  store: ConfigStore,
): Promise<void> {
  if (interaction.commandName !== "fg") return;
  if (!interaction.guild) {
    await replyText(interaction, "FG commands are only available inside a server.");
    return;
  }

  const group = interaction.options.getSubcommandGroup(false);
  const action = interaction.options.getSubcommand();
  if (group === "auth") {
    await handleAuthCommand(interaction, store, action);
    return;
  }
  switch (action) {
    case "base":
      await handleBaseCommand(interaction, store);
      return;
    case "color":
      await handleColorCommand(interaction, store);
      return;
    case "create":
      await handleCreateCommand(interaction, store);
      return;
    case "rename":
      await handleRenameCommand(interaction, store);
      return;
    case "icon":
      await handleIconCommand(interaction, store);
      return;
    case "remove":
      await handleRemoveCommand(interaction, store);
      return;
    case "list":
      await handleListCommand(interaction, store);
      return;
    case "cleanup":
      await handleCleanupCommand(interaction, store);
      return;
    case "assign":
      await handleAssignCommand(interaction, store);
      return;
    case "share":
      await handleShareCommand(interaction, store);
      return;
    default:
      await replyText(interaction, "Use /help fg to see FG commands.");
  }
}
