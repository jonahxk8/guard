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

export const wildCommand = new SlashCommandBuilder()
  .setName("wild")
  .setDescription("Browse roles and protect important server roles")
  .addSubcommand((command) =>
    command.setName("roles").setDescription("Browse every role in this server"),
  )
  .addSubcommand((command) =>
    command.setName("status").setDescription("View Wild's protection settings"),
  )
  .addSubcommandGroup((group) =>
    group
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
      ),
  )
  .addSubcommandGroup((group) =>
    group
      .setName("watch")
      .setDescription("Choose which roles Wild protects")
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
      ),
  )
  .addSubcommandGroup((group) =>
    group
      .setName("allow")
      .setDescription("Manage who may assign protected roles")
      .addSubcommand((command) =>
        command
          .setName("add")
          .setDescription("Allow a server member to assign protected roles")
          .addUserOption((option) =>
            option.setName("user").setDescription("Member to allow").setRequired(true),
          ),
      )
      .addSubcommand((command) =>
        command
          .setName("remove")
          .setDescription("Remove a member from the allowlist")
          .addUserOption((option) =>
            option.setName("user").setDescription("Member to remove").setRequired(true),
          ),
      )
      .addSubcommand((command) =>
        command.setName("list").setDescription("List everyone allowed to assign protected roles"),
      ),
  )
  .addSubcommandGroup((group) =>
    group
      .setName("logs")
      .setDescription("Choose where Wild sends role guard alerts")
      .addSubcommand((command) =>
        command
          .setName("set")
          .setDescription("Set the channel for role guard alerts")
          .addChannelOption((option) =>
            option
              .setName("channel")
              .setDescription("Channel where Wild should send alerts")
              .addChannelTypes(ChannelType.GuildText)
              .setRequired(true),
          ),
      )
      .addSubcommand((command) =>
        command.setName("clear").setDescription("Turn off role guard alerts"),
      ),
  );

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
    content: "You need **Manage Server** permission to change Wild's settings.",
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
    await interaction.reply({ embeds: [wildEmbed("Wild updated", successMessage)], ephemeral: true });
  } catch {
    await interaction.reply({
      content: "Wild couldn't save this change. Check its local settings storage and try again.",
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

function makeAllowList(
  userIds: string[],
): EmbedBuilder {
  const lines = userIds
    .slice(0, MAX_LIST_LINES)
    .map((id, index) => `\`${index + 1}.\` <@${id}>`);
  const hiddenCount = Math.max(0, userIds.length - lines.length);
  if (hiddenCount > 0) lines.push(`…and ${hiddenCount} more.`);
  return wildEmbed(
    "Allowed members",
    lines.length > 0 ? lines.join("\n") : "No one is allowlisted yet.",
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
        content: "That role can't be protected by Wild.",
        ephemeral: true,
      });
      return;
    }

    const botMember =
      guild.members.me ?? (await guild.members.fetchMe().catch(() => null));
    if (!botMember?.permissions.has(PermissionFlagsBits.ManageRoles)) {
      await interaction.reply({
        content: "Wild needs **Manage Roles** before it can protect roles.",
        ephemeral: true,
      });
      return;
    }
    if (botMember.roles.highest.comparePositionTo(role) <= 0) {
      await interaction.reply({
        content: "Move Wild's bot role above the role you want it to protect.",
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
      `${role} is now protected. If Wild can't verify that the assigner is allowlisted, it removes the role.`,
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

async function handleAllowCommand(
  interaction: ChatInputCommandInteraction,
  store: ConfigStore,
  action: string,
): Promise<void> {
  const guild = interaction.guild!;
  const settings = store.get(guild.id);

  if (action === "list") {
    await interaction.reply({
      embeds: [makeAllowList(settings.allowedUserIds)],
      ephemeral: true,
      allowedMentions: { parse: [] },
    });
    return;
  }

  const user = interaction.options.getUser("user", true);
  if (action === "add") {
    const member = await guild.members.fetch(user.id).catch(() => null);
    if (!member) {
      await interaction.reply({
        content: "That person must be a member of this server before they can be allowlisted.",
        ephemeral: true,
      });
      return;
    }
    if (settings.allowedUserIds.includes(user.id)) {
      await interaction.reply({
        content: `${user} is already allowlisted.`,
        ephemeral: true,
        allowedMentions: { parse: [] },
      });
      return;
    }
    await saveSettings(
      interaction,
      store,
      { ...settings, allowedUserIds: [...settings.allowedUserIds, user.id] },
      `${user} can now assign protected roles.`,
    );
    return;
  }

  if (!settings.allowedUserIds.includes(user.id)) {
    await interaction.reply({
      content: `${user} isn't currently allowlisted.`,
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
      allowedUserIds: settings.allowedUserIds.filter((id) => id !== user.id),
    },
    `${user} can no longer assign protected roles.`,
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
      "Role guard alerts are turned off.",
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
      content: "Wild couldn't confirm its permissions in this server.",
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
      content: "Give Wild permission to view this channel, send messages, and embed links first.",
      ephemeral: true,
    });
    return;
  }

  await saveSettings(
    interaction,
    store,
    { ...settings, logChannelId: channel.id },
    `Role guard alerts will go to ${channel}.`,
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
        ? "Role removal enforcement is already active."
        : "Role removal enforcement is already paused.",
      ephemeral: true,
    });
    return;
  }

  await saveSettings(
    interaction,
    store,
    { ...settings, enforcementEnabled },
    enforcementEnabled
      ? "Role removal enforcement is active again."
      : "Role removal enforcement is paused. Wild will not remove protected roles until it is resumed.",
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
  const allowCount = settings.allowedUserIds.length;
  const channel = settings.logChannelId
    ? `<#${settings.logChannelId}>`
    : "Off";
  const description = [
    `**Protected roles**  ${protectedCount}`,
    `**Allowed members**  ${allowCount}`,
    `**Alert channel**  ${channel}`,
    `**Enforcement**  ${settings.enforcementEnabled ? "Active" : "Paused"}`,
    `**Role guard**  ${missingPermissions.length === 0 ? "Ready" : "Needs setup"}`,
    missingPermissions.length > 0
      ? `\nMissing permissions: ${missingPermissions.join(", ")}`
      : null,
    `\nIf Wild can't verify who assigned a watched role, it removes that role by default.`,
  ]
    .filter(Boolean)
    .join("\n");
  await interaction.reply({
    embeds: [wildEmbed("Wild status", description)],
    ephemeral: true,
    allowedMentions: { parse: [] },
  });
}

export async function handleWildCommand(
  interaction: ChatInputCommandInteraction,
  store: ConfigStore,
): Promise<void> {
  if (interaction.commandName !== "wild") return;
  if (!requireGuild(interaction)) {
    await interaction.reply({
      content: "Wild commands are only available inside a server.",
      ephemeral: true,
    });
    return;
  }

  const group = interaction.options.getSubcommandGroup(false);
  const action = interaction.options.getSubcommand();

  if (!group && action === "roles") {
    await showRoleBrowser(interaction);
    return;
  }

  if (!(await requireManageServer(interaction))) return;

  if (group === "watch") {
    await handleWatchCommand(interaction, store, action);
    return;
  }
  if (group === "allow") {
    await handleAllowCommand(interaction, store, action);
    return;
  }
  if (group === "logs") {
    await handleLogsCommand(interaction, store, action);
    return;
  }
  if (group === "enforcement") {
    await handleEnforcementCommand(interaction, store, action);
    return;
  }
  if (!group && action === "status") {
    await handleStatusCommand(interaction, store);
    return;
  }

  await interaction.reply({
    content: "That Wild command isn't supported.",
    ephemeral: true,
  });
}
