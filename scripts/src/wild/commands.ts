import {
  ChannelType,
  ChatInputCommandInteraction,
  PermissionFlagsBits,
  SlashCommandBuilder,
} from "discord.js";
import { ConfigStore, GuildSettings, blacklistCount, blacklistEntries, isBlacklisted } from "./config-store.js";
import { wildFieldEmbed } from "./embeds.js";
import { isWhitelisted } from "./authorization.js";
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

// Wild has six slash commands: /protect, /whitelist, /status,
// /setup, /fg, and /blacklist. Confirmations and errors are short ephemeral
// plain text — no embeds, no titles, no footers. Only /status uses an embed
// (one colourless embed, short lines). /blacklist list is plain text.

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
  if (hasManageServer(interaction)) return true;
  await interaction.reply({
    content: "You need Manage Server for that.",
    ephemeral: true,
  });
  return false;
}

async function replyText(
  interaction: ChatInputCommandInteraction,
  content: string,
  isError = true,
): Promise<void> {
  // Most plain-text replies from the guard commands are errors, so the
  // default is error. Success replies pass false explicitly (see
  // saveSettings). The flag is a symbol-keyed property: discord.js builds
  // the reply payload from named fields only, so it never reaches Discord.
  // The prefix adapter reads it to auto-delete visible error replies.
  await interaction.reply({
    content,
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
  // Manage Server or whitelisted (the server owner bypasses too).
  const member = await guild.members.fetch(interaction.user.id).catch(() => null);
  if (
    interaction.user.id !== guild.ownerId &&
    !hasManageServer(interaction) &&
    !(member && isWhitelisted(member, settings))
  ) {
    await replyText(
      interaction,
      "Only Manage Server members or whitelisted members can list the blacklist.",
    );
    return;
  }
  const entries = blacklistEntries(settings).slice(0, 25);
  const lines = entries.map(
    ({ userId, roleId }, index) => `\`${index + 1}.\` <@${userId}> — <@&${roleId}>`,
  );
  if (blacklistEntries(settings).length > lines.length) {
    lines.push(
      `…and ${blacklistEntries(settings).length - lines.length} more.`,
    );
  }
  await replyText(
    interaction,
    lines.length > 0 ? lines.join("\n") : "The blacklist is empty.",
    false,
  );
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
    embeds: [wildFieldEmbed("Wild", fields)],
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
      content: "These commands are only available inside a server.",
      ephemeral: true,
    });
    return;
  }

  // Every guard command requires Manage Server, except /blacklist list,
  // which Manage Server members or whitelisted members can use (the list
  // handler itself enforces that — the owner bypasses too).
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
    content: "That command isn't supported.",
    ephemeral: true,
  });
}
