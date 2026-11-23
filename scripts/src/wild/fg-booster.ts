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
  InteractionCollector,
  Message,
  PermissionFlagsBits,
  Role,
  SlashCommandBuilder,
} from "discord.js";
import { ConfigStore, GuildSettings } from "./config-store.js";
import {
  DEFAULT_AVATAR_COLOR,
  getMemberAvatarDominantColor,
} from "./avatar-color.js";
import { wildEmbed, wildFieldEmbed, wildMessageEmbed } from "./embeds.js";
import {
  canAuthFgRole,
  fetchMemberFresh,
  isBotAdmin,
  isFgSharer,
  isWhitelisted,
} from "./authorization.js";
import { memberDisplayName, roleDisplayName, roleMention } from "./names.js";
import { WILD_ERROR_REPLY, WILD_KEEP_REPLY, ignoreUnauthorized } from "./reply.js";

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
 * Sharing, Wild-only share + auth model (the award role system was
 * removed — it confused people — and so was /fg assign, which did the
 * same thing as /fg create): the server owner, staff admins, or
 * whitelisted staff create FG roles for people with /fg create. An FG
 * role is given to the person it was made for right away; if giving it
 * fails, the just-created role is deleted again so no orphan FG role
 * is left recorded that nobody actually has. It is shared with /fg share — the bot works out which FG role from
 * the caller (their own role, or the one role they are authorised to
 * share) — and the target taps Yes to accept. When someone other than
 * the owner shares the role and the target accepts, the owner gets a
 * one-line DM about it. A holder can give a shared role back with
 * /fg drop, and the owner (or an authorised sharer) can see who holds
 * the role with /fg members. The FG role's owner can authorise other people to share their role with /fg auth add — auth
 * is permission to share only, they do not get the role itself. Only
 * the server owner, staff admins, whitelisted staff, the FG role
 * owner, and people authed for that role may share it.
 *
 * One FG role per member (Wild rule): a member may hold at most one FG
 * role in total, owned or shared. This is enforced going forward only —
 * members who already hold more than one keep them.
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
      .setName("add")
      .setDescription("Add an existing role as an FG role")
      .addRoleOption((option) =>
        option.setName("role").setDescription("Existing role to make an FG role").setRequired(true),
      )
      .addUserOption((option) =>
        option.setName("member").setDescription("Member the FG role is for").setRequired(true),
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
    command
      .setName("drop")
      .setDescription("Give back an FG role someone shared with you"),
  )
  .addSubcommand((command) =>
    command
      .setName("members")
      .setDescription("List the members of your FG role"),
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
      .setDescription("Offer your FG role to a member")
      .addUserOption((option) =>
        option.setName("member").setDescription("Member to offer the role to").setRequired(true),
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
          ),
      )
      .addSubcommand((command) =>
        command
          .setName("remove")
          .setDescription("Stop a member sharing an FG role")
          .addUserOption((option) =>
            option.setName("member").setDescription("Member to remove").setRequired(true),
          ),
      )
      .addSubcommand((command) =>
        command
          .setName("list")
          .setDescription("List who may share an FG role")
          .addRoleOption((option) =>
            option.setName("role").setDescription("FG role (default: your FG role)"),
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
  // Discord sends the member's *effective* permissions in the slash
  // interaction payload, and ADMINISTRATOR expands to ALL permissions
  // there — so `has(ManageGuild, false)` is TRUE for any Administrator
  // on the slash path, even though checkAdmin=false. (The checkAdmin
  // defence only works against GuildMember.permissions, which holds
  // literal role bits — the payload does not.) A raw Administrator
  // must never pass through the Manage Server bit, so exclude them
  // explicitly. The same conjunction works on the prefix path, where
  // the fake interaction carries the member's literal role bits
  // (Administrator is just the 0x8 bit there, so ManageGuild is false
  // already). Literal Manage Server without Administrator is still a
  // staff signal.
  try {
    const permissions = interaction.memberPermissions;
    if (!permissions) return false;
    return Boolean(
      permissions.has(PermissionFlagsBits.ManageGuild, false) &&
        !permissions.has(PermissionFlagsBits.Administrator, false),
    );
  } catch {
    return false;
  }
}

/**
 * Gate for /fg base and /fg cleanup: the server owner, a holder of one
 * of the six staff admin roles, or a member with literal Manage Server.
 * The Discord Administrator permission alone grants nothing (see
 * hasManageServer). Fetch the member fresh: a cached member could still
 * show a staff admin role that was already removed. (Whitelisted
 * members are NOT admitted here — help shows fg base and fg cleanup
 * to owner/admin only, and the handler matches.)
 *
 * An authorisation failure is SILENTLY IGNORED — no reply at all, not
 * even an ephemeral error (see ignoreUnauthorized). The gate is still
 * enforced server-side: ignoring is reply-only and nothing happens.
 */
async function requireManageServer(
  interaction: ChatInputCommandInteraction,
): Promise<boolean> {
  const guild = interaction.guild!;
  const member = await fetchMemberFresh(guild, interaction.user.id);
  if (member && isBotAdmin(member, guild.ownerId)) return true;
  if (hasManageServer(interaction)) return true;
  await ignoreUnauthorized(interaction);
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

/**
 * Does this member hold ANY FG role (owned or shared)? One FG role per
 * member is the rule: a member who already holds one — their own or
 * one shared with them — cannot be given another. Only enforced going
 * forward; members who already hold more than one keep them.
 */
function memberHoldsAnyFgRole(
  member: { roles: { cache: { has: (roleId: string) => boolean } } },
  settings: GuildSettings,
): boolean {
  return Object.keys(settings.fgRoles).some((roleId) =>
    member.roles.cache.has(roleId),
  );
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
  if (memberHoldsAnyFgRole(target, settings)) {
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

  // Give the new role to the person it was made for, right away.
  // If that fails (e.g. the bot's role sits below the new role, or it
  // lost Manage Roles), delete the just-created role instead of
  // leaving an orphan FG role recorded that nobody actually has.
  try {
    await target.roles.add(
      role,
      `FG role created by ${interaction.user.id} for ${targetId}`,
    );
  } catch {
    await role
      .delete("FG role could not be given to its owner")
      .catch(() => undefined);
    await replyText(
      interaction,
      `The bot couldn't give the FG role to ${memberDisplayName(target)} — check the bot's role is above the FG base role and that it has Manage Roles.`,
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
  // or a staff admin), not boosting. Bleed gates this on boosting
  // instead. An authorisation failure is silently ignored — no reply
  // at all, not even an ephemeral error (see ignoreUnauthorized). The
  // gate is still enforced server-side: ignoring is reply-only and
  // nothing happens.
  if (!isBotAdmin(member, guild.ownerId) && !isWhitelisted(member, settings)) {
    await ignoreUnauthorized(interaction);
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

/**
 * /fg add — register an EXISTING role as an FG role, for yourself or a
 * named member. No base role is needed: the role keeps its position,
 * the base only places newly created roles. The role is given to the
 * owner first, and only registered once the add has succeeded — if the
 * add fails, nothing is registered.
 */
async function handleAddCommand(
  interaction: ChatInputCommandInteraction,
  store: ConfigStore,
): Promise<void> {
  if (!(await requireFgCreator(interaction, store))) return;
  const guild = interaction.guild!;
  const settings = store.get(guild.id);
  const selectedRole = interaction.options.getRole("role", true);
  const role = guild.roles.cache.get(selectedRole.id);
  if (!role) {
    await replyText(interaction, "That role is no longer available in this server.");
    return;
  }
  if (settings.fgRoles[role.id]) {
    await replyText(interaction, `${roleDisplayName(role)} is already an FG role.`);
    return;
  }
  if (role.id === guild.id || role.managed) {
    await replyText(interaction, "That role can't be an FG role.");
    return;
  }
  if (role.id === settings.fgBaseRoleId) {
    await replyText(interaction, "The FG base role can't be an FG role itself.");
    return;
  }
  // The member is required: the role belongs to whoever is named,
  // never to the caller by default.
  const targetUser = interaction.options.getUser("member", true);
  const targetId = targetUser.id;
  const forSelf = targetId === interaction.user.id;
  const target = await guild.members.fetch(targetId).catch(() => null);
  if (!target) {
    await replyText(interaction, "That person must be a member of this server first.");
    return;
  }
  if (memberHoldsAnyFgRole(target, settings)) {
    await replyText(
      interaction,
      forSelf
        ? "You already have an FG role — use /fg rename or /fg remove first."
        : "They already have an FG role — use /fg remove first.",
    );
    return;
  }
  const botMember =
    guild.members.me ?? (await guild.members.fetchMe().catch(() => null));
  if (!botMember?.permissions.has(PermissionFlagsBits.ManageRoles)) {
    await replyText(interaction, "The bot needs Manage Roles to give FG roles.");
    return;
  }
  if (botMember.roles.highest.comparePositionTo(role) <= 0) {
    await replyText(
      interaction,
      "The bot's role must be above that role to give it out.",
    );
    return;
  }
  // Give the role to the owner first; only register it once the add
  // has succeeded. If they already hold it, just register it.
  const alreadyHas = target.roles.cache.has(role.id);
  if (!alreadyHas) {
    try {
      await target.roles.add(
        role,
        `FG role added by ${interaction.user.id} for ${targetId}`,
      );
    } catch {
      await replyText(
        interaction,
        `The bot couldn't give ${roleDisplayName(role)} to ${memberDisplayName(target)} — check the bot's role is above it and that it has Manage Roles.`,
      );
      return;
    }
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
    // Registration failed: take the role back so nobody holds an FG
    // role the bot doesn't know about. If they already held it before,
    // leave it alone — it was theirs already.
    if (!alreadyHas) {
      await target.roles
        .remove(role, "FG role registration could not be saved")
        .catch(() => undefined);
    }
    await replyText(
      interaction,
      "The bot couldn't save that FG role. Try again.",
    );
    return;
  }
  await replyText(
    interaction,
    forSelf
      ? `${roleDisplayName(role)} is your FG role now. It's protected, so only whitelisted people can give it to anyone else.`
      : `${roleDisplayName(role)} is now ${memberDisplayName(target)}'s FG role. It's protected, so only whitelisted people can give it to anyone else.`,
    false,
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
      wildEmbed("Remove FG role", `Delete ${roleName} for good? Tap Yes to delete it.`),
    ],
    components: [buildDecisionButtons("fg-remove")],
    ephemeral: true,
    allowedMentions: { parse: [] },
    // Confirmation with a live collector: never auto-delete.
    [WILD_KEEP_REPLY]: true,
  } as Parameters<ChatInputCommandInteraction["reply"]>[0]);
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
  // Fresh fetch: a cached member could still show an admin role
  // or whitelisted role that was already removed.
  // NOTE: /fg list is deliberately NOT part of the silent-ignore rule
  // (its authorisation failure still replies with this error), and it
  // is gated to owner / staff admin / Manage Server / whitelisted —
  // it is not open to everyone. If /fg list is meant to be open to
  // everyone, that is a separate change to this gate and to help.
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
  // One line per FG role in the DESCRIPTION: the role as an @mention,
  // then the owner's plain display name as text, never an @ mention.
  // (Discord does not render mentions in embed field NAMES — they show
  // as raw "<@&id>" text — which is why the list used to show numbers.)
  // An owner who cannot be fetched shows as their plain user ID, also
  // never a mention. The list never pings anyone.
  const lines = await Promise.all(
    entries.map(async ([roleId, ownerId]) => {
      const role = guild.roles.cache.get(roleId);
      const owner = await guild.members.fetch(ownerId).catch(() => null);
      const ownerName =
        owner?.displayName ?? owner?.user?.username ?? ownerId;
      const roleText = role
        ? roleMention(role)
        : `Deleted role \`${roleId}\``;
      return `${roleText} — Owner: ${ownerName}`;
    }),
  );
  const extra = Object.keys(settings.fgRoleOwners).length - entries.length;
  const description =
    lines.length === 0
      ? "No FG roles yet."
      : lines.join("\n") +
        (extra > 0
          ? `\nShowing ${lines.length} of ${Object.keys(settings.fgRoleOwners).length} FG roles.`
          : "");
  await interaction.reply({
    embeds: [wildEmbed("FG roles", description)],
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
 * /fg drop — give back an FG role someone shared with you. No
 * arguments: the bot drops the FG role the caller currently holds.
 * Owners cannot drop their own role — /fg remove is the owner path.
 * No config change: the role still exists, owned by someone else;
 * the caller simply no longer holds it, which frees their one-FG-role
 * slot. The guard cannot interfere: it only watches role GRANTS
 * (audit entries with "$add" changes), never removals.
 */
async function handleDropCommand(
  interaction: ChatInputCommandInteraction,
  store: ConfigStore,
): Promise<void> {
  const guild = interaction.guild!;
  const settings = store.get(guild.id);
  const member = await fetchMemberFresh(guild, interaction.user.id);
  if (!member) {
    await replyText(interaction, "You need to be a member of this server first.");
    return;
  }
  // The first FG role the caller holds (a member who already holds
  // more than one keeps them; dropping one at a time is enough).
  const heldRoleId = Object.keys(settings.fgRoles).find((roleId) =>
    member.roles.cache.has(roleId),
  );
  if (!heldRoleId) {
    await replyText(interaction, "You don't have an FG role to drop.");
    return;
  }
  if (settings.fgRoleOwners[heldRoleId] === interaction.user.id) {
    await replyText(
      interaction,
      "That's your own FG role — use /fg remove to delete it.",
    );
    return;
  }
  const role = guild.roles.cache.get(heldRoleId);
  try {
    await member.roles.remove(
      role ?? heldRoleId,
      `FG role dropped by ${interaction.user.id}`,
    );
  } catch {
    await replyText(
      interaction,
      "The bot couldn't drop that FG role. Ask server staff to check its role order and permissions.",
    );
    return;
  }
  await replyText(
    interaction,
    `Dropped ${role ? roleMention(role) : "your FG role"}.`,
    false,
  );
}

/**
 * /fg members — who currently holds the caller's FG role, owner
 * first (marked), then the other members, plain display names, one
 * per line. The role is worked out from the caller, exactly like
 * /fg share. Members are read with a plain member fetch (REST, no
 * privileged intent needed) so the list is the real holders, not
 * just whoever happens to be in the bot's member cache. Capped at
 * 25 names with a "+N more" line; never pings anyone.
 */
async function handleMembersCommand(
  interaction: ChatInputCommandInteraction,
  store: ConfigStore,
): Promise<void> {
  const guild = interaction.guild!;
  const settings = store.get(guild.id);
  const member = await fetchMemberFresh(guild, interaction.user.id);
  if (!member) {
    await replyText(interaction, "You need to be a member of this server first.");
    return;
  }
  const resolved = resolveShareRole(guild, member, settings);
  if ("error" in resolved) {
    await replyText(interaction, resolved.error);
    return;
  }
  const role = resolved.role;
  const ownerId = settings.fgRoleOwners[role.id];
  const allMembers = await guild.members.fetch().catch(() => null);
  const holders: GuildMember[] = [];
  if (allMembers) {
    for (const holder of allMembers.values()) {
      if (holder.roles.cache.has(role.id)) holders.push(holder);
    }
  }
  const ownerFirst = [...holders].sort((a, b) => {
    if (a.id === ownerId) return -1;
    if (b.id === ownerId) return 1;
    return 0;
  });
  const shown = ownerFirst.slice(0, 25);
  const extra = ownerFirst.length - shown.length;
  const lines = shown.map((holder) =>
    holder.id === ownerId
      ? `${memberDisplayName(holder)} — Owner`
      : memberDisplayName(holder),
  );
  let description: string;
  if (lines.length === 0) {
    description = `Nobody holds ${roleDisplayName(role)} right now.`;
  } else if (lines.length === 1 && ownerFirst[0]?.id === ownerId) {
    description = `Only ${memberDisplayName(ownerFirst[0])} holds ${roleDisplayName(role)}.`;
  } else {
    description = lines.join("\n") + (extra > 0 ? `\n+${extra} more` : "");
  }
  await interaction.reply({
    embeds: [wildEmbed(`Members of ${roleDisplayName(role)}`, description)],
    ephemeral: true,
    allowedMentions: { parse: [] },
  });
}

/**
 * Work out which FG role an auth command is about, from the caller
 * alone — /fg auth add and /fg auth remove take only @member now, no
 * role argument (same auto-detection as /fg share: the caller's own FG
 * role, or the one role they are authorised to share, or an error
 * naming the roles when they can share several). /fg auth list takes
 * an optional @role: when one is given it is used as-is, otherwise it
 * auto-detects the same way. Returns the role, or null after replying
 * with an error.
 */
async function resolveAuthRole(
  interaction: ChatInputCommandInteraction,
  requester: GuildMember,
  settings: GuildSettings,
  action: string,
): Promise<Role | null> {
  const guild = interaction.guild!;
  if (action === "list") {
    const selectedRole = interaction.options.getRole("role", false);
    if (selectedRole) {
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
  }
  const resolved = resolveShareRole(guild, requester, settings);
  if ("error" in resolved) {
    await replyText(interaction, resolved.error);
    return null;
  }
  return resolved.role;
}

/**
 * /fg auth add/remove @member — the FG role is worked out from the
 * caller (see resolveAuthRole); /fg auth list [@role] — the role is
 * optional and auto-detected when omitted. The FG role's owner, the
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
  // Fresh fetch: a cached member could still show an admin role
  // or whitelisted role that was already removed.
  const member = await fetchMemberFresh(guild, interaction.user.id);
  if (!member) {
    await replyText(interaction, "You need to be a member of this server first.");
    return;
  }
  // Authorisation first, before resolving which role this is about:
  // the caller must be the server owner, a staff admin, whitelisted,
  // or own an FG role — otherwise they cannot auth for any role, and
  // the failure is silently ignored (no reply at all, not even an
  // ephemeral error — see ignoreUnauthorized). The gate is still
  // enforced server-side: ignoring is reply-only and nothing happens.
  // Functional errors below (that role isn't an FG role, a target who
  // already shares it, ...) still reply as before.
  const ownsAnyFgRole = Object.values(settings.fgRoleOwners ?? {}).includes(
    member.id,
  );
  if (
    !isBotAdmin(member, guild.ownerId) &&
    !isWhitelisted(member, settings) &&
    !ownsAnyFgRole
  ) {
    await ignoreUnauthorized(interaction);
    return;
  }
  const role = await resolveAuthRole(interaction, member, settings, action);
  if (!role) return;
  if (
    !isBotAdmin(member, guild.ownerId) &&
    !canAuthFgRole(member, role.id, settings)
  ) {
    await ignoreUnauthorized(interaction);
    return;
  }

  if (action === "list") {
    const ownerId = settings.fgRoleOwners[role.id];
    const sharerIds = settings.fgRoleSharers[role.id] ?? [];
    const lines: string[] = [];
    if (ownerId) {
      const owner = await guild.members.fetch(ownerId).catch(() => null);
      // Plain user ID when the owner can't be fetched — never a
      // mention of someone who isn't here, same rule as /fg list.
      lines.push(`Owner: ${owner ? memberDisplayName(owner) : ownerId}`);
    }
    for (const userId of sharerIds.slice(0, 24)) {
      const sharer = await guild.members.fetch(userId).catch(() => null);
      lines.push(sharer ? memberDisplayName(sharer) : userId);
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

/**
 * The share offer embed, sleek: title + one description line, no
 * fields. The line carries everything — who is offering which role to
 * whom, or what happened to the offer.
 */
function buildShareEmbed(title: string, description: string): EmbedBuilder {
  return wildEmbed(title, description);
}

/**
 * Work out which FG role a caller is sharing, from the caller alone —
 * /fg share takes only @member now, no role argument.
 * (a) If the caller owns an FG role, share that one.
 * (b) Else if the caller is authorised to share exactly one FG role,
 *     share that one.
 * (c) Else (authorised to share several and owns none) the bot cannot
 *     pick one — the caller gets an error naming the roles.
 * Returns the role, or an error message to reply with.
 */
function resolveShareRole(
  guild: Guild,
  requester: GuildMember,
  settings: GuildSettings,
): { role: Role } | { error: string } {
  const own = findOwnFgRole(guild, settings, requester.id);
  if (own) return { role: own.role };
  const admin = isBotAdmin(requester, guild.ownerId);
  const shareable: Role[] = [];
  for (const roleId of Object.keys(settings.fgRoles)) {
    const role = guild.roles.cache.get(roleId);
    if (!role) continue;
    if (admin || isFgSharer(requester, roleId, settings)) {
      shareable.push(role);
    }
  }
  if (shareable.length === 1) return { role: shareable[0] };
  if (shareable.length === 0) {
    return {
      error:
        "You aren't authorised to share an FG role. Only the server owner, administrators, whitelisted members, the FG role owner, and people authed for it can share it.",
    };
  }
  const names = shareable.slice(0, 10).map((role) => roleMention(role));
  const extra = shareable.length - names.length;
  return {
    error:
      `You can share more than one FG role: ${names.join(", ")}` +
      (extra > 0 ? `, and ${extra} more` : "") +
      ". The bot can't pick one for you.",
  };
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
      content: `<@${targetId}>`,
      embeds: [
        buildShareEmbed(
          "fg share ended",
          "This FG role is no longer available.",
        ),
      ],
      components: [],
      allowedMentions: { parse: ["users"], users: [targetId] },
    });
    return true;
  }

  if (button.customId === "fg-share:no") {
    await button.update({
      content: `<@${targetId}>`,
      embeds: [
        buildShareEmbed(
          "fg share declined",
          `<@${targetId}> declined ${roleMention(role)}.`,
        ),
      ],
      components: [],
      allowedMentions: { parse: ["users"], users: [targetId] },
    });
    return true;
  }

  const requester = await fetchMemberFresh(guild, requesterId);
  if (
    !requester ||
    (!isBotAdmin(requester, guild.ownerId) && !isFgSharer(requester, roleId, settings))
  ) {
    await button.update({
      content: `<@${targetId}>`,
      embeds: [
        buildShareEmbed(
          "fg share ended",
          "The person who shared this role no longer has share access.",
        ),
      ],
      components: [],
      allowedMentions: { parse: ["users"], users: [targetId] },
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
      content: `<@${targetId}>`,
      embeds: [
        buildShareEmbed(
          "fg share could not be applied",
          "The bot can't manage this role right now. Ask server staff to check its role order and permissions.",
        ),
      ],
      components: [],
      allowedMentions: { parse: ["users"], users: [targetId] },
    });
    return true;
  }

  // One FG role per member, re-checked at accept time: the target
  // may have gained an FG role since the offer was sent.
  if (memberHoldsAnyFgRole(target, store.get(guild.id))) {
    await button.update({
      content: `<@${targetId}>`,
      embeds: [
        buildShareEmbed(
          "fg share already assigned",
          `<@${targetId}> already has an FG role.`,
        ),
      ],
      components: [],
      allowedMentions: { parse: ["users"], users: [targetId] },
    });
    return true;
  }

  try {
    await target.roles.add(role, `FG role accepted by ${targetId}`);
    // The FG role's owner hears about it when someone ELSE shares
    // their role and the target accepts — one line, no log entry.
    // The owner sharing their own role gets no DM about their own
    // action. A failed DM (closed DMs) never breaks the share.
    const ownerId = settings.fgRoleOwners[roleId];
    if (ownerId && ownerId !== requesterId) {
      const owner = await guild.members.fetch(ownerId).catch(() => null);
      if (owner) {
        await owner
          .send({
            embeds: [
              wildMessageEmbed(
                `${memberDisplayName(requester)} shared your FG role ${roleDisplayName(role)} to ${memberDisplayName(target)}.`,
              ),
            ],
            allowedMentions: { parse: [] },
          })
          .catch(() => undefined);
      }
    }
    await button.update({
      content: `<@${targetId}>`,
      embeds: [
        buildShareEmbed(
          "fg share accepted",
          `<@${targetId}> accepted ${roleMention(role)}.`,
        ),
      ],
      components: [],
      allowedMentions: { parse: ["users"], users: [targetId] },
    });
  } catch {
    await button.update({
      content: `<@${targetId}>`,
      embeds: [
        buildShareEmbed(
          "fg share could not be applied",
          "The bot couldn't give them this role. Ask server staff to check its permissions.",
        ),
      ],
      components: [],
      allowedMentions: { parse: ["users"], users: [targetId] },
    });
  }
  return true;
}

async function handleShareCommand(
  interaction: ChatInputCommandInteraction,
  store: ConfigStore,
): Promise<void> {
  // Wild-only extra: Bleed documents no share command. /fg share takes
  // only @member — the bot works out which FG role from the caller
  // (their own role, or the one role they are authorised to share).
  // All errors here are ephemeral embeds; only the offer itself is public.
  const guild = interaction.guild!;
  const settings = store.get(guild.id);
  const memberUser = interaction.options.getUser("member", true);
  if (memberUser.id === interaction.user.id) {
    await replyText(interaction, "You can't share a role with yourself.");
    return;
  }

  // Fresh fetch for the requester: their share access is an
  // authorisation decision, so a cached member could still show an
  // admin role or whitelisted role that was already removed.
  const requester = await fetchMemberFresh(guild, interaction.user.id);
  const target = await guild.members.fetch(memberUser.id).catch(() => null);
  if (!requester || !target) {
    await replyText(interaction, "Both people need to be members of this server.");
    return;
  }
  const resolved = resolveShareRole(guild, requester, settings);
  if ("error" in resolved) {
    await replyText(interaction, resolved.error);
    return;
  }
  const role = resolved.role;
  // One FG role per member: the target may not already hold any FG
  // role, owned or shared.
  if (memberHoldsAnyFgRole(target, settings)) {
    await replyText(interaction, "They already have an FG role.");
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

  // Sending the offer is the one Discord API call in this handler with
  // no specific reply of its own: if it fails (the bot cannot send
  // here, a rate limit, a Discord outage), the generic prefix/slash
  // catch would answer instead — and the prefix catch used to swallow
  // the error without logging it, which is how two ,fg share failures
  // stayed undiagnosed. Name the step here, in the reply and in the
  // Railway logs, so the cause is visible. Every other step in this
  // handler already has its own reply (no FG role, already has one,
  // bot cannot manage the role).
  let offer: Message;
  try {
    await interaction.reply({
      // The target is pinged in the message content, not just the embed:
      // a mention in the embed alone was not notifying them. Only the
      // target user is pinged — never the role, never @everyone.
      content: `<@${target.id}>`,
      embeds: [
        buildShareEmbed(
          "fg share",
          `<@${requester.id}> is offering ${roleMention(role)} to <@${target.id}> — tap Yes to accept.`,
        ),
      ],
      components: [buildDecisionButtons()],
      allowedMentions: { parse: ["users"], users: [target.id] },
      // Offer with a live collector (5 minutes): never auto-delete.
      [WILD_KEEP_REPLY]: true,
    } as Parameters<ChatInputCommandInteraction["reply"]>[0]);
    offer = await interaction.fetchReply();
  } catch (error) {
    console.error(
      "[wild] fg share: could not send the offer:",
      error instanceof Error ? (error.stack ?? error.message) : String(error),
    );
    await replyText(
      interaction,
      "Couldn't send the FG role offer. Check the bot can send messages in this channel and try again.",
    ).catch(() => undefined);
    return;
  }
  let collector: InteractionCollector<ButtonInteraction>;
  try {
    collector = offer.createMessageComponentCollector({
      componentType: ComponentType.Button,
      time: SHARE_TIMEOUT_MS,
    });
  } catch (error) {
    console.error(
      "[wild] fg share: could not set up the offer buttons:",
      error instanceof Error ? (error.stack ?? error.message) : String(error),
    );
    await replyText(
      interaction,
      "The offer went out but its buttons couldn't be set up. Try again.",
    ).catch(() => undefined);
    return;
  }

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
        content: `<@${target.id}>`,
        embeds: [
          buildShareEmbed(
            "fg share expired",
            `<@${requester.id}>'s offer of ${roleMention(role)} to <@${target.id}> expired without a response.`,
          ),
        ],
        components: [buildDecisionButtons("fg-share", true)],
        allowedMentions: { parse: ["users"], users: [target.id] },
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
    case "add":
      await handleAddCommand(interaction, store);
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
    case "drop":
      await handleDropCommand(interaction, store);
      return;
    case "members":
      await handleMembersCommand(interaction, store);
      return;
    case "list":
      await handleListCommand(interaction, store);
      return;
    case "cleanup":
      await handleCleanupCommand(interaction, store);
      return;
    case "share":
      await handleShareCommand(interaction, store);
      return;
    default:
      await replyText(interaction, "Use /help fg to see FG commands.");
  }
}
