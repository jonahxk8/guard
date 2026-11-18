import {
  AuditLogEvent,
  EmbedBuilder,
  Guild,
  GuildAuditLogsEntry,
  PermissionFlagsBits,
  TextChannel,
} from "discord.js";
import { ConfigStore, GuildSettings } from "./config-store.js";
import { WILD_PURPLE } from "./embeds.js";

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
    .setColor(actionNeeded ? 0xed4245 : WILD_PURPLE)
    .setTitle("Unauthorized role assignment")
    .setDescription(`Wild removed watched role(s) from <@${memberId}>.`)
    .addFields(
      { name: "Role(s)", value: roleMentions, inline: false },
      { name: "Assigned by", value: actor, inline: true },
      {
        name: "Reason",
        value: actorId
          ? "The assigner is not on Wild's allowlist."
          : "Wild could not verify the assigner.",
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
  const watchedRoleIds = getAddedRoleIds(entry).filter((id) => protectedIds.has(id));
  if (watchedRoleIds.length === 0) return;

  handledAuditEntryIds.add(entry.id);
  if (handledAuditEntryIds.size > MAX_HANDLED_AUDIT_ENTRIES) {
    const oldestEntryId = handledAuditEntryIds.values().next().value;
    if (oldestEntryId) handledAuditEntryIds.delete(oldestEntryId);
  }

  const actorId = entry.executorId;
  if (actorId && settings.allowedUserIds.includes(actorId)) return;

  const member = await guild.members.fetch(entry.targetId).catch(() => null);
  if (!member) {
    await sendLog(
      guild,
      settings,
      createBlockedAssignmentEmbed(
        entry.targetId,
        watchedRoleIds,
        actorId,
        "Wild could not fetch the member to remove the role. Check its server permissions.",
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
        "Wild: role assigner is not allowlisted",
      );
    } catch {
      actionNeeded = "Wild could not remove the role. Check Manage Roles and role order.";
    }
  }
  if (removableRoleIds.length !== watchedRoleIds.length) {
    actionNeeded ??=
      "Wild cannot manage one or more watched roles. Check Manage Roles and role order.";
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
