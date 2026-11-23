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
import { canAssignFgRole, fetchBotMemberFresh, fetchMemberFresh, isBotAdmin, isFgSharer, memberMatchesWhitelist } from "./authorization.js";
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

/**
 * Parse the human who asked another bot to assign a role, from the
 * audit entry's reason. Bleed passes a reason like "added role by
 * weak3" when it adds a role via the API, and Greed passes one like
 * "Role update by 1umk (763299524789141525)" — username, plus the
 * user ID in parentheses. Discord stores the reason on the audit
 * entry. The ID, when present, is authoritative: usernames can change
 * or be reused, IDs cannot. Tolerates surrounding text and case; a
 * trailing "#1234" discriminator or trailing punctuation is stripped
 * from the username. Returns null when the reason names no requester.
 */
export interface AuditReasonRequester {
  /** User ID when the reason carries one (Greed's parenthesised ID, or a bare ID). */
  id: string | null;
  /** Username when the reason carries one. */
  username: string | null;
  /** The exact matched portion of the reason, for the log entry. */
  matched: string;
}

function cleanReasonUsername(token: string): string {
  return token.replace(/#\d{4}$/, "").replace(/[.,;:!?]+$/, "");
}

export function parseAuditReasonRequester(
  reason: string | null | undefined,
): AuditReasonRequester | null {
  if (!reason) return null;
  // Greed first: "Role update by <name> (<id>)" — the ID in
  // parentheses is authoritative, the name is the fallback.
  const greed = /role update by\s+([^\s,;()]+)(?:\s*\(\s*(\d{17,19})\s*\))?/i.exec(
    reason,
  );
  if (greed) {
    const username = cleanReasonUsername(greed[1]);
    if (!username && !greed[2]) return null;
    return {
      id: greed[2] ?? null,
      username: username.length > 0 ? username : null,
      matched: greed[0],
    };
  }
  // Bleed: "added role by <token>" — a bare 17–19 digit token is a
  // user ID, anything else is a username.
  const bleed = /added role by\s+([^\s,;]+)/i.exec(reason);
  if (!bleed) return null;
  const token = bleed[1];
  if (/^\d{17,19}$/.test(token)) {
    return { id: token, username: null, matched: bleed[0] };
  }
  const username = cleanReasonUsername(token);
  if (!username) return null;
  return { id: null, username, matched: bleed[0] };
}

/**
 * Resolve a parsed audit-reason requester to a guild member. A user
 * ID in the reason wins: it is fetched directly, even when the
 * username in the same reason would resolve to someone else. Only
 * when the ID does not resolve does the username get tried: exact
 * match (case-insensitive) against the member cache, then a REST
 * member search. Exactly one exact username match is required —
 * zero or several matches means the username does not resolve.
 */
async function resolveReasonRequester(
  guild: Guild,
  parsed: AuditReasonRequester,
): Promise<GuildMember | null> {
  if (parsed.id) {
    const byId = await fetchMemberFresh(guild, parsed.id);
    if (byId) return byId;
    // The ID did not resolve — fall back to the username in the same
    // reason, if there is one.
  }
  if (!parsed.username) return null;
  const lower = parsed.username.toLowerCase();
  const cache = (
    guild.members as unknown as {
      cache?: {
        find?: (
          predicate: (member: GuildMember) => boolean,
        ) => GuildMember | undefined;
      };
    }
  ).cache;
  const cached = cache?.find?.(
    (member) => member.user?.username?.toLowerCase() === lower,
  );
  if (cached) return cached;
  const results = await guild.members
    .fetch({ query: parsed.username, limit: 10 })
    .catch(() => null);
  if (!results) return null;
  const exact = [...results.values()].filter(
    (member) => member.user?.username?.toLowerCase() === lower,
  );
  return exact.length === 1 ? exact[0] : null;
}

/**
 * Id-only authorisation: no member fetch. Covers Wild itself, the
 * server owner, whitelisted users, FG staff, FG owners and sharers.
 * Used for the fast path in guardAuditLogEntry (an id-authorised giver
 * costs no fetch) and by isAllowedForRole below.
 */
function isAllowedById(
  actorId: string | null,
  guild: Guild,
  settings: GuildSettings,
  roleId: string,
): boolean {
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
    return (
      settings.fgStaffUserIds.includes(actorId) ||
      fgAccess.assignUserIds.includes(actorId) ||
      settings.allowedUserIds.includes(actorId) ||
      settings.fgRoleOwners[roleId] === actorId ||
      (settings.fgRoleSharers[roleId] ?? []).includes(actorId)
    );
  }
  return settings.allowedUserIds.includes(actorId);
}

async function isAllowedForRole(
  actorId: string | null,
  guild: Guild,
  settings: GuildSettings,
  roleId: string,
): Promise<boolean> {
  if (isAllowedById(actorId, guild, settings, roleId)) return true;
  if (!actorId) return false;

  // Only now fetch the member — FRESH from the API, never the cache:
  // a plain fetch returns the cached member, whose Administrator bit
  // and roles are frozen from when the member was first cached (the bot
  // has no GuildMembers intent, so nothing ever refreshes the cache).
  // A giver who lost Administrator must not keep passing this check.
  const actor = await fetchMemberFresh(guild, actorId);
  if (actor && isBotAdmin(actor, guild.ownerId)) return true;

  if (!actor) return false;
  const fgAccess = settings.fgRoles[roleId];
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
  // How a bot executor's grant was attributed to a human (audit reason
  // or FG role owner). Human executors get the normal entry, no field.
  attributionNote?: string | null,
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
  if (attributionNote) {
    fields.push({ name: "Attribution", value: attributionNote });
  }
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

  // Fast path, no fetch: the executor is authorised by id for every
  // added role (server owner, Wild itself, whitelisted user, FG owner
  // or sharer). An id-authorised giver costs no member fetch — and no
  // bot attribution either, since the grant stands whoever asked for it.
  const executorAllowedById =
    actorId !== null &&
    addedRoleIds.every((roleId) =>
      isAllowedById(actorId, guild, settings, roleId),
    );

  // When the executor is NOT authorised by id, work out whether it is
  // another bot (Bleed, Greed, or any bot — not Wild itself). The audit
  // log names the bot, never the human who asked it to assign the
  // role — but the bot passes a reason naming that human: Bleed writes
  // "added role by weak3", Greed writes "Role update by 1umk
  // (763299524789141525)". Only a fetch can tell a bot executor from
  // a human one (the member cache is stale by design — no GuildMembers
  // intent), so this costs one force-fetch for non-id-authorised
  // executors.
  let executorIsOtherBot = false;
  let reasonActorId: string | null = null;
  let reasonAttributionNote: string | null = null;
  if (!executorAllowedById && actorId && actorId !== guild.client?.user?.id) {
    const executorMember = await fetchMemberFresh(guild, actorId);
    executorIsOtherBot = Boolean(executorMember?.user?.bot);
    if (executorIsOtherBot) {
      const parsed = parseAuditReasonRequester(entry.reason);
      if (parsed) {
        const requester = await resolveReasonRequester(guild, parsed);
        if (requester) {
          reasonActorId = requester.id;
          reasonAttributionNote = `Audit reason: ${parsed.matched}`;
        }
      }
    }
  }

  // Effective actor per role: the executor, or for a bot executor the
  // human from the audit reason, or (FG roles only) the FG role's
  // owner — in Bleed only the owner of a booster role can share it.
  // null = no human to attribute the grant to.
  const effectiveActorByRole = new Map<string, string | null>();
  for (const roleId of addedRoleIds) {
    if (!executorIsOtherBot) {
      effectiveActorByRole.set(roleId, actorId);
      continue;
    }
    if (reasonActorId) {
      effectiveActorByRole.set(roleId, reasonActorId);
      continue;
    }
    const ownerId = settings.fgRoles[roleId]
      ? settings.fgRoleOwners[roleId]
      : undefined;
    effectiveActorByRole.set(roleId, ownerId ?? null);
  }

  // Roles grouped by the human they are attributed to (null = no
  // human: a bot grant with no requester in the reason and no FG owner
  // to fall back to). Only attributed humans are DM'd or counted as
  // offenders; unattributed roles are removed and logged only.
  const groupRolesByActor = (
    roleIds: string[],
  ): Map<string | null, string[]> => {
    const groups = new Map<string | null, string[]>();
    for (const roleId of roleIds) {
      const attributed = effectiveActorByRole.get(roleId) ?? null;
      const list = groups.get(attributed) ?? [];
      list.push(roleId);
      groups.set(attributed, list);
    }
    return groups;
  };

  // The log names the single attributed human when there is exactly
  // one; otherwise it names the executor (e.g. Bleed) when known, so
  // the entry still says who performed the grant.
  const logActorId = (roleIds: string[]): string | null => {
    const actors = [
      ...new Set(
        roleIds.map((roleId) => effectiveActorByRole.get(roleId) ?? null),
      ),
    ];
    if (actors.length === 1 && actors[0]) return actors[0];
    return actorId;
  };

  // Which attribution path was taken, for the log entry (bot executors
  // only; human executors get the normal entry, no field).
  const attributionNote = (): string | null => {
    if (!executorIsOtherBot) return null;
    if (reasonActorId) return reasonAttributionNote;
    if ([...effectiveActorByRole.values()].some((id) => id)) {
      return "Attributed to the FG role owner (no requester in the audit reason)";
    }
    return "No requester found in the audit reason";
  };

  // Blacklist check, on the same flow as the unauthorised-giver check:
  // a protected role granted to a user blacklisted from THAT role is
  // removed even when the giver was authorised — the blacklist blocks the
  // target, not the giver. The exemption is per role: the effective
  // actor (the executor, or the human attributed to a bot executor's
  // grant) being the server owner or an Administrator bypasses it. The
  // actor is only fetched when the target is actually blacklisted, so
  // an id-whitelisted giver costs no member fetch.
  const targetIsBlacklisted = addedRoleIds.some((roleId) =>
    isBlacklisted(settings, targetId, roleId),
  );
  const exemptByRole = new Map<string, boolean>();
  if (targetIsBlacklisted) {
    for (const roleId of addedRoleIds) {
      const effective = effectiveActorByRole.get(roleId);
      let exempt = effective === guild.ownerId;
      if (!exempt && effective) {
        const member = await fetchMemberFresh(guild, effective);
        exempt = isBotAdmin(member, guild.ownerId);
      }
      exemptByRole.set(roleId, exempt);
    }
  }
  const blacklistedRoleIds = addedRoleIds.filter(
    (roleId) => !exemptByRole.get(roleId) && isBlacklisted(settings, targetId, roleId),
  );

  let watchedRoleIds: string[] = [];
  for (const roleId of addedRoleIds) {
    if (
      !(await isAllowedForRole(
        effectiveActorByRole.get(roleId) ?? null,
        guild,
        settings,
        roleId,
      ))
    ) {
      watchedRoleIds.push(roleId);
    }
  }
  if (watchedRoleIds.length === 0 && blacklistedRoleIds.length === 0) return;

  // Fetch the target fresh: the still-holds check below needs current
  // roles, and a cached member could claim roles it no longer has.
  const member = await fetchMemberFresh(guild, targetId);
  if (!member) {
    const unionRoleIds = [...new Set([...watchedRoleIds, ...blacklistedRoleIds])];
    let offenseCount = 0;
    for (const [attributed] of groupRolesByActor(watchedRoleIds)) {
      if (!attributed) continue;
      offenseCount = Math.max(
        offenseCount,
        recordOffense(guild.id, attributed),
      );
    }
    const actionNeeded =
      "Bot could not fetch the member to remove the role. Check its server permissions.";
    await sendLog(
      guild,
      settings,
      createBlockedAssignmentEmbed(
        targetId,
        unionRoleIds,
        logActorId(unionRoleIds),
        actionNeeded,
        offenseCount,
        blacklistedRoleIds.length > 0
          ? watchedRoleIds.length > 0
            ? "also"
            : "only"
          : undefined,
        attributionNote(),
      ),
    );
    for (const [attributed, roles] of groupRolesByActor(unionRoleIds)) {
      if (!attributed) continue;
      await notifyRemovalFailed(
        guild,
        attributed,
        targetId,
        roles,
        actionNeeded,
      );
    }
    return;
  }

  // Idempotency: only act on roles the target still holds right now.
  // This makes re-processing an entry safe (e.g. the startup sweep
  // re-seeing an entry the bot already handled before a restart): a
  // role that is already gone produces no DM, no log, and no offence.
  const held = (roleId: string) => member.roles.cache.has(roleId);
  watchedRoleIds = watchedRoleIds.filter(held);
  const heldBlacklistedRoleIds = blacklistedRoleIds.filter(held);
  // Exactly one removal path: the union of both checks.
  const removalRoleIds = [...new Set([...watchedRoleIds, ...heldBlacklistedRoleIds])];
  if (removalRoleIds.length === 0) return;
  const blacklistNote: "only" | "also" | undefined =
    heldBlacklistedRoleIds.length > 0
      ? watchedRoleIds.length > 0
        ? "also"
        : "only"
      : undefined;

  // Record the offence first, once per attributed human. The owner,
  // Administrators, and the bot never reach this path (bypassed).
  // A blacklist-only removal is not an offence by the giver — they were
  // allowed to assign roles — so no offence is recorded for it.
  // The giver is told why only AFTER the removal is attempted, so the
  // DM never claims a removal that did not happen: success gets the
  // "Role removed" DM, failure gets a "could not be removed" DM.
  // Each attributed human is DM'd about their own roles only; a grant
  // with no human to attribute it to is never DM'd.
  let offenseCount = 0;
  for (const [attributed] of groupRolesByActor(watchedRoleIds)) {
    if (!attributed) continue;
    offenseCount = Math.max(
      offenseCount,
      recordOffense(guild.id, attributed),
    );
  }

  const botMember = await fetchBotMemberFresh(guild);
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

  for (const [dmActor, dmRoles] of groupRolesByActor(removalRoleIds)) {
    if (!dmActor) continue;
    const dmWatched = dmRoles.filter((roleId) =>
      watchedRoleIds.includes(roleId),
    );
    const dmBlacklisted = dmRoles.filter((roleId) =>
      heldBlacklistedRoleIds.includes(roleId),
    );
    if (actionNeeded) {
      await notifyRemovalFailed(
        guild,
        dmActor,
        targetId,
        dmRoles,
        actionNeeded,
      );
    } else if (dmWatched.length > 0) {
      await notifyActor(guild, dmActor, targetId, dmWatched);
    } else {
      await notifyBlacklistedActor(
        guild,
        dmActor,
        targetId,
        dmBlacklisted,
      );
    }
  }

  await sendLog(
    guild,
    settings,
    createBlockedAssignmentEmbed(
      member.id,
      removalRoleIds,
      logActorId(removalRoleIds),
      actionNeeded,
      offenseCount,
      blacklistNote,
      attributionNote(),
    ),
  );
}

/**
 * Re-check recent role grants after the bot (re)starts.
 *
 * `GuildAuditLogEntryCreate` only fires while the bot is online, so a
 * grant made while the bot is down — e.g. during a Railway redeploy —
 * is never seen live. On startup, sweep the last 10 minutes of
 * MemberRoleUpdate audit entries through the normal guard path. The
 * still-holds check inside `guardAuditLogEntry` makes this safe to
 * re-run: an entry already handled before the restart is skipped
 * because the target no longer holds the role. Never throws.
 */
const SWEEP_WINDOW_MS = 10 * 60 * 1000;

export async function sweepMissedGrants(
  guild: Guild,
  store: ConfigStore,
  now: number = Date.now(),
): Promise<void> {
  const fetchAuditLogs = (
    guild as unknown as { fetchAuditLogs?: unknown }
  ).fetchAuditLogs;
  if (typeof fetchAuditLogs !== "function") return;

  let logs: unknown;
  try {
    logs = await (
      fetchAuditLogs as (
        options: { type: AuditLogEvent; limit: number },
      ) => Promise<unknown>
    ).call(guild, { type: AuditLogEvent.MemberRoleUpdate, limit: 10 });
  } catch {
    return;
  }

  for (const entry of auditLogCandidates(logs)) {
    if (
      typeof entry.createdTimestamp === "number" &&
      now - entry.createdTimestamp > SWEEP_WINDOW_MS
    ) {
      continue;
    }
    await guardAuditLogEntry(entry, guild, store).catch(() => undefined);
  }
}

export { getOffenseCount };
