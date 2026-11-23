import {
  ChannelType,
  ChatInputCommandInteraction,
  EmbedBuilder,
  PermissionFlagsBits,
  SlashCommandBuilder,
} from "discord.js";
import { ConfigStore, GuildSettings } from "./config-store.js";
import { wildEmbed } from "./embeds.js";
import { showRoleBrowser } from "./role-browser.js";
import {
  getUnmanageableRoleIds,
  isDangerousRole,
} from "./role-guard.js";

export const rolesCommand = new SlashCommandBuilder()
  .setName("roles")
  .setDescription("Browse every role in this server");

export const statusCommand = new SlashCommandBuilder()
  .setName("status")
  .setDescription("View role protection settings");

export const watchCommand = new SlashCommandBuilder()
  .setName("watch")
  .setDescription("Choose which roles are protected")
  .addSubcommand((command) =>
    command
      .setName("add")
      .setDescription("Protect a role from unapproved assignments")
      .addRoleOption((option) =>
        option.setName("role").setDescription("Role to protect").setRequired(true),
      ),
  )
  .addSubcommand((command) =>
    command
      .setName("remove")
      .setDescription("Stop protecting a role")
      .addRoleOption((option) =>
        option.setName("role").setDescription("Role to stop protecting").setRequired(true),
      ),
  )
  .addSubcommand((command) =>
    command.setName("list").setDescription("List all protected roles"),
  );

export const whitelistCommand = new SlashCommandBuilder()
  .setName("whitelist")
  .setDescription("Manage who may assign protected roles")
  .addSubcommand((command) =>
    command
      .setName("add")
      .setDescription("Whitelist a member or role to assign protected roles")
      .addUserOption((option) =>
        option.setName("user").setDescription("Member to whitelist"),
      )
      .addRoleOption((option) =>
        option.setName("role").setDescription("Role to whitelist"),
      ),
  )
  .addSubcommand((command) =>
    command
      .setName("remove")
      .setDescription("Remove a member or role from the whitelist")
      .addUserOption((option) =>
        option.setName("user").setDescription("Member to remove"),
      )
      .addRoleOption((option) =>
        option.setName("role").setDescription("Role to remove"),
      ),
  )
  .addSubcommand((command) =>
    command.setName("list").setDescription("List members and roles whitelisted to assign protected roles"),
  );

export const enforcementCommand = new SlashCommandBuilder()
  .setName("enforcement")
  .setDescription("Pause or resume automatic role removal")
  .addSubcommand((command) =>
    command
      .setName("pause")
      .setDescription("Pause role removal for this server"),
  )
  .addSubcommand((command) =>
    command
      .setName("resume")
      .setDescription("Resume role removal for this server"),
  );

export const logsCommand = new SlashCommandBuilder()
  .setName("logs")
  .setDescription("Choose where guard alerts are sent")
  .addSubcommand((command) =>
    command
      .setName("set")
      .setDescription("Set the channel for guard alerts")
      .addChannelOption((option) =>
        option
          .setName("channel")
          .setDescription("Channel where the bot should send alerts")
          .addChannelTypes(ChannelType.GuildText)
          .setRequired(true),
      ),
  )
  .addSubcommand((command) =>
    command.setName("clear").setDescription("Turn off guard alerts"),
  );

export const commandsHelpCommand = new SlashCommandBuilder()
  .setName("commands")
  .setDescription("Show the available command names");

export async function handleCommandsHelp(
  interaction: ChatInputCommandInteraction,
): Promise<void> {
  const lines = [
    "`/roles` — browse server roles",
    "`/watch add|remove|list` — manage protected roles",
    "`/whitelist add|remove|list` — whitelist members or roles to assign protected roles",
    "`/enforcement pause|resume` — pause or resume automatic removal",
    "`/logs set|clear` — configure guard alerts",
    "`/status` — view protection status",
    "`/fg roles create|assign|list` — manage FG roles",
    "`/fg staff add|remove|list` — manage FG staff",
    "`/fg access add|remove|list` — manage FG assignment and sharing access",
    "`,fg share @member` — send an FG role offer",
  ];
  await interaction.reply({
    embeds: [wildEmbed("Commands", lines.join("\n\n"))],
    ephemeral: true,
  });
}

const ADMIN_PERMISSION = PermissionFlagsBits.ManageGuild;
const MAX_LIST_LINES = 80;

function hasManageServer(interaction: ChatInputCommandInteraction): boolean {
  return Boolean(interaction.memberPermissions?.has(ADMIN_PERMISSION));
}

async function requireManageServer(
  interaction: ChatInputCommandInteraction,
): Promise<boolean> {
  if (hasManageServer(interaction)) return true;
  await interaction.reply({
    content: "You need **Manage Server** permission to change bot settings.",
    ephemeral: true,
  });
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
    await interaction.reply({ embeds: [wildEmbed("Bot updated", successMessage)], ephemeral: true });
  } catch {
    await interaction.reply({
      content: "Bot couldn't save this change. Check its settings storage and try again.",
      ephemeral: true,
    });
  }
}

function requireGuild(
  interaction: ChatInputCommandInteraction,
): interaction is ChatInputCommandInteraction & { guild: NonNullable<ChatInputCommandInteraction["guild"]> } {
  return interaction.guild !== null;
}

function makeRoleList(
  title: string,
  roleIds: string[],
  interaction: ChatInputCommandInteraction,
): EmbedBuilder {
  const lines = roleIds.slice(0, MAX_LIST_LINES).map((id, index) => {
    const role = interaction.guild?.roles.cache.get(id);
    return `\`${index + 1}.\` ${role ? `<@&${id}>` : `Deleted role \`${id}\``}`;
  });
  const hiddenCount = Math.max(0, roleIds.length - lines.length);
  if (hiddenCount > 0) lines.push(`…and ${hiddenCount} more.`);
  return wildEmbed(
    title,
    lines.length > 0 ? lines.join("\n") : "Nothing configured yet.",
  );
}

function makeWhitelist(
  userIds: string[],
  roleIds: string[],
  interaction: ChatInputCommandInteraction,
): EmbedBuilder {
  const memberLines = userIds
    .slice(0, MAX_LIST_LINES)
    .map((id, index) => `\`${index + 1}.\` <@${id}>`);
  const hiddenMembers = Math.max(0, userIds.length - memberLines.length);
  if (hiddenMembers > 0) memberLines.push(`…and ${hiddenMembers} more.`);

  const roleLines = roleIds
    .slice(0, MAX_LIST_LINES)
    .map((id, index) => {
      const role = interaction.guild?.roles.cache.get(id);
      return `\`${index + 1}.\` ${role ? `<@&${id}>` : `Deleted role \`${id}\``}`;
    });
  const hiddenRoles = Math.max(0, roleIds.length - roleLines.length);
  if (hiddenRoles > 0) roleLines.push(`…and ${hiddenRoles} more.`);

  return wildEmbed("Whitelisted assigners", "Members and roles that may assign protected roles.")
    .addFields(
      {
        name: `Members (${userIds.length})`,
        value: memberLines.length > 0 ? memberLines.join("\n") : "None",
        inline: true,
      },
      {
        name: `Roles (${roleIds.length})`,
        value: roleLines.length > 0 ? roleLines.join("\n") : "None",
        inline: true,
      },
    );
}

async function handleWatchCommand(
  interaction: ChatInputCommandInteraction,
  store: ConfigStore,
  action: string,
): Promise<void> {
  const guild = interaction.guild!;
  const settings = store.get(guild.id);

  if (action === "list") {
    await interaction.reply({
      embeds: [makeRoleList("Protected roles", settings.protectedRoleIds, interaction)],
      ephemeral: true,
      allowedMentions: { parse: [] },
    });
    return;
  }

  const selectedRole = interaction.options.getRole("role", true);
  const role = guild.roles.cache.get(selectedRole.id);
  if (!role) {
    await interaction.reply({
      content: "That role is no longer available in this server.",
      ephemeral: true,
    });
    return;
  }
  if (action === "add") {
    if (role.id === guild.id || role.managed) {
      await interaction.reply({
        content: "That role can't be protected by the bot.",
        ephemeral: true,
      });
      return;
    }
    if (isDangerousRole(role)) {
      await interaction.reply({
        content:
          "That role has the Administrator permission, so it can't be protected or handed out through the bot. Protecting it would let whitelisted members grant full admin.",
        ephemeral: true,
      });
      return;
    }

    const botMember =
      guild.members.me ?? (await guild.members.fetchMe().catch(() => null));
    if (!botMember?.permissions.has(PermissionFlagsBits.ManageRoles)) {
      await interaction.reply({
        content: "The bot needs **Manage Roles** before it can protect roles.",
        ephemeral: true,
      });
      return;
    }
    if (botMember.roles.highest.comparePositionTo(role) <= 0) {
      await interaction.reply({
        content: "Move the bot's role above the role you want it to protect.",
        ephemeral: true,
      });
      return;
    }
    if (settings.protectedRoleIds.includes(role.id)) {
      await interaction.reply({
        content: `${role} is already protected.`,
        ephemeral: true,
        allowedMentions: { parse: [] },
      });
      return;
    }

    await saveSettings(
      interaction,
      store,
      { ...settings, protectedRoleIds: [...settings.protectedRoleIds, role.id] },
      `${role} is now protected. If the assigner isn't whitelisted, the bot removes the role.`,
    );
    return;
  }

  if (!settings.protectedRoleIds.includes(role.id)) {
    await interaction.reply({
      content: `${role} isn't currently protected.`,
      ephemeral: true,
      allowedMentions: { parse: [] },
    });
    return;
  }

  await saveSettings(
    interaction,
    store,
    {
      ...settings,
      protectedRoleIds: settings.protectedRoleIds.filter((id) => id !== role.id),
    },
    `${role} is no longer protected.`,
  );
}

async function handleWhitelistCommand(
  interaction: ChatInputCommandInteraction,
  store: ConfigStore,
  action: string,
): Promise<void> {
  const guild = interaction.guild!;
  const settings = store.get(guild.id);

  if (action === "list") {
    await interaction.reply({
      embeds: [
        makeWhitelist(settings.allowedUserIds, settings.allowedRoleIds, interaction),
      ],
      ephemeral: true,
      allowedMentions: { parse: [] },
    });
    return;
  }

  const user = interaction.options.getUser("user");
  const selectedRole = interaction.options.getRole("role");
  if (Boolean(user) === Boolean(selectedRole)) {
    await interaction.reply({
      content: "Choose exactly one member or role.",
      ephemeral: true,
    });
    return;
  }

  let targetId: string;
  let targetLabel: string;
  let isRole = false;
  if (user) {
    targetId = user.id;
    targetLabel = `${user}`;
    if (action === "add") {
      const member = await guild.members.fetch(user.id).catch(() => null);
      if (!member) {
        await interaction.reply({
          content: "That person must be a member of this server before they can be whitelisted.",
          ephemeral: true,
        });
        return;
      }
    }
  } else {
    const role = guild.roles.cache.get(selectedRole!.id);
    if (!role || role.id === guild.id) {
      await interaction.reply({
        content: "Choose a server role other than @everyone.",
        ephemeral: true,
      });
      return;
    }
    targetId = role.id;
    targetLabel = `${role}`;
    isRole = true;
  }

  const currentIds = isRole ? settings.allowedRoleIds : settings.allowedUserIds;
  const isPresent = currentIds.includes(targetId);
  if (action === "add" && isPresent) {
    await interaction.reply({
      content: `${targetLabel} is already whitelisted.`,
      ephemeral: true,
      allowedMentions: { parse: [] },
    });
    return;
  }
  if (action === "remove" && !isPresent) {
    await interaction.reply({
      content: `${targetLabel} isn't currently whitelisted.`,
      ephemeral: true,
      allowedMentions: { parse: [] },
    });
    return;
  }

  if (action === "add") {
    await saveSettings(
      interaction,
      store,
      isRole
        ? { ...settings, allowedRoleIds: [...settings.allowedRoleIds, targetId] }
        : { ...settings, allowedUserIds: [...settings.allowedUserIds, targetId] },
      `${targetLabel} can now assign protected roles.`,
    );
    return;
  }

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
    `${targetLabel} can no longer assign protected roles.`,
  );
}

async function handleLogsCommand(
  interaction: ChatInputCommandInteraction,
  store: ConfigStore,
  action: string,
): Promise<void> {
  const guild = interaction.guild!;
  const settings = store.get(guild.id);

  if (action === "clear") {
    await saveSettings(
      interaction,
      store,
      { ...settings, logChannelId: null },
      "Guard alerts are turned off.",
    );
    return;
  }

  const selectedChannel = interaction.options.getChannel("channel", true, [
    ChannelType.GuildText,
  ]);
  const channel = guild.channels.cache.get(selectedChannel.id);
  if (!channel || channel.type !== ChannelType.GuildText) {
    await interaction.reply({
      content: "Choose a text channel from this server.",
      ephemeral: true,
    });
    return;
  }
  const botMember =
    guild.members.me ?? (await guild.members.fetchMe().catch(() => null));
  if (!botMember) {
    await interaction.reply({
      content: "The bot couldn't confirm its permissions in this server.",
      ephemeral: true,
    });
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
    await interaction.reply({
      content: "Give the bot permission to view this channel, send messages, and embed links first.",
      ephemeral: true,
    });
    return;
  }

  await saveSettings(
    interaction,
    store,
    { ...settings, logChannelId: channel.id },
    `Guard alerts will go to ${channel}.`,
  );
}

async function handleEnforcementCommand(
  interaction: ChatInputCommandInteraction,
  store: ConfigStore,
  action: string,
): Promise<void> {
  const guild = interaction.guild!;
  const settings = store.get(guild.id);
  const enforcementEnabled = action === "resume";

  if (settings.enforcementEnabled === enforcementEnabled) {
    await interaction.reply({
      content: enforcementEnabled
        ? "Automatic role removal is already active."
        : "Automatic role removal is already paused.",
      ephemeral: true,
    });
    return;
  }

  await saveSettings(
    interaction,
    store,
    { ...settings, enforcementEnabled },
    enforcementEnabled
      ? "Automatic role removal is active again."
      : "Automatic role removal is paused. The bot won't remove protected roles until it is resumed.",
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
  const protectedCount = settings.protectedRoleIds.length;
  const whitelistedCount = settings.allowedUserIds.length;
  const channel = settings.logChannelId
    ? `<#${settings.logChannelId}>`
    : "Off";
  const unmanageableRoleIds = getUnmanageableRoleIds(
    guild,
    botMember,
    [
      ...settings.protectedRoleIds,
      ...Object.keys(settings.fgRoles),
    ],
  );
  const guardReady =
    missingPermissions.length === 0 && unmanageableRoleIds.length === 0;
  const description = [
    `**Protected roles**  ${protectedCount}`,
    `**Whitelisted members**  ${whitelistedCount}`,
    `**Whitelisted roles**  ${settings.allowedRoleIds.length}`,
    `**FG roles**  ${Object.keys(settings.fgRoles).length}`,
    `**Alert channel**  ${channel}`,
    `**Enforcement**  ${settings.enforcementEnabled ? "Active" : "Paused"}`,
    `**Guard**  ${guardReady ? "Ready" : "Needs setup"}`,
    missingPermissions.length > 0
      ? `\nMissing permissions: ${missingPermissions.join(", ")}`
      : null,
    unmanageableRoleIds.length > 0
      ? `\nBot can't manage: ${unmanageableRoleIds.map((id) => `<@&${id}>`).join(", ")} — move the bot's role above these roles.`
      : null,
    `\nIf the bot can't verify who assigned a watched role, it removes that role by default.`,
  ]
    .filter(Boolean)
    .join("\n");
  await interaction.reply({
    embeds: [wildEmbed("Bot status", description)],
    ephemeral: true,
    allowedMentions: { parse: [] },
  });
}

export async function handleGuardCommand(
  interaction: ChatInputCommandInteraction,
  store: ConfigStore,
): Promise<void> {
  if (interaction.commandName === "commands") {
    await handleCommandsHelp(interaction);
    return;
  }
  const guardCommands = new Set([
    "roles",
    "status",
    "watch",
    "whitelist",
    "enforcement",
    "logs",
  ]);
  if (!guardCommands.has(interaction.commandName)) return;
  if (!requireGuild(interaction)) {
    await interaction.reply({
      content: "These commands are only available inside a server.",
      ephemeral: true,
    });
    return;
  }

  // Every guard command, including /roles, requires Manage Server.
  if (!(await requireManageServer(interaction))) return;

  switch (interaction.commandName) {
    case "roles":
      await showRoleBrowser(interaction);
      return;
    case "status":
      await handleStatusCommand(interaction, store);
      return;
    case "watch":
      await handleWatchCommand(interaction, store, interaction.options.getSubcommand());
      return;
    case "whitelist":
      await handleWhitelistCommand(interaction, store, interaction.options.getSubcommand());
      return;
    case "enforcement":
      await handleEnforcementCommand(interaction, store, interaction.options.getSubcommand());
      return;
    case "logs":
      await handleLogsCommand(interaction, store, interaction.options.getSubcommand());
      return;
  }

  await interaction.reply({
    content: "That command isn't supported.",
    ephemeral: true,
  });
}

/** Backwards-compatible alias: the old /wild entry point is now handleGuardCommand. */
export const handleWildCommand = handleGuardCommand;
