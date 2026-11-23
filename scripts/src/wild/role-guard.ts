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
import { ConfigStore, GuildSettings, isBlacklisted } from "./config-store.js";
import {
  memberDisplayName,
  roleDisplayName,
} from "./names.js";
import { wildFieldEmbed } from "./embeds.js";
import { canAssignFgRole, isBotAdmin, isFgSharer, memberMatchesWhitelist } from "./authorization.js";
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
  // The server owner — and anyone with Administrator — bypasses the
  // guard: their grants are never reverted. Only a VERIFIED giver is
  // trusted; an unverified actor never reaches this check (fail closed).
  if (actorId === guild.ownerId) return true;

  const fgAccess = settings.fgRoles[roleId];
  if (fgAccess) {
    // FG roles: whitelisted staff, the FG role's owner, and authorised
    // sharers may all grant the role — by id, before any member fetch.
    // Manage Roles alone authorises nothing: it is never checked here.
    if (
      settings.fgStaffUserIds.includes(actorId) ||
      fgAccess.assignUserIds.includes(actorId) ||
      settings.allowedUserIds.includes(actorId) ||
      settings.fgRoleOwners[roleId] === actorId ||
      (settings.fgRoleSharers[roleId] ?? []).includes(actorId)
    ) {
      return true;
    }
  } else if (settings.allowedUserIds.includes(actorId)) {
    return true;
  }

  // Only now fetch the member: an id-whitelisted giver costs no fetch,
  // and a verified Administrator counts as owner.
  const actor = await guild.members.fetch(actorId).catch(() => null);
  if (actor && isBotAdmin(actor, guild.ownerId)) return true;

  if (!actor) return false;
  if (fgAccess) {
    // Role-based whitelist, FG staff, assign lists, owner, sharers.
    return (
      isFgSharer(actor, roleId, settings) ||
      canAssignFgRole(actor, roleId, settings)
    );
  }
  return memberMatchesWhitelist(actor, [], settings.allowedRoleIds);
}

function createBlockedAssignmentEmbed(
  memberId: string,
  roleIds: string[],
  actorId: string | null,
  actionNeeded: string | null,
  offenseCount?: number,
  // "only": the removal is purely a blacklist hit (giver was authorised).
  // "also": the giver was unauthorised AND the member is blacklisted.
  blacklistNote?: "only" | "also",
): EmbedBuilder {
  const roleMentions = roleIds.map((roleId) => `<@&${roleId}>`).join(", ");
  const actor = actorId
    ? `<@${actorId}>`
    : "Unknown (audit log has no assigner)";

  let reason: string;
  if (blacklistNote === "only") {
    reason = "The member is blacklisted from this role.";
  } else if (blacklistNote === "also") {
    reason = actorId
      ? "The assigner is not on the whitelist. The member is also blacklisted from this role."
      : "Bot could not verify the assigner. The member is also blacklisted from this role.";
  } else {
    reason = actorId
      ? "The assigner is not on the whitelist."
      : "Bot could not verify the assigner.";
  }

  const fields: { name: string; value: string; inline?: boolean }[] = [
    { name: "Role(s)", value: roleMentions },
    { name: "Assigned by", value: actor, inline: true },
    { name: "Reason", value: reason, inline: true },
  ];
  if (
    typeof offenseCount === "number" &&
    offenseCount >= REPEAT_OFFENDER_THRESHOLD
  ) {
    fields.push({
      name: "Repeat offender",
      value: "3+ unauthorised assignments",
    });
  }
  if (actionNeeded) {
    fields.push({ name: "Action needed", value: actionNeeded });
  }
  return wildFieldEmbed(
    blacklistNote === "only"
      ? "Blacklisted role assignment"
      : "Unauthorized role assignment",
    fields,
    `Bot removed watched role(s) from <@${memberId}>.`,
  );
}

async function notifyActor(
  guild: Guild,
  actorId: string,
  memberId: string,
  roleIds: string[],
): Promise<void> {
  const actor = await guild.members.fetch(actorId).catch(() => null);
  if (!actor || typeof actor.send !== "function") return;
  const target = await guild.members.fetch(memberId).catch(() => null);
  const roleNames = roleIds
    .map((roleId) =>
      roleDisplayName(
        guild.roles.cache.get(roleId) as { id: string; name?: string | null } | undefined,
      ),
    )
    .join(", ");
  const embed = wildFieldEmbed("Role removed", [
    { name: "Role", value: roleNames },
    { name: "Member", value: memberDisplayName(target, null) },
    { name: "Server", value: guild.name },
    {
      name: "Reason",
      value: "You aren't whitelisted to assign protected roles.",
    },
  ]);
  await actor
    .send({ embeds: [embed], allowedMentions: { parse: [] } })
    .catch(() => undefined);
}

/**
 * Tell a giver the bot could NOT remove the role(s) — e.g. its own role
 * sits below the watched role, or it lost Manage Roles. Sent instead of
 * the "Role removed" DM, never as well as it, so the giver is never
 * told a removal happened when it did not.
 */
async function notifyRemovalFailed(
  guild: Guild,
  actorId: string,
  memberId: string,
  roleIds: string[],
  actionNeeded: string,
): Promise<void> {
  const actor = await guild.members.fetch(actorId).catch(() => null);
  if (!actor || typeof actor.send !== "function") return;
  const target = await guild.members.fetch(memberId).catch(() => null);
  const roleNames = roleIds
    .map((roleId) =>
      roleDisplayName(
        guild.roles.cache.get(roleId) as { id: string; name?: string | null } | undefined,
      ),
    )
    .join(", ");
  const embed = wildFieldEmbed("Role could not be removed", [
    { name: "Role", value: roleNames },
    { name: "Member", value: memberDisplayName(target, null) },
    { name: "Server", value: guild.name },
    {
      name: "Reason",
      value: "The bot couldn't remove the role.",
    },
    { name: "Action needed", value: actionNeeded },
  ]);
  await actor
    .send({ embeds: [embed], allowedMentions: { parse: [] } })
    .catch(() => undefined);
}

/**
 * Tell an authorised giver that the grant was removed anyway because the
 * target is blacklisted from that role. The blacklist blocks the target,
 * not the giver — so this fires even for whitelisted / FG staff givers.
 */
async function notifyBlacklistedActor(
  guild: Guild,
  actorId: string,
  memberId: string,
  roleIds: string[],
): Promise<void> {
  const actor = await guild.members.fetch(actorId).catch(() => null);
  if (!actor || typeof actor.send !== "function") return;
  const target = await guild.members.fetch(memberId).catch(() => null);
  const roleNames = roleIds
    .map((roleId) =>
      roleDisplayName(
        guild.roles.cache.get(roleId) as { id: string; name?: string | null } | undefined,
      ),
    )
    .join(", ");
  const embed = wildFieldEmbed("Role removed", [
    { name: "Role", value: roleNames },
    { name: "Member", value: memberDisplayName(target, null) },
    { name: "Server", value: guild.name },
    {
      name: "Reason",
      value: "The member is blacklisted from this role.",
    },
  ]);
  await actor
    .send({ embeds: [embed], allowedMentions: { parse: [] } })
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
  // Watched roles are protected roles AND every FG role. FG roles are
  // guarded even when they are not in protectedRoleIds — an FG role can
  // sit outside that list when it was made before auto-protect existed,
  // restored from an old config, or unprotected with /protect (which
  // toggles). The guard must never silently ignore an FG role.
  const watchedIds = new Set([
    ...settings.protectedRoleIds,
    ...Object.keys(settings.fgRoles),
  ]);
  if (watchedIds.size === 0) return;

  // Captured here: narrowing on entry.targetId does not survive awaits.
  const targetId = entry.targetId;

  // Note: enforcementEnabled is still parsed from old configs, but there is
  // no pause command anymore, so the guard always enforces. A legacy paused
  // config must not silently turn the guard off with no way to turn it on.

  const addedRoleIds = getAddedRoleIds(entry).filter((id) => watchedIds.has(id));
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

  // Blacklist check, on the same flow as the unauthorised-giver check:
  // a protected role granted to a user blacklisted from THAT role is
  // removed even when the giver was authorised — the blacklist blocks the
  // target, not the giver. Only the server owner and Administrators
  // bypass it. The actor is only fetched when the target is actually
  // blacklisted, so an id-whitelisted giver costs no member fetch.
  const targetIsBlacklisted = addedRoleIds.some((roleId) =>
    isBlacklisted(settings, targetId, roleId),
  );
  let actorIsExempt = actorId === guild.ownerId;
  if (targetIsBlacklisted && actorId && !actorIsExempt) {
    const actorMember = await guild.members.fetch(actorId).catch(() => null);
    actorIsExempt = isBotAdmin(actorMember, guild.ownerId);
  }
  const blacklistedRoleIds = addedRoleIds.filter(
    (roleId) => !actorIsExempt && isBlacklisted(settings, targetId, roleId),
  );

  const watchedRoleIds: string[] = [];
  for (const roleId of addedRoleIds) {
    if (!(await isAllowedForRole(actorId, guild, settings, roleId))) {
      watchedRoleIds.push(roleId);
    }
  }
  // Exactly one removal path: the union of both checks.
  const removalRoleIds = [...new Set([...watchedRoleIds, ...blacklistedRoleIds])];
  if (removalRoleIds.length === 0) return;
  const blacklistNote: "only" | "also" | undefined =
    blacklistedRoleIds.length > 0
      ? watchedRoleIds.length > 0
        ? "also"
        : "only"
      : undefined;

  // Record the offence first. The owner, Administrators, and the bot
  // never reach this path (bypassed).
  // A blacklist-only removal is not an offence by the giver — they were
  // allowed to assign roles — so no offence is recorded for it.
  // The giver is told why only AFTER the removal is attempted, so the
  // DM never claims a removal that did not happen: success gets the
  // "Role removed" DM, failure gets a "could not be removed" DM.
  let offenseCount = 0;
  if (actorId && watchedRoleIds.length > 0) {
    offenseCount = recordOffense(guild.id, actorId);
  }

  const member = await guild.members.fetch(targetId).catch(() => null);
  if (!member) {
    const actionNeeded =
      "Bot could not fetch the member to remove the role. Check its server permissions.";
    await sendLog(
      guild,
      settings,
      createBlockedAssignmentEmbed(
        targetId,
        removalRoleIds,
        actorId,
        actionNeeded,
        offenseCount,
        blacklistNote,
      ),
    );
    if (actorId) {
      await notifyRemovalFailed(
        guild,
        actorId,
        targetId,
        removalRoleIds,
        actionNeeded,
      );
    }
    return;
  }

  const botMember =
    guild.members.me ?? (await guild.members.fetchMe().catch(() => null));
  const removableRoleIds = removalRoleIds.filter((roleId) => {
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
        blacklistNote === "only"
          ? "Bot: member is blacklisted from this role"
          : "Bot: role assigner is not whitelisted",
      );
    } catch {
      actionNeeded = "Bot could not remove the role. Check Manage Roles and role order.";
    }
  }
  if (removableRoleIds.length !== removalRoleIds.length) {
    actionNeeded ??=
      "Bot cannot manage one or more watched roles. Check Manage Roles and role order.";
  }

  if (actorId) {
    if (actionNeeded) {
      await notifyRemovalFailed(
        guild,
        actorId,
        targetId,
        removalRoleIds,
        actionNeeded,
      );
    } else if (watchedRoleIds.length > 0) {
      await notifyActor(guild, actorId, targetId, watchedRoleIds);
    } else {
      await notifyBlacklistedActor(
        guild,
        actorId,
        targetId,
        blacklistedRoleIds,
      );
    }
  }

  await sendLog(
    guild,
    settings,
    createBlockedAssignmentEmbed(
      member.id,
      removalRoleIds,
      actorId,
      actionNeeded,
      offenseCount,
      blacklistNote,
    ),
  );
}

export { getOffenseCount };
