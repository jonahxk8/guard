import {
  AuditLogEvent,
  EmbedBuilder,
  Guild,
  GuildAuditLogsEntry,
  PermissionFlagsBits,
  TextChannel,
} from "discord.js";
import { ConfigStore, GuildSettings } from "./config-store.js";
import { BOT_WHITE } from "./embeds.js";
import { canAssignFgRole, memberMatchesWhitelist } from "./authorization.js";

const handledAuditEntryIds = new Set<string>();
const MAX_HANDLED_AUDIT_ENTRIES = 500;

function getAddedRoleIds(entry: GuildAuditLogsEntry): string[] {
  const roleIds = new Set<string>();
  for (const change of entry.changes) {
    if (change.key !== "$add" || !Array.isArray(change.new)) continue;
    for (const value of change.new) {
      if (
        typeof value === "object" &&
        value !== null &&
        "id" in value &&
        typeof value.id === "string"
      ) {
        roleIds.add(value.id);
      }
    }
  }
  return [...roleIds];
}

async function sendLog(
  guild: Guild,
  settings: GuildSettings,
  embed: EmbedBuilder,
): Promise<void> {
  if (!settings.logChannelId) return;
  const channel = await guild.channels.fetch(settings.logChannelId).catch(() => null);
  if (!channel?.isTextBased() || !("send" in channel)) return;

  await (channel as TextChannel)
    .send({ embeds: [embed], allowedMentions: { parse: [] } })
    .catch(() => undefined);
}

async function isAllowedForRole(
  actorId: string | null,
  guild: Guild,
  settings: GuildSettings,
  roleId: string,
): Promise<boolean> {
  if (!actorId) return false;
  if (actorId === guild.client?.user?.id) return true;

  const fgAccess = settings.fgRoles[roleId];
  if (fgAccess) {
    if (
      settings.fgStaffUserIds.includes(actorId) ||
      fgAccess.assignUserIds.includes(actorId)
    ) {
      return true;
    }
  } else if (settings.allowedUserIds.includes(actorId)) {
    return true;
  }

  const relevantRoleIds = fgAccess
    ? [...settings.fgStaffRoleIds, ...fgAccess.assignRoleIds]
    : settings.allowedRoleIds;
  if (relevantRoleIds.length === 0) return false;
  const actor = await guild.members.fetch(actorId).catch(() => null);
  if (!actor) return false;

  return fgAccess
    ? canAssignFgRole(actor, roleId, settings)
    : memberMatchesWhitelist(actor, [], settings.allowedRoleIds);
}

function createBlockedAssignmentEmbed(
  memberId: string,
  roleIds: string[],
  actorId: string | null,
  actionNeeded: string | null,
): EmbedBuilder {
  const roleMentions = roleIds.map((roleId) => `<@&${roleId}>`).join(", ");
  const actor = actorId
    ? `<@${actorId}>`
    : "Unknown (audit log has no assigner)";

  const embed = new EmbedBuilder()
    .setColor(BOT_WHITE)
    .setTitle("Unauthorized role assignment")
    .setDescription(`Bot removed watched role(s) from <@${memberId}>.`)
    .addFields(
      { name: "Role(s)", value: roleMentions, inline: false },
      { name: "Assigned by", value: actor, inline: true },
      {
        name: "Reason",
        value: actorId
          ? "The assigner is not on the allowlist."
          : "Bot could not verify the assigner.",
        inline: true,
      },
    )
    .setTimestamp();

  if (actionNeeded) {
    embed.addFields({ name: "Action needed", value: actionNeeded, inline: false });
  }
  return embed;
}

export async function guardAuditLogEntry(
  entry: GuildAuditLogsEntry,
  guild: Guild,
  store: ConfigStore,
): Promise<void> {
  if (
    entry.action !== AuditLogEvent.MemberRoleUpdate ||
    !entry.targetId ||
    handledAuditEntryIds.has(entry.id)
  ) {
    return;
  }

  const settings = store.get(guild.id);
  if (!settings.enforcementEnabled) return;
  if (settings.protectedRoleIds.length === 0) return;

  const protectedIds = new Set(settings.protectedRoleIds);
  const addedRoleIds = getAddedRoleIds(entry).filter((id) => protectedIds.has(id));
  if (addedRoleIds.length === 0) return;

  handledAuditEntryIds.add(entry.id);
  if (handledAuditEntryIds.size > MAX_HANDLED_AUDIT_ENTRIES) {
    const oldestEntryId = handledAuditEntryIds.values().next().value;
    if (oldestEntryId) handledAuditEntryIds.delete(oldestEntryId);
  }

  const actorId = entry.executorId;
  const watchedRoleIds: string[] = [];
  for (const roleId of addedRoleIds) {
    if (!(await isAllowedForRole(actorId, guild, settings, roleId))) {
      watchedRoleIds.push(roleId);
    }
  }
  if (watchedRoleIds.length === 0) return;

  const member = await guild.members.fetch(entry.targetId).catch(() => null);
  if (!member) {
    await sendLog(
      guild,
      settings,
      createBlockedAssignmentEmbed(
        entry.targetId,
        watchedRoleIds,
        actorId,
        "Bot could not fetch the member to remove the role. Check its server permissions.",
      ),
    );
    return;
  }

  const botMember =
    guild.members.me ?? (await guild.members.fetchMe().catch(() => null));
  const removableRoleIds = watchedRoleIds.filter((roleId) => {
    const role = guild.roles.cache.get(roleId);
    return Boolean(
      role &&
        botMember?.permissions.has(PermissionFlagsBits.ManageRoles) &&
        botMember.roles.highest.comparePositionTo(role) > 0,
    );
  });

  let actionNeeded: string | null = null;
  if (removableRoleIds.length > 0) {
    try {
      await member.roles.remove(
        removableRoleIds,
        "Bot: role assigner is not allowlisted",
      );
    } catch {
      actionNeeded = "Bot could not remove the role. Check Manage Roles and role order.";
    }
  }
  if (removableRoleIds.length !== watchedRoleIds.length) {
    actionNeeded ??=
      "Bot cannot manage one or more watched roles. Check Manage Roles and role order.";
  }

  await sendLog(
    guild,
    settings,
    createBlockedAssignmentEmbed(
      member.id,
      watchedRoleIds,
      actorId,
      actionNeeded,
    ),
  );
}
