import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonInteraction,
  ButtonStyle,
  ChannelType,
  ChatInputCommandInteraction,
  ComponentType,
  Message,
  PermissionFlagsBits,
  SlashCommandBuilder,
} from "discord.js";
import { ConfigStore, GuildSettings, blacklistCount, blacklistEntries, isBlacklisted } from "./config-store.js";
import { wildFieldEmbed, wildMessageEmbed } from "./embeds.js";
import { fetchMemberFresh, isBotAdmin, isBotAdminPermissions, isWhitelisted } from "./authorization.js";
import {
  channelDisplayName,
  memberDisplayName,
  roleDisplayName,
  roleMention,
} from "./names.js";
import { WILD_ERROR_REPLY } from "./reply.js";
import {
  getUnmanageableRoleIds,
  isDangerousRole,
} from "./role-guard.js";

// Wild has seven slash commands: /protect, /whitelist, /status,
// /setup, /fg, /blacklist, and /help. Confirmations and errors are short
// ephemeral embeds (one colorless embed, message in the description).
// Only /status uses a field embed (one colorless embed, short lines).

export const protectCommand = new SlashCommandBuilder()
  .setName("protect")
  .setDescription("Protect a role, or stop protecting it")
  .addRoleOption((option) =>
    option.setName("role").setDescription("Role to protect").setRequired(true),
  );

export const whitelistCommand = new SlashCommandBuilder()
  .setName("whitelist")
  .setDescription("Whitelist a member or role, or remove them")
  .addUserOption((option) =>
    option.setName("user").setDescription("Member to whitelist"),
  )
  .addRoleOption((option) =>
    option.setName("role").setDescription("Role to whitelist"),
  );

export const statusCommand = new SlashCommandBuilder()
  .setName("status")
  .setDescription("View role protection settings");

export const setupCommand = new SlashCommandBuilder()
  .setName("setup")
  .setDescription("Set the alert channel, or turn alerts off")
  .addChannelOption((option) =>
    option
      .setName("channel")
      .setDescription("Channel for guard alerts (leave empty to turn alerts off)")
      .addChannelTypes(ChannelType.GuildText),
  );

export const blacklistCommand = new SlashCommandBuilder()
  .setName("blacklist")
  .setDescription("Block a member from a protected role")
  .addSubcommand((command) =>
    command
      .setName("add")
      .setDescription("Blacklist a member from a protected role")
      .addUserOption((option) =>
        option.setName("user").setDescription("Member to blacklist").setRequired(true),
      )
      .addRoleOption((option) =>
        option.setName("role").setDescription("Protected role").setRequired(true),
      ),
  )
  .addSubcommand((command) =>
    command
      .setName("remove")
      .setDescription("Remove a member from the blacklist for a role")
      .addUserOption((option) =>
        option.setName("user").setDescription("Member to unblacklist").setRequired(true),
      )
      .addRoleOption((option) =>
        option.setName("role").setDescription("Protected role").setRequired(true),
      ),
  )
  .addSubcommand((command) =>
    command.setName("list").setDescription("List all blacklist entries"),
  );

const ADMIN_PERMISSION = PermissionFlagsBits.ManageGuild;

function hasManageServer(interaction: ChatInputCommandInteraction): boolean {
  return Boolean(interaction.memberPermissions?.has(ADMIN_PERMISSION));
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
  await interaction.reply({
    embeds: [wildMessageEmbed("You need Manage Server for that.")],
    ephemeral: true,
  });
  return false;
}

async function replyText(
  interaction: ChatInputCommandInteraction,
  content: string,
  isError = true,
): Promise<void> {
  // Small replies are embeds, not plain text: the short message goes in
  // the description of a colorless embed with no title (see embeds.ts).
  // Most replies from the guard commands are errors, so the default is
  // error. Success replies pass false explicitly (see saveSettings).
  // The flag is a symbol-keyed property: discord.js builds the reply
  // payload from named fields only, so it never reaches Discord. The
  // prefix adapter reads it to auto-delete visible error replies.
  await interaction.reply({
    embeds: [wildMessageEmbed(content)],
    ephemeral: true,
    [WILD_ERROR_REPLY]: isError,
  } as Parameters<ChatInputCommandInteraction["reply"]>[0]);
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

function requireGuild(
  interaction: ChatInputCommandInteraction,
): interaction is ChatInputCommandInteraction & { guild: NonNullable<ChatInputCommandInteraction["guild"]> } {
  return interaction.guild !== null;
}

async function handleProtectCommand(
  interaction: ChatInputCommandInteraction,
  store: ConfigStore,
): Promise<void> {
  const guild = interaction.guild!;
  const settings = store.get(guild.id);
  const selectedRole = interaction.options.getRole("role", true);
  const role = guild.roles.cache.get(selectedRole.id);
  if (!role) {
    await replyText(interaction, "That role is no longer available in this server.");
    return;
  }
  if (role.id === guild.id || role.managed) {
    await replyText(interaction, "That role can't be protected.");
    return;
  }
  if (isDangerousRole(role)) {
    await replyText(
      interaction,
      "That role has Administrator, so it can't be protected.",
    );
    return;
  }
  // FG roles are always protected — /protect can neither add nor remove
  // that protection. Without this, toggling /protect on an FG role would
  // silently drop it from protectedRoleIds while it stayed an FG role.
  if (settings.fgRoles[role.id]) {
    await replyText(
      interaction,
      `${roleDisplayName(role)} is an FG role — it's always protected.`,
    );
    return;
  }

  const botMember =
    guild.members.me ?? (await guild.members.fetchMe().catch(() => null));
  if (!botMember?.permissions.has(PermissionFlagsBits.ManageRoles)) {
    await replyText(interaction, "The bot needs Manage Roles to protect roles.");
    return;
  }
  if (botMember.roles.highest.comparePositionTo(role) <= 0) {
    await replyText(interaction, "Move the bot's role above that role first.");
    return;
  }

  if (settings.protectedRoleIds.includes(role.id)) {
    await saveSettings(
      interaction,
      store,
      {
        ...settings,
        protectedRoleIds: settings.protectedRoleIds.filter((id) => id !== role.id),
      },
      `${roleDisplayName(role)} is no longer protected.`,
    );
    return;
  }

  await saveSettings(
    interaction,
    store,
    { ...settings, protectedRoleIds: [...settings.protectedRoleIds, role.id] },
    `${roleDisplayName(role)} is now protected.`,
  );
}

async function handleWhitelistCommand(
  interaction: ChatInputCommandInteraction,
  store: ConfigStore,
): Promise<void> {
  const guild = interaction.guild!;
  const settings = store.get(guild.id);
  const user = interaction.options.getUser("user");
  const selectedRole = interaction.options.getRole("role");
  if (Boolean(user) === Boolean(selectedRole)) {
    await replyText(interaction, "Pick one person or one role.");
    return;
  }

  let targetId: string;
  let targetLabel: string;
  let isRole = false;
  if (user) {
    targetId = user.id;
    // Fetch the member first: the name comes from the member/user, never
    // from interpolating the option object itself — on the prefix path
    // that object is a plain { id }, which renders as "[object Object]".
    const member = await guild.members.fetch(user.id).catch(() => null);
    if (!member) {
      await replyText(
        interaction,
        "That person must be a member of this server first.",
      );
      return;
    }
    targetLabel = memberDisplayName(member, user);
  } else {
    const role = guild.roles.cache.get(selectedRole!.id);
    if (!role || role.id === guild.id) {
      await replyText(interaction, "Pick a role other than @everyone.");
      return;
    }
    targetId = role.id;
    targetLabel = roleDisplayName(role);
    isRole = true;
  }

  const currentIds = isRole ? settings.allowedRoleIds : settings.allowedUserIds;
  const isPresent = currentIds.includes(targetId);
  if (isPresent) {
    await saveSettings(
      interaction,
      store,
      isRole
        ? {
            ...settings,
            allowedRoleIds: settings.allowedRoleIds.filter((id) => id !== targetId),
          }
        : {
            ...settings,
            allowedUserIds: settings.allowedUserIds.filter((id) => id !== targetId),
          },
      `${targetLabel} is no longer whitelisted.`,
    );
    return;
  }

  await saveSettings(
    interaction,
    store,
    isRole
      ? { ...settings, allowedRoleIds: [...settings.allowedRoleIds, targetId] }
      : { ...settings, allowedUserIds: [...settings.allowedUserIds, targetId] },
    `${targetLabel} is now whitelisted.`,
  );
}

async function handleSetupCommand(
  interaction: ChatInputCommandInteraction,
  store: ConfigStore,
): Promise<void> {
  const guild = interaction.guild!;
  const settings = store.get(guild.id);
  const selectedChannel = interaction.options.getChannel("channel", false, [
    ChannelType.GuildText,
  ]);

  if (!selectedChannel) {
    await saveSettings(
      interaction,
      store,
      { ...settings, logChannelId: null },
      "Alerts are turned off.",
    );
    return;
  }

  const channel = guild.channels.cache.get(selectedChannel.id);
  if (!channel || channel.type !== ChannelType.GuildText) {
    await replyText(interaction, "Pick a text channel from this server.");
    return;
  }
  const botMember =
    guild.members.me ?? (await guild.members.fetchMe().catch(() => null));
  if (!botMember) {
    await replyText(interaction, "The bot couldn't confirm its permissions in this server.");
    return;
  }
  const permissions = channel.permissionsFor(botMember);
  if (
    !permissions?.has([
      PermissionFlagsBits.ViewChannel,
      PermissionFlagsBits.SendMessages,
      PermissionFlagsBits.EmbedLinks,
    ])
  ) {
    await replyText(
      interaction,
      "Give the bot permission to view this channel, send messages, and embed links first.",
    );
    return;
  }

  await saveSettings(
    interaction,
    store,
    { ...settings, logChannelId: channel.id },
    `Alerts will go to ${channelDisplayName(channel)}.`,
  );
}

async function handleBlacklistAdd(
  interaction: ChatInputCommandInteraction,
  store: ConfigStore,
): Promise<void> {
  const guild = interaction.guild!;
  const settings = store.get(guild.id);
  const user = interaction.options.getUser("user", true);
  const selectedRole = interaction.options.getRole("role", true);
  const role = guild.roles.cache.get(selectedRole.id);
  if (!role) {
    await replyText(interaction, "That role is no longer available in this server.");
    return;
  }
  // The blacklist only makes sense for a role the guard already watches.
  // "pic" was just one example role — this works for any protected role.
  if (!settings.protectedRoleIds.includes(role.id)) {
    await replyText(interaction, "Protect that role first with /protect @role");
    return;
  }
  if (isBlacklisted(settings, user.id, role.id)) {
    const member = await guild.members.fetch(user.id).catch(() => null);
    await replyText(
      interaction,
      `${memberDisplayName(member, user)} is already blacklisted from ${roleMention(role)}.`,
    );
    return;
  }
  const blacklist = { ...settings.blacklist };
  blacklist[user.id] = [...(blacklist[user.id] ?? []), role.id];
  const member = await guild.members.fetch(user.id).catch(() => null);
  await saveSettings(
    interaction,
    store,
    { ...settings, blacklist },
    `${memberDisplayName(member, user)} is now blacklisted from ${roleMention(role)}.`,
  );
}

async function handleBlacklistRemove(
  interaction: ChatInputCommandInteraction,
  store: ConfigStore,
): Promise<void> {
  const guild = interaction.guild!;
  const settings = store.get(guild.id);
  const user = interaction.options.getUser("user", true);
  const selectedRole = interaction.options.getRole("role", true);
  const role = guild.roles.cache.get(selectedRole.id);
  if (!role) {
    await replyText(interaction, "That role is no longer available in this server.");
    return;
  }
  if (!isBlacklisted(settings, user.id, role.id)) {
    const member = await guild.members.fetch(user.id).catch(() => null);
    await replyText(
      interaction,
      `${memberDisplayName(member, user)} isn't blacklisted from ${roleMention(role)}.`,
    );
    return;
  }
  const blacklist = { ...settings.blacklist };
  const remaining = (blacklist[user.id] ?? []).filter((id) => id !== role.id);
  if (remaining.length > 0) {
    blacklist[user.id] = remaining;
  } else {
    delete blacklist[user.id];
  }
  const member = await guild.members.fetch(user.id).catch(() => null);
  await saveSettings(
    interaction,
    store,
    { ...settings, blacklist },
    `${memberDisplayName(member, user)} is no longer blacklisted from ${roleMention(role)}.`,
  );
}

async function handleBlacklistList(
  interaction: ChatInputCommandInteraction,
  store: ConfigStore,
): Promise<void> {
  const guild = interaction.guild!;
  const settings = store.get(guild.id);
  // Manage Server or whitelisted (the server owner and Administrators
  // bypass too). Fresh fetch: a cached member could still show an
  // Administrator bit or whitelisted role that was already removed.
  const member = await fetchMemberFresh(guild, interaction.user.id);
  if (
    !isBotAdmin(member, guild.ownerId) &&
    !hasManageServer(interaction) &&
    !(member && isWhitelisted(member, settings))
  ) {
    await replyText(
      interaction,
      "Only Manage Server members or whitelisted members can list the blacklist.",
    );
    return;
  }
  const entries = blacklistEntries(settings);
  const rows: BlacklistListRow[] = [];
  for (const { userId, roleId } of entries) {
    const entryMember = await guild.members.fetch(userId).catch(() => null);
    const role = guild.roles.cache.get(roleId);
    rows.push({
      userId,
      roleId,
      userName: entryMember ? memberDisplayName(entryMember) : `Unknown member \`${userId}\``,
      roleName: role ? roleDisplayName(role) : `Deleted role \`${roleId}\``,
    });
  }
  if (rows.length === 0) {
    await interaction.reply({
      embeds: [wildFieldEmbed("Blacklist", [], "The blacklist is empty.")],
      ephemeral: true,
      allowedMentions: { parse: [] },
    });
    return;
  }
  const ownerId = interaction.user.id;
  const firstPage = buildBlacklistListPage(rows, 1);
  await interaction.reply({
    embeds: [
      wildFieldEmbed(firstPage.title, firstPage.fields),
    ],
    components: buildBlacklistListComponents(firstPage.page, firstPage.totalPages, ownerId),
    ephemeral: true,
    allowedMentions: { parse: [] },
  });

  // Paged navigation: buttons live for 5 minutes, then disable.
  // Best-effort only — test doubles and channels without a fetchable
  // reply simply skip the collector (same pattern as /help).
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

  let currentPage = firstPage.page;
  const collector = message.createMessageComponentCollector({
    componentType: ComponentType.Button,
    time: BLACKLIST_BUTTON_TIMEOUT_MS,
  });
  collector.on("collect", async (button) => {
    const nextPage = await handleBlacklistListButton(button, rows, ownerId);
    if (nextPage !== null) currentPage = nextPage;
  });
  collector.on("end", async () => {
    await message
      ?.edit({
        components: buildBlacklistListComponents(currentPage, firstPage.totalPages, ownerId).map(
          (row) =>
            new ActionRowBuilder<ButtonBuilder>().addComponents(
              row.components.map((component) =>
                ButtonBuilder.from(component).setDisabled(true),
              ),
            ),
        ),
      })
      .catch(() => undefined);
  });
}

/** One resolved blacklist entry, ready to render. */
export interface BlacklistListRow {
  userId: string;
  roleId: string;
  userName: string;
  roleName: string;
}

export const BLACKLIST_PAGE_SIZE = 10;
export const BLACKLIST_BUTTON_PREFIX = "wild-blacklist:";
const BLACKLIST_BUTTON_TIMEOUT_MS = 5 * 60 * 1000;

/**
 * Build one page of the blacklist list: 10 users per page, one field
 * per user (name = the member's name, value = the role they are
 * blacklisted from). Pure function, so tests can check page counts
 * without a Discord interaction.
 */
export function buildBlacklistListPage(
  rows: BlacklistListRow[],
  page: number,
): { title: string; fields: { name: string; value: string }[]; totalPages: number; page: number } {
  const totalPages = Math.max(1, Math.ceil(rows.length / BLACKLIST_PAGE_SIZE));
  const safePage = Math.min(Math.max(1, page), totalPages);
  const start = (safePage - 1) * BLACKLIST_PAGE_SIZE;
  const pageRows = rows.slice(start, start + BLACKLIST_PAGE_SIZE);
  return {
    title: totalPages > 1 ? `Blacklist (${safePage}/${totalPages})` : "Blacklist",
    fields: pageRows.map((row, index) => ({
      name: `${start + index + 1}. ${row.userName}`,
      value: `Blacklisted from ${row.roleName}`,
    })),
    totalPages,
    page: safePage,
  };
}

/** Parse a blacklist-list button customId into its owner and target page. */
export function parseBlacklistButton(
  customId: string,
): { ownerId: string; page: number } | null {
  if (!customId.startsWith(BLACKLIST_BUTTON_PREFIX)) return null;
  const rest = customId.slice(BLACKLIST_BUTTON_PREFIX.length);
  const separator = rest.indexOf(":");
  if (separator <= 0) return null;
  const page = Number.parseInt(rest.slice(separator + 1), 10);
  if (!Number.isFinite(page)) return null;
  return { ownerId: rest.slice(0, separator), page };
}

function buildBlacklistListComponents(
  page: number,
  totalPages: number,
  ownerId: string,
): ActionRowBuilder<ButtonBuilder>[] {
  const row = new ActionRowBuilder<ButtonBuilder>();
  if (page > 1) {
    row.addComponents(
      new ButtonBuilder()
        .setCustomId(`${BLACKLIST_BUTTON_PREFIX}${ownerId}:${page - 1}`)
        .setLabel("Prev")
        .setStyle(ButtonStyle.Secondary),
    );
  }
  if (page < totalPages) {
    row.addComponents(
      new ButtonBuilder()
        .setCustomId(`${BLACKLIST_BUTTON_PREFIX}${ownerId}:${page + 1}`)
        .setLabel("Next")
        .setStyle(ButtonStyle.Secondary),
    );
  }
  return row.components.length > 0 ? [row] : [];
}

/**
 * Handle a blacklist-list navigation button press. Returns the page
 * navigated to, or null when the press was rejected (wrong user) or the
 * target is gone. Only the user who ran /blacklist list can use its
 * buttons.
 */
export async function handleBlacklistListButton(
  button: ButtonInteraction,
  rows: BlacklistListRow[],
  ownerId: string,
): Promise<number | null> {
  const parsed = parseBlacklistButton(button.customId);
  if (!parsed) {
    await button.deferUpdate().catch(() => undefined);
    return null;
  }
  if (button.user.id !== parsed.ownerId || parsed.ownerId !== ownerId) {
    await button
      .reply({
        embeds: [
          wildMessageEmbed("This list isn't yours - run /blacklist list to get your own."),
        ],
        ephemeral: true,
      })
      .catch(() => undefined);
    return null;
  }
  const nextPage = buildBlacklistListPage(rows, parsed.page);
  await button
    .update({
      embeds: [wildFieldEmbed(nextPage.title, nextPage.fields)],
      components: buildBlacklistListComponents(nextPage.page, nextPage.totalPages, ownerId),
      allowedMentions: { parse: [] },
    })
    .catch(() => undefined);
  return nextPage.page;
}

async function handleStatusCommand(
  interaction: ChatInputCommandInteraction,
  store: ConfigStore,
): Promise<void> {
  const guild = interaction.guild!;
  const settings = store.get(guild.id);
  const botMember =
    guild.members.me ?? (await guild.members.fetchMe().catch(() => null));
  const missingPermissions = [
    !botMember?.permissions.has(PermissionFlagsBits.ManageRoles) ? "Manage Roles" : null,
    !botMember?.permissions.has(PermissionFlagsBits.ViewAuditLog) ? "View Audit Log" : null,
  ].filter((permission): permission is string => permission !== null);
  const unmanageableRoleIds = getUnmanageableRoleIds(
    guild,
    botMember,
    settings.protectedRoleIds,
  );
  const guardReady =
    missingPermissions.length === 0 && unmanageableRoleIds.length === 0;
  const protectedRoles = settings.protectedRoleIds.slice(0, 10).map((id) => {
    const role = guild.roles.cache.get(id);
    return role ? `<@&${id}>` : `Deleted role \`${id}\``;
  });
  if (settings.protectedRoleIds.length > protectedRoles.length) {
    protectedRoles.push(`…and ${settings.protectedRoleIds.length - protectedRoles.length} more.`);
  }
  const fields: { name: string; value: string }[] = [
    {
      name: `Protected roles (${settings.protectedRoleIds.length})`,
      value:
        protectedRoles.length > 0 ? protectedRoles.join(", ") : "none",
    },
    {
      name: "FG roles",
      value: `${Object.keys(settings.fgRoles).length}`,
    },
    {
      name: "Whitelisted",
      value: `${settings.allowedUserIds.length} members, ${settings.allowedRoleIds.length} roles`,
    },
    { name: "Blacklisted", value: `${blacklistCount(settings)}` },
    {
      name: "Alerts",
      value: settings.logChannelId ? `<#${settings.logChannelId}>` : "Off",
    },
    { name: "Bot", value: guardReady ? "Ready" : "Needs setup" },
  ];
  if (missingPermissions.length > 0) {
    fields.push({
      name: "Missing permissions",
      value: missingPermissions.join(", "),
    });
  }
  if (unmanageableRoleIds.length > 0) {
    fields.push({
      name: "Bot can't manage",
      value: `${unmanageableRoleIds.map((id) => `<@&${id}>`).join(", ")} - move the bot's role above these roles.`,
    });
  }
  await interaction.reply({
    embeds: [wildFieldEmbed("Status", fields)],
    ephemeral: true,
    allowedMentions: { parse: [] },
  });
}

export async function handleGuardCommand(
  interaction: ChatInputCommandInteraction,
  store: ConfigStore,
): Promise<void> {
  const guardCommands = new Set(["protect", "whitelist", "status", "setup", "blacklist"]);
  if (!guardCommands.has(interaction.commandName)) return;
  if (!requireGuild(interaction)) {
    await interaction.reply({
      embeds: [wildMessageEmbed("These commands are only available inside a server.")],
      ephemeral: true,
    });
    return;
  }

  // Every guard command requires Manage Server, except /blacklist list,
  // which Manage Server members or whitelisted members can use (the list
  // handler itself enforces that — the owner and Administrators bypass
  // too).
  const isBlacklistList =
    interaction.commandName === "blacklist" &&
    interaction.options.getSubcommand() === "list";
  if (!isBlacklistList && !(await requireManageServer(interaction))) return;

  switch (interaction.commandName) {
    case "protect":
      await handleProtectCommand(interaction, store);
      return;
    case "whitelist":
      await handleWhitelistCommand(interaction, store);
      return;
    case "status":
      await handleStatusCommand(interaction, store);
      return;
    case "setup":
      await handleSetupCommand(interaction, store);
      return;
    case "blacklist": {
      const action = interaction.options.getSubcommand();
      if (action === "add") {
        await handleBlacklistAdd(interaction, store);
        return;
      }
      if (action === "remove") {
        await handleBlacklistRemove(interaction, store);
        return;
      }
      if (action === "list") {
        await handleBlacklistList(interaction, store);
        return;
      }
      break;
    }
  }

  await interaction.reply({
    embeds: [wildMessageEmbed("That command isn't supported.")],
    ephemeral: true,
  });
}
