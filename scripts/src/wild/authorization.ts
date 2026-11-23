import { Guild, GuildMember, PermissionFlagsBits } from "discord.js";
import { FgRoleAccess, GuildSettings } from "./config-store.js";

/**
 * Fetch a guild member fresh from the Discord API, bypassing the cache.
 *
 * This matters: `guild.members.fetch(id)` without `force: true` returns
 * the cached member when one exists (discord.js `GuildMemberManager`
 * `_fetchSingle` returns the cache entry with no API call), and the bot
 * does NOT subscribe to the GuildMembers intent, so it never receives
 * `GuildMemberUpdate` events — a cached member's roles and permissions
 * are frozen from the moment the member was first cached until the bot
 * restarts. A member who HAD Administrator when cached still looks like
 * an Administrator after it is removed, and the guard would let their
 * grants stand. Every authorisation decision must use this helper, never
 * a plain fetch and never a cached member. Returns null when the member
 * cannot be fetched: callers treat that as "not authorised" (fail closed).
 */
export async function fetchMemberFresh(
  guild: Guild,
  userId: string,
): Promise<GuildMember | null> {
  try {
    const member = await guild.members.fetch({ user: userId, force: true });
    return (member as GuildMember | null) ?? null;
  } catch {
    return null;
  }
}

/**
 * Fetch the bot's own member fresh from the API. Same staleness problem
 * as `fetchMemberFresh`: `guild.members.me` is cached. On API failure,
 * fall back to the cached member — this only feeds hierarchy checks
 * (can the bot manage a role), never an authorisation decision about
 * another member.
 */
export async function fetchBotMemberFresh(
  guild: Guild,
): Promise<GuildMember | null> {
  try {
    const member = await guild.members.fetchMe({ force: true });
    return (member as GuildMember | null) ?? guild.members.me ?? null;
  } catch {
    return guild.members.me ?? null;
  }
}

export function memberMatchesWhitelist(
  member: GuildMember,
  userIds: string[],
  roleIds: string[],
): boolean {
  return (
    userIds.includes(member.id) ||
    member.roles.cache.some((role) => roleIds.includes(role.id))
  );
}

export function isFgStaff(member: GuildMember, settings: GuildSettings): boolean {
  return memberMatchesWhitelist(
    member,
    settings.fgStaffUserIds,
    settings.fgStaffRoleIds,
  );
}

/**
 * Server owner OR anyone with the Discord Administrator permission.
 * Administrators can use the bot fully, exactly like the server owner.
 * Tolerant of partial/mock members: no permissions object means "not
 * an admin" unless the id is the owner's.
 */
export function isBotAdmin(
  member: GuildMember | null | undefined,
  ownerId: string | null | undefined,
): boolean {
  if (!member) return false;
  if (ownerId && member.id === ownerId) return true;
  try {
    return Boolean(member.permissions?.has(PermissionFlagsBits.Administrator));
  } catch {
    return false;
  }
}

/**
 * Same rule, for interaction handlers that only have the caller's
 * member permissions (no fetched member): server owner, or the
 * Administrator permission bit.
 */
export function isBotAdminPermissions(
  permissions: { has: (permission: bigint) => boolean } | null | undefined,
  userId: string,
  ownerId: string | null | undefined,
): boolean {
  if (ownerId && userId === ownerId) return true;
  try {
    return Boolean(permissions?.has(PermissionFlagsBits.Administrator));
  } catch {
    return false;
  }
}

/** Whitelisted directly, or via a whitelisted role, or legacy FG staff. */
export function isWhitelisted(member: GuildMember, settings: GuildSettings): boolean {
  return (
    memberMatchesWhitelist(
      member,
      settings.allowedUserIds,
      settings.allowedRoleIds,
    ) || isFgStaff(member, settings)
  );
}

/**
 * Can this member share a role: they hold it and are whitelisted for it.
 * The server owner is handled by callers (owner bypasses the guard).
 */
export function canShareRole(
  member: GuildMember,
  roleId: string,
  settings: GuildSettings,
): boolean {
  return member.roles.cache.has(roleId) && isWhitelisted(member, settings);
}

/**
 * Can this member share an FG role? Authorised when they own the FG
 * role, are whitelisted (user or role), or are listed in that role's
 * fgRoleSharers (shared with by staff, or authed by the FG owner).
 * Holding the role alone is NOT enough, and the server owner is
 * handled by callers (owner bypasses the guard). Auth is permission
 * to share only — an authed member need not hold the role at all.
 * The old /fg assign lists are still read here for backwards
 * compatibility: anyone listed there can share too.
 */
export function isFgSharer(
  member: GuildMember,
  roleId: string,
  settings: GuildSettings,
): boolean {
  if (settings.fgRoleOwners[roleId] === member.id) return true;
  if (isWhitelisted(member, settings)) return true;
  return (settings.fgRoleSharers[roleId] ?? []).includes(member.id);
}

/**
 * Can this member authorise others to share an FG role? The FG role's
 * owner, a whitelisted member, or the server owner (handled by callers).
 */
export function canAuthFgRole(
  member: GuildMember,
  roleId: string,
  settings: GuildSettings,
): boolean {
  return (
    settings.fgRoleOwners[roleId] === member.id ||
    isWhitelisted(member, settings)
  );
}

export function canAssignFgRole(
  member: GuildMember,
  roleId: string,
  settings: GuildSettings,
): boolean {
  const access = settings.fgRoles[roleId];
  return (
    Boolean(access) &&
    (isFgStaff(member, settings) ||
      memberMatchesWhitelist(
        member,
        access.assignUserIds,
        access.assignRoleIds,
      ))
  );
}

export function canShareFgRole(
  member: GuildMember,
  roleId: string,
  access: FgRoleAccess | undefined,
): boolean {
  return Boolean(
    access &&
      member.roles.cache.has(roleId) &&
      memberMatchesWhitelist(
        member,
        access.shareUserIds,
        access.shareRoleIds,
      ),
  );
}
