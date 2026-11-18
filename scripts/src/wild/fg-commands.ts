import {
  ChatInputCommandInteraction,
  PermissionFlagsBits,
  SlashCommandBuilder,
} from "discord.js";
import { ConfigStore, FgRoleAccess, GuildSettings } from "./config-store.js";
import { isFgStaff } from "./authorization.js";
import { wildEmbed } from "./embeds.js";

const MANAGE_GUILD = PermissionFlagsBits.ManageGuild;
const emptyFgAccess = (): FgRoleAccess => ({
  assignUserIds: [],
  assignRoleIds: [],
  shareUserIds: [],
  shareRoleIds: [],
});

export const fgCommand = new SlashCommandBuilder()
  .setName("fg")
  .setDescription("Create and manage FG roles")
  .addSubcommandGroup((group) =>
    group
      .setName("roles")
      .setDescription("Create and assign FG roles")
      .addSubcommand((command) =>
        command
          .setName("create")
          .setDescription("Create an FG role")
          .addStringOption((option) =>
            option
              .setName("name")
              .setDescription("Name for the new FG role")
              .setMinLength(1)
              .setMaxLength(90)
              .setRequired(true),
          ),
      )
      .addSubcommand((command) =>
        command
          .setName("assign")
          .setDescription("Assign an FG role to a member")
          .addRoleOption((option) =>
            option.setName("role").setDescription("FG role to assign").setRequired(true),
          )
          .addUserOption((option) =>
            option.setName("member").setDescription("Member to receive the role").setRequired(true),
          ),
      )
      .addSubcommand((command) =>
        command.setName("list").setDescription("List FG roles"),
      ),
  )
  .addSubcommandGroup((group) =>
    group
      .setName("staff")
      .setDescription("Manage staff allowed to create and assign FG roles")
      .addSubcommand((command) =>
        command
          .setName("add")
          .setDescription("Allow a member or role to manage FG roles")
          .addUserOption((option) =>
            option.setName("member").setDescription("Staff member"),
          )
          .addRoleOption((option) =>
            option.setName("role").setDescription("Staff role"),
          ),
      )
      .addSubcommand((command) =>
        command
          .setName("remove")
          .setDescription("Remove FG staff access")
          .addUserOption((option) =>
            option.setName("member").setDescription("Staff member"),
          )
          .addRoleOption((option) =>
            option.setName("role").setDescription("Staff role"),
          ),
      )
      .addSubcommand((command) =>
        command.setName("list").setDescription("List FG staff members and roles"),
      ),
  )
  .addSubcommandGroup((group) =>
    group
      .setName("access")
      .setDescription("Manage assignment and sharing access for an FG role")
      .addSubcommand((command) =>
        command
          .setName("add")
          .setDescription("Allow a member or role to assign or share an FG role")
          .addRoleOption((option) =>
            option.setName("fg-role").setDescription("FG role to configure").setRequired(true),
          )
          .addStringOption((option) =>
            option
              .setName("permission")
              .setDescription("Permission to grant")
              .addChoices(
                { name: "Assign", value: "assign" },
                { name: "Share", value: "share" },
              )
              .setRequired(true),
          )
          .addUserOption((option) =>
            option.setName("member").setDescription("Member to allow"),
          )
          .addRoleOption((option) =>
            option.setName("role").setDescription("Role to allow"),
          ),
      )
      .addSubcommand((command) =>
        command
          .setName("remove")
          .setDescription("Remove assignment or sharing access from an FG role")
          .addRoleOption((option) =>
            option.setName("fg-role").setDescription("FG role to configure").setRequired(true),
          )
          .addStringOption((option) =>
            option
              .setName("permission")
              .setDescription("Permission to remove")
              .addChoices(
                { name: "Assign", value: "assign" },
                { name: "Share", value: "share" },
              )
              .setRequired(true),
          )
          .addUserOption((option) =>
            option.setName("member").setDescription("Member to remove"),
          )
          .addRoleOption((option) =>
            option.setName("role").setDescription("Role to remove"),
          ),
      )
      .addSubcommand((command) =>
        command
          .setName("list")
          .setDescription("View assignment and sharing access for an FG role")
          .addRoleOption((option) =>
            option.setName("fg-role").setDescription("FG role to inspect").setRequired(true),
          ),
      ),
  );

function isManageServer(interaction: ChatInputCommandInteraction): boolean {
  return Boolean(interaction.memberPermissions?.has(MANAGE_GUILD));
}

async function requireManageServer(
  interaction: ChatInputCommandInteraction,
): Promise<boolean> {
  if (isManageServer(interaction)) return true;
  await interaction.reply({
    content: "You need **Manage Server** permission to change the FG staff list.",
    ephemeral: true,
  });
  return false;
}

function getMemberTarget(
  interaction: ChatInputCommandInteraction,
  optionPrefix: "member" | "staff",
): { kind: "user" | "role"; id: string; label: string } | null {
  const userOption = optionPrefix === "member" ? "member" : "member";
  const user = interaction.options.getUser(userOption);
  const selectedRole = interaction.options.getRole("role");
  if (Boolean(user) === Boolean(selectedRole)) return null;
  if (user) return { kind: "user", id: user.id, label: `${user}` };

  const role = interaction.guild?.roles.cache.get(selectedRole!.id);
  if (!role || role.id === interaction.guildId) return null;
  return { kind: "role", id: role.id, label: `${role}` };
}

async function saveFgSettings(
  interaction: ChatInputCommandInteraction,
  store: ConfigStore,
  settings: GuildSettings,
  message: string,
): Promise<void> {
  try {
    await store.set(interaction.guildId!, settings);
    await interaction.reply({
      embeds: [wildEmbed("FG updated", message)],
      ephemeral: true,
      allowedMentions: { parse: [] },
    });
  } catch {
    await interaction.reply({
      content: "The bot couldn't save this FG change. Try again or check its settings storage.",
      ephemeral: true,
    });
  }
}

function formatAccessList(ids: string[], kind: "user" | "role"): string {
  if (ids.length === 0) return "None";
  const shown = ids.slice(0, 25).map((id) => kind === "user" ? `<@${id}>` : `<@&${id}>`);
  const remaining = ids.length - shown.length;
  if (remaining > 0) shown.push(`…and ${remaining} more`);
  return shown.join("\n");
}

async function handleStaffCommand(
  interaction: ChatInputCommandInteraction,
  store: ConfigStore,
  action: string,
): Promise<void> {
  if (!(await requireManageServer(interaction))) return;
  const settings = store.get(interaction.guildId!);

  if (action === "list") {
    await interaction.reply({
      embeds: [
        wildEmbed("FG staff", "Members and roles allowed to create and assign FG roles.")
          .addFields(
            {
              name: `Members (${settings.fgStaffUserIds.length})`,
              value: formatAccessList(settings.fgStaffUserIds, "user"),
              inline: true,
            },
            {
              name: `Roles (${settings.fgStaffRoleIds.length})`,
              value: formatAccessList(settings.fgStaffRoleIds, "role"),
              inline: true,
            },
          ),
      ],
      ephemeral: true,
      allowedMentions: { parse: [] },
    });
    return;
  }

  const target = getMemberTarget(interaction, "staff");
  if (!target) {
    await interaction.reply({
      content: "Choose exactly one member or role.",
      ephemeral: true,
    });
    return;
  }

  if (target.kind === "user" && action === "add") {
    const member = await interaction.guild!.members.fetch(target.id).catch(() => null);
    if (!member) {
      await interaction.reply({
        content: "That person must be a member of this server before becoming FG staff.",
        ephemeral: true,
      });
      return;
    }
  }

  const currentIds =
    target.kind === "user" ? settings.fgStaffUserIds : settings.fgStaffRoleIds;
  if (action === "add" && currentIds.includes(target.id)) {
    await interaction.reply({
      content: `${target.label} is already on the FG staff list.`,
      ephemeral: true,
      allowedMentions: { parse: [] },
    });
    return;
  }
  if (action === "remove" && !currentIds.includes(target.id)) {
    await interaction.reply({
      content: `${target.label} isn't on the FG staff list.`,
      ephemeral: true,
      allowedMentions: { parse: [] },
    });
    return;
  }

  await saveFgSettings(
    interaction,
    store,
    target.kind === "user"
      ? {
          ...settings,
          fgStaffUserIds:
            action === "add"
              ? [...settings.fgStaffUserIds, target.id]
              : settings.fgStaffUserIds.filter((id) => id !== target.id),
        }
      : {
          ...settings,
          fgStaffRoleIds:
            action === "add"
              ? [...settings.fgStaffRoleIds, target.id]
              : settings.fgStaffRoleIds.filter((id) => id !== target.id),
        },
    action === "add"
      ? `${target.label} can create and assign FG roles.`
      : `${target.label} can no longer manage FG roles.`,
  );
}

async function handleRoleCommand(
  interaction: ChatInputCommandInteraction,
  store: ConfigStore,
  action: string,
): Promise<void> {
  const guild = interaction.guild!;
  const settings = store.get(guild.id);

  if (action === "list") {
    const fgRoleIds = Object.keys(settings.fgRoles);
    const lines = fgRoleIds
      .slice(0, 50)
      .map((id, index) => `\`${index + 1}.\` ${guild.roles.cache.get(id) ?? `Deleted role \`${id}\``}`);
    if (fgRoleIds.length > lines.length) lines.push(`…and ${fgRoleIds.length - lines.length} more`);
    await interaction.reply({
      embeds: [wildEmbed("FG roles", lines.length ? lines.join("\n") : "No FG roles yet.")],
      ephemeral: true,
      allowedMentions: { parse: [] },
    });
    return;
  }

  const botMember = guild.members.me ?? (await guild.members.fetchMe().catch(() => null));
  if (!botMember?.permissions.has(PermissionFlagsBits.ManageRoles)) {
    await interaction.reply({
      content: "The bot needs **Manage Roles** to create or assign FG roles.",
      ephemeral: true,
    });
    return;
  }

  if (action === "create") {
    const staff = await guild.members.fetch(interaction.user.id).catch(() => null);
    if (!staff || !isFgStaff(staff, settings)) {
      await interaction.reply({
        content: "Only allowlisted FG staff can create FG roles.",
        ephemeral: true,
      });
      return;
    }

    const name = interaction.options.getString("name", true).trim();
    if (!name) {
      await interaction.reply({ content: "Enter a name for the FG role.", ephemeral: true });
      return;
    }

    try {
      const role = await guild.roles.create({
        name,
        permissions: [],
        mentionable: false,
        hoist: false,
        reason: `FG role created by ${interaction.user.id}`,
      });
      const nextSettings = store.get(guild.id);
      nextSettings.fgRoles[role.id] = emptyFgAccess();
      if (!nextSettings.protectedRoleIds.includes(role.id)) {
        nextSettings.protectedRoleIds.push(role.id);
      }
      try {
        await store.set(guild.id, nextSettings);
      } catch {
        await role.delete("FG role configuration could not be saved").catch(() => undefined);
        throw new Error("The bot couldn't save this FG role.");
      }
      await interaction.reply({
        embeds: [
          wildEmbed(
            "FG role created",
            `${role} is protected. Add per-role assignment and share access with \`/fg access add\`.`,
          ),
        ],
        ephemeral: true,
        allowedMentions: { parse: [] },
      });
    } catch (error) {
      if (interaction.replied) throw error;
      await interaction.reply({
        content: "The bot couldn't create that FG role. Check its permissions and try again.",
        ephemeral: true,
      });
    }
    return;
  }

  const selectedRole = interaction.options.getRole("role", true);
  const role = guild.roles.cache.get(selectedRole.id);
  const memberUser = interaction.options.getUser("member", true);
  if (!role || !settings.fgRoles[role.id]) {
    await interaction.reply({
      content: "Choose a role created and registered as an FG role.",
      ephemeral: true,
    });
    return;
  }

  const actor = await guild.members.fetch(interaction.user.id).catch(() => null);
  if (!actor || !canAssignFgRole(actor, role.id, settings)) {
    await interaction.reply({
      content: "You aren't allowlisted to assign this FG role.",
      ephemeral: true,
    });
    return;
  }

  if (botMember.roles.highest.comparePositionTo(role) <= 0) {
    await interaction.reply({
      content: "Move the bot's role above the FG role before assigning it.",
      ephemeral: true,
    });
    return;
  }

  const member = await guild.members.fetch(memberUser.id).catch(() => null);
  if (!member) {
    await interaction.reply({
      content: "That person must be a member of this server.",
      ephemeral: true,
    });
    return;
  }
  if (member.roles.cache.has(role.id)) {
    await interaction.reply({
      content: `${member} already has ${role}.`,
      ephemeral: true,
      allowedMentions: { parse: [] },
    });
    return;
  }

  await member.roles.add(role, `FG role assigned by ${interaction.user.id}`);
  await interaction.reply({
    embeds: [wildEmbed("FG role assigned", `${role} was assigned to ${member}.`)],
    ephemeral: true,
    allowedMentions: { parse: [] },
  });
}

async function handleAccessCommand(
  interaction: ChatInputCommandInteraction,
  store: ConfigStore,
  action: string,
): Promise<void> {
  const guild = interaction.guild!;
  const settings = store.get(guild.id);
  const actor = await guild.members.fetch(interaction.user.id).catch(() => null);
  if (!isManageServer(interaction) && (!actor || !isFgStaff(actor, settings))) {
    await interaction.reply({
      content: "Only Manage Server members or FG staff can change per-role access.",
      ephemeral: true,
    });
    return;
  }

  const selectedRole = interaction.options.getRole("fg-role", true);
  const role = guild.roles.cache.get(selectedRole.id);
  const currentAccess = role ? settings.fgRoles[role.id] : undefined;
  if (!role || !currentAccess) {
    await interaction.reply({
      content: "Choose a role created and registered as an FG role.",
      ephemeral: true,
    });
    return;
  }

  if (action === "list") {
    const access = wildEmbed(
      `Access · ${role.name}`,
      "Assignment and sharing access for this FG role.",
    ).addFields(
      {
        name: `Can assign (${currentAccess.assignUserIds.length + currentAccess.assignRoleIds.length})`,
        value: [
          `Members\n${formatAccessList(currentAccess.assignUserIds, "user")}`,
          `Roles\n${formatAccessList(currentAccess.assignRoleIds, "role")}`,
        ].join("\n\n"),
        inline: true,
      },
      {
        name: `Can share (${currentAccess.shareUserIds.length + currentAccess.shareRoleIds.length})`,
        value: [
          `Members\n${formatAccessList(currentAccess.shareUserIds, "user")}`,
          `Roles\n${formatAccessList(currentAccess.shareRoleIds, "role")}`,
        ].join("\n\n"),
        inline: true,
      },
    );
    await interaction.reply({
      embeds: [access],
      ephemeral: true,
      allowedMentions: { parse: [] },
    });
    return;
  }

  const target = getMemberTarget(interaction, "member");
  if (!target) {
    await interaction.reply({
      content: "Choose exactly one member or role.",
      ephemeral: true,
    });
    return;
  }
  if (target.kind === "user" && action === "add") {
    const member = await guild.members.fetch(target.id).catch(() => null);
    if (!member) {
      await interaction.reply({
        content: "That person must be a member of this server.",
        ephemeral: true,
      });
      return;
    }
  }

  const permission = interaction.options.getString("permission", true);
  const userList = permission === "assign" ? "assignUserIds" : "shareUserIds";
  const roleList = permission === "assign" ? "assignRoleIds" : "shareRoleIds";
  const targetList = target.kind === "user" ? currentAccess[userList] : currentAccess[roleList];
  const alreadyPresent = targetList.includes(target.id);
  if (action === "add" && alreadyPresent) {
    await interaction.reply({
      content: `${target.label} already has ${permission} access for ${role}.`,
      ephemeral: true,
      allowedMentions: { parse: [] },
    });
    return;
  }
  if (action === "remove" && !alreadyPresent) {
    await interaction.reply({
      content: `${target.label} doesn't have ${permission} access for ${role}.`,
      ephemeral: true,
      allowedMentions: { parse: [] },
    });
    return;
  }

  const nextAccess: FgRoleAccess = {
    ...currentAccess,
    [userList]:
      target.kind === "user"
        ? action === "add"
          ? [...currentAccess[userList], target.id]
          : currentAccess[userList].filter((id) => id !== target.id)
        : currentAccess[userList],
    [roleList]:
      target.kind === "role"
        ? action === "add"
          ? [...currentAccess[roleList], target.id]
          : currentAccess[roleList].filter((id) => id !== target.id)
        : currentAccess[roleList],
  };
  await saveFgSettings(
    interaction,
    store,
    { ...settings, fgRoles: { ...settings.fgRoles, [role.id]: nextAccess } },
    `${target.label} can ${action === "add" ? "now" : "no longer"} ${permission} ${role}.`,
  );
}

export async function handleFgCommand(
  interaction: ChatInputCommandInteraction,
  store: ConfigStore,
): Promise<void> {
  if (interaction.commandName !== "fg") return;
  if (!interaction.guild) {
    await interaction.reply({
      content: "FG commands are only available inside a server.",
      ephemeral: true,
    });
    return;
  }

  const group = interaction.options.getSubcommandGroup(false);
  const action = interaction.options.getSubcommand();
  if (group === "roles") {
    await handleRoleCommand(interaction, store, action);
  } else if (group === "staff") {
    await handleStaffCommand(interaction, store, action);
  } else if (group === "access") {
    await handleAccessCommand(interaction, store, action);
  } else {
    await interaction.reply({
      content: "That FG command isn't supported.",
      ephemeral: true,
    });
  }
}
