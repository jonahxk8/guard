import {
  AuditLogEvent,
  EmbedBuilder,
  Guild,
  GuildAuditLogsEntry,
  GuildMember,
  PermissionFlagsBits,
  Role,
  TextChannel,
} from "discord.js";
import { ConfigStore, GuildSettings } from "./config-store.js";
import { BOT_BLACK } from "./embeds.js";
import { canAssignFgRole, memberMatchesWhitelist } from "./authorization.js";
import {
  REPEAT_OFFENDER_THRESHOLD,
  getOffenseCount,
  recordOffense,
} from "./offenders.js";

const handledAuditEntryIds = new Set<string>();
const MAX_HANDLED_AUDIT_ENTRIES = 500;

/** A role is dangerous to hand out if it carries the Administrator permission. */
export function isDangerousRole(role: Role): boolean {
  return role.permissions.has(PermissionFlagsBits.Administrator);
}

/**
 * Role IDs the bot cannot manage: it lacks Manage Roles, or its highest role
 * is not above the role. A role the bot cannot see in the cache counts as
 * unmanageable (fail closed). A bot member with no role hierarchy to inspect
 * also counts as unable to manage.
 */
export function getUnmanageableRoleIds(
  guild: Guild,
  botMember: GuildMember | null,
  roleIds: string[],
): string[] {
  if (!botMember) return [...roleIds];
  if (!botMember.permissions.has(PermissionFlagsBits.ManageRoles)) {
    return [...roleIds];
  }
  const highest = botMember.roles?.highest;
  if (!highest || typeof highest.comparePositionTo !== "function") {
    return [...roleIds];
  }
  return roleIds.filter((roleId) => {
    const role = guild.roles.cache.get(roleId);
    return !role || highest.comparePositionTo(role) <= 0;
  });
}

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

function auditLogCandidates(logs: unknown): GuildAuditLogsEntry[] {
  const entries = (logs as { entries?: unknown } | null)?.entries;
  if (Array.isArray(entries)) return entries as GuildAuditLogsEntry[];
  if (
    entries &&
    typeof (entries as { values?: unknown }).values === "function"
  ) {
    return [...(entries as Map<string, GuildAuditLogsEntry>).values()];
  }
  return [];
}

/**
 * Corroborate an audit-log entry against the guild's audit log.
 *
 * Fetches up to 10 recent MemberRoleUpdate entries and looks for one that
 * matches this entry by id, or by target + at least one added role + a
 * timestamp within 60 seconds. Returns the corroborating entry's executor,
 * or this entry's own executor when no corroboration is available (the
 * event itself is still the best evidence we have). Returns null only when
 * no executor is known anywhere — callers must treat that as unverified
 * and fail closed.
 *
 * Never throws, and tolerates guild objects without fetchAuditLogs (mocks
 * and partial guilds): in that case the event's executor is returned as-is.
 */
export async function verifyExecutor(
  entry: GuildAuditLogsEntry,
  guild: Guild,
): Promise<string | null> {
  const fallback = entry.executorId ?? null;
  const fetchAuditLogs = (
    guild as unknown as { fetchAuditLogs?: unknown }
  ).fetchAuditLogs;
  if (typeof fetchAuditLogs !== "function") return fallback;

  let logs: unknown;
  try {
    logs = await (
      fetchAuditLogs as (
        options: { type: AuditLogEvent; limit: number },
      ) => Promise<unknown>
    ).call(guild, { type: AuditLogEvent.MemberRoleUpdate, limit: 10 });
  } catch {
    return fallback;
  }

  const addedRoleIds = new Set(getAddedRoleIds(entry));
  for (const candidate of auditLogCandidates(logs)) {
    if (candidate.id === entry.id) {
      return candidate.executorId ?? null;
    }
    if (candidate.targetId !== entry.targetId) continue;
    const candidateAdded = getAddedRoleIds(candidate);
    if (!candidateAdded.some((roleId) => addedRoleIds.has(roleId))) continue;
    const entryTime = entry.createdTimestamp;
    const candidateTime = candidate.createdTimestamp;
    if (
      typeof entryTime === "number" &&
      typeof candidateTime === "number" &&
      Math.abs(candidateTime - entryTime) > 60_000
    ) {
      continue;
    }
    if (candidate.executorId) return candidate.executorId;
  }
  return fallback;
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
  // The server owner bypasses the guard: their own grants are never reverted.
  if (actorId === guild.ownerId) return true;

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
  offenseCount?: number,
): EmbedBuilder {
  const roleMentions = roleIds.map((roleId) => `<@&${roleId}>`).join(", ");
  const actor = actorId
    ? `<@${actorId}>`
    : "Unknown (audit log has no assigner)";

  const embed = new EmbedBuilder()
    .setColor(BOT_BLACK)
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
    );

  if (
    typeof offenseCount === "number" &&
    offenseCount >= REPEAT_OFFENDER_THRESHOLD
  ) {
    embed.addFields({
      name: "Repeat offender",
      value: "3+ unauthorised assignments",
      inline: false,
    });
  }

  if (actionNeeded) {
    embed.addFields({ name: "Action needed", value: actionNeeded, inline: false });
  }
  return embed;
}

async function notifyActor(
  guild: Guild,
  actorId: string,
  memberId: string,
  roleIds: string[],
): Promise<void> {
  const actor = await guild.members.fetch(actorId).catch(() => null);
  if (!actor || typeof actor.send !== "function") return;
  const roleMentions = roleIds.map((roleId) => `<@&${roleId}>`).join(", ");
  await actor
    .send(
      `Wild removed ${roleMentions} from <@${memberId}> in ${guild.name} because ` +
        `you aren't allowlisted to assign protected roles. ` +
        `Ask a server admin with Manage Server to allowlist you with ` +
        `/wild allow add.`,
    )
    .catch(() => undefined);
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

  // Corroborate the executor against the audit log. When no corroborating
  // entry is found and the executor is unknown, actorId stays null and the
  // grant is still removed below (fail closed).
  const actorId = await verifyExecutor(entry, guild);
  const watchedRoleIds: string[] = [];
  for (const roleId of addedRoleIds) {
    if (!(await isAllowedForRole(actorId, guild, settings, roleId))) {
      watchedRoleIds.push(roleId);
    }
  }
  if (watchedRoleIds.length === 0) return;

  // Record the offence and tell the assigner why, even when no log channel
  // is configured. The owner and the bot never reach this path (bypassed).
  let offenseCount = 0;
  if (actorId) {
    offenseCount = recordOffense(guild.id, actorId);
    await notifyActor(guild, actorId, entry.targetId, watchedRoleIds);
  }

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
        offenseCount,
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
      offenseCount,
    ),
  );
}

export { getOffenseCount };
