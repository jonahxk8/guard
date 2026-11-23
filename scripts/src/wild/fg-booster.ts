import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonInteraction,
  ButtonStyle,
  ChatInputCommandInteraction,
  ComponentType,
  EmbedBuilder,
  Guild,
  GuildMember,
  PermissionFlagsBits,
  Role,
  SlashCommandBuilder,
} from "discord.js";
import { ConfigStore, GuildSettings } from "./config-store.js";
import { BOT_BLACK, wildEmbed } from "./embeds.js";
import { canShareRole, isWhitelisted } from "./authorization.js";
import { memberDisplayName, roleDisplayName, roleMention } from "./names.js";
import { isDangerousRole } from "./role-guard.js";
import { WILD_ERROR_REPLY } from "./reply.js";

/**
 * FG roles, Bleed booster-role style.
 *
 * Bleed's booster roles are unique, personal, cosmetic roles that a member
 * customises themselves (name, colour, icon) and that sit under one base
 * role. Wild copies that model, with three Wild adaptations (labelled as
 * such in the docs, NOT Bleed behaviour):
 *  - Eligibility is being whitelisted, not boosting the server.
 *  - One FG role per member (Wild rule).
 *  - The award role is granted when a member creates their FG role, not
 *    when they boost — Wild has no boost event to hook.
 *  - /fg share is Wild-only. Bleed documents no share command.
 *
 * All slash replies are ephemeral plain text, except /fg list and the
 * public share offer (black embeds, no footer/timestamp). Errors are
 * never public.
 */

const SHARE_TIMEOUT_MS = 5 * 60 * 1_000;
const MAX_FG_NAME_LENGTH = 90;

const COLOR_NAMES: Record<string, string> = {
  red: "#ff0000",
  orange: "#ff8800",
  yellow: "#ffff00",
  green: "#00ff00",
  blue: "#0000ff",
  purple: "#800080",
  pink: "#ff69b4",
  white: "#ffffff",
  black: "#000000",
  grey: "#808080",
  gray: "#808080",
};

/**
 * Parse a colour as hex (#rrggbb, rrggbb, #rgb) or a basic colour name.
 * Returns a "#rrggbb" string, or null when the input is not a colour.
 */
export function parseFgColor(input: string): string | null {
  const value = input.trim().toLowerCase();
  if (value in COLOR_NAMES) return COLOR_NAMES[value];
  const hex = value.startsWith("#") ? value.slice(1) : value;
  if (/^[0-9a-f]{6}$/.test(hex)) return `#${hex}`;
  if (/^[0-9a-f]{3}$/.test(hex)) {
    return `#${hex[0]}${hex[0]}${hex[1]}${hex[1]}${hex[2]}${hex[2]}`;
  }
  return null;
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
  .setDescription("Your own FG role — colour, name, icon, and sharing")
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
      .setDescription("Create your own FG role with a colour")
      .addStringOption((option) =>
        option.setName("color").setDescription("Colour: hex or name").setRequired(true),
      )
      .addStringOption((option) =>
        option.setName("second_color").setDescription("Second colour for a gradient"),
      )
      .addStringOption((option) =>
        option
          .setName("name")
          .setDescription("Name for your FG role")
          .setMinLength(1)
          .setMaxLength(MAX_FG_NAME_LENGTH)
          .setRequired(true),
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
      .addStringOption((option) =>
        option.setName("color").setDescription("Colour: hex or name").setRequired(true),
      )
      .addStringOption((option) =>
        option.setName("second_color").setDescription("Second colour for a gradient"),
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
  .addSubcommandGroup((group) =>
    group
      .setName("award")
      .setDescription("Shared role given when someone makes an FG role")
      .addSubcommand((command) =>
        command
          .setName("set")
          .setDescription("Set the award role")
          .addRoleOption((option) =>
            option.setName("role").setDescription("Role to award").setRequired(true),
          ),
      )
      .addSubcommand((command) =>
        command.setName("view").setDescription("View the award role"),
      )
      .addSubcommand((command) =>
        command.setName("remove").setDescription("Clear the award role"),
      ),
  );

async function replyText(
  interaction: ChatInputCommandInteraction,
  content: string,
  isError = true,
): Promise<void> {
  // Most plain-text replies from the FG commands are errors, so the
  // default is error. Success replies pass false explicitly (see
  // saveSettings and the colour/rename/icon confirmations). The flag is a
  // symbol-keyed property: discord.js builds the reply payload from named
  // fields only, so it never reaches Discord. The prefix adapter reads it
  // to auto-delete visible error replies.
  await interaction.reply({
    content,
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
  if (hasManageServer(interaction)) return true;
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
    `${roleDisplayName(role)} is now the FG base role. FG roles sit just under it — keep it above any coloured roles or the colour won't show.${warning}`,
  );
}

/**
 * Shared FG-role creation, used by /fg color (for yourself) and
 * /fg create (for yourself or a named member). The caller must already
 * have passed the owner-or-whitelisted gate. `requireBase` is true for
 * /fg create, which needs a base role set; /fg color works without one.
 */
async function createFgRole(
  interaction: ChatInputCommandInteraction,
  store: ConfigStore,
  targetId: string,
  colorInput: string,
  secondColorInput: string | null,
  nameInput: string,
  requireBase: boolean,
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

  const color = parseFgColor(colorInput);
  if (!color) {
    await replyText(
      interaction,
      "That isn't a colour. Use a hex colour like #ff0000 or a name like blue.",
    );
    return;
  }
  const secondColor = secondColorInput ? parseFgColor(secondColorInput) : null;
  if (secondColorInput && !secondColor) {
    await replyText(interaction, "That second colour isn't a colour.");
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

  if (requireBase && !settings.fgBaseRoleId) {
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

  let role: Role;
  try {
    role = await guild.roles.create({
      name,
      color: color as `#${string}`,
      permissions: [],
      hoist: false,
      mentionable: false,
      position: baseRole ? Math.max(0, baseRole.position - 1) : undefined,
      reason: `FG role created by ${interaction.user.id} for ${targetId}`,
    });
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

  // Wild adaptation: the award role is granted when the FG role is made,
  // not when the member boosts (Wild has no boost event to hook).
  if (nextSettings.fgAwardRoleId) {
    const awardRole = guild.roles.cache.get(nextSettings.fgAwardRoleId);
    if (awardRole && !target.roles.cache.has(awardRole.id)) {
      await target.roles.add(awardRole, "FG award role").catch(() => undefined);
    }
  }

  const gradientNote = secondColor
    ? " Discord roles only show one colour, so your role uses the first colour."
    : "";
  await replyText(
    interaction,
    forSelf
      ? `${roleDisplayName(role)} is your FG role now. It's protected, so only whitelisted people can give it to anyone else.${gradientNote}`
      : `Created FG role ${roleDisplayName(role)} for ${memberDisplayName(target)}. It's protected, so only whitelisted people can give it to anyone else.${gradientNote}`,
    false,
  );
}

/** Owner-or-whitelisted gate for FG creation. Returns the caller or null. */
async function requireFgCreator(
  interaction: ChatInputCommandInteraction,
  store: ConfigStore,
): Promise<GuildMember | null> {
  const guild = interaction.guild!;
  const settings = store.get(guild.id);
  const member = await guild.members.fetch(interaction.user.id).catch(() => null);
  if (!member) {
    await replyText(interaction, "You need to be a member of this server first.");
    return null;
  }
  // Wild rule: eligibility is being whitelisted (or the server owner),
  // not boosting. Bleed gates this on boosting instead.
  if (interaction.user.id !== guild.ownerId && !isWhitelisted(member, settings)) {
    await replyText(
      interaction,
      "Only the server owner or whitelisted members can create FG roles.",
    );
    return null;
  }
  return member;
}

async function handleColorCommand(
  interaction: ChatInputCommandInteraction,
  store: ConfigStore,
): Promise<void> {
  if (!(await requireFgCreator(interaction, store))) return;
  await createFgRole(
    interaction,
    store,
    interaction.user.id,
    interaction.options.getString("color", true),
    interaction.options.getString("second_color"),
    interaction.options.getString("name", true),
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
    interaction.options.getString("color", true),
    interaction.options.getString("second_color"),
    interaction.options.getString("name", true),
    true,
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
      "You don't have an FG role yet — make one with /fg color first.",
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
      "You don't have an FG role yet — make one with /fg color first.",
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
  if (role) {
    await role.delete(`FG role removed by ${interaction.user.id}`).catch(() => undefined);
  }
  const nextSettings = store.get(guild.id);
  delete nextSettings.fgRoles[roleId];
  delete nextSettings.fgRoleOwners[roleId];
  nextSettings.protectedRoleIds = nextSettings.protectedRoleIds.filter(
    (id) => id !== roleId,
  );
  await saveSettings(
    interaction,
    store,
    nextSettings,
    "Your FG role is gone.",
  );
}

async function handleListCommand(
  interaction: ChatInputCommandInteraction,
  store: ConfigStore,
): Promise<void> {
  const guild = interaction.guild!;
  const settings = store.get(guild.id);
  const member = await guild.members.fetch(interaction.user.id).catch(() => null);
  if (
    interaction.user.id !== guild.ownerId &&
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
  const lines = entries.map(([roleId, ownerId], index) => {
    const role = guild.roles.cache.get(roleId);
    return `\`${index + 1}.\` ${role ? `<@&${roleId}>` : `Deleted role \`${roleId}\``} — <@${ownerId}>`;
  });
  if (Object.keys(settings.fgRoleOwners).length > lines.length) {
    lines.push(
      `…and ${Object.keys(settings.fgRoleOwners).length - lines.length} more.`,
    );
  }
  await interaction.reply({
    embeds: [
      wildEmbed(
        "FG roles",
        lines.length > 0 ? lines.join("\n") : "No FG roles yet.",
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

async function handleAwardCommand(
  interaction: ChatInputCommandInteraction,
  store: ConfigStore,
  action: string,
): Promise<void> {
  if (!(await requireManageServer(interaction))) return;
  const guild = interaction.guild!;
  const settings = store.get(guild.id);

  if (action === "view") {
    const awardRoleId = settings.fgAwardRoleId;
    const awardRole = awardRoleId ? guild.roles.cache.get(awardRoleId) : undefined;
    await replyText(
      interaction,
      awardRole
        ? `The FG award role is ${roleDisplayName(awardRole)}. It's given when someone makes an FG role.`
        : "No FG award role is set.",
      false,
    );
    return;
  }

  if (action === "remove") {
    await saveSettings(
      interaction,
      store,
      { ...settings, fgAwardRoleId: null },
      "The FG award role is cleared.",
    );
    return;
  }

  const selectedRole = interaction.options.getRole("role", true);
  const role = guild.roles.cache.get(selectedRole.id);
  if (!role || role.id === guild.id || role.managed || isDangerousRole(role)) {
    await replyText(interaction, "That role can't be the FG award role.");
    return;
  }
  await saveSettings(
    interaction,
    store,
    { ...settings, fgAwardRoleId: role.id },
    `${roleDisplayName(role)} will be given to members when they make an FG role.`,
  );
}

function buildShareEmbed(
  title: string,
  requesterId: string,
  targetId: string,
  role: Role | null,
  status?: string,
): EmbedBuilder {
  const roleMentionText = role ? roleMention(role) : "FG role";
  return new EmbedBuilder()
    .setColor(BOT_BLACK)
    .setTitle(title)
    .setDescription(
      status ??
        `<@${requesterId}> wants to share ${roleMentionText} with <@${targetId}>.\n\nTap Yes to accept.`,
    );
}

function buildDecisionButtons(disabled = false): ActionRowBuilder<ButtonBuilder> {
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId("fg-share:yes")
      .setLabel("Yes")
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(disabled),
    new ButtonBuilder()
      .setCustomId("fg-share:no")
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
      content: "This FG role offer is for the mentioned member.",
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

  const requester = await guild.members.fetch(requesterId).catch(() => null);
  if (
    !requester ||
    (requesterId !== guild.ownerId && !canShareRole(requester, roleId, settings))
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
      "That isn't an FG role. Make one with /fg color first.",
    );
    return;
  }
  if (memberUser.id === interaction.user.id) {
    await replyText(interaction, "You can't share a role with yourself.");
    return;
  }

  const requester = await guild.members.fetch(interaction.user.id).catch(() => null);
  const target = await guild.members.fetch(memberUser.id).catch(() => null);
  if (!requester || !target) {
    await replyText(interaction, "Both people need to be members of this server.");
    return;
  }
  if (!requester.roles.cache.has(role.id)) {
    await replyText(interaction, "You need to hold that FG role to share it.");
    return;
  }
  if (
    interaction.user.id !== guild.ownerId &&
    !canShareRole(requester, role.id, settings)
  ) {
    await replyText(interaction, "You aren't whitelisted to share that FG role.");
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
            content: "The bot couldn't complete this FG role offer.",
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
        components: [buildDecisionButtons(true)],
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
  if (group === "award") {
    await handleAwardCommand(interaction, store, action);
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
    case "share":
      await handleShareCommand(interaction, store);
      return;
    default:
      await replyText(interaction, "Use /help fg to see FG commands.");
  }
}
