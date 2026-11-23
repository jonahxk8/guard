import { Guild, GuildMember } from "discord.js";
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
 * restarts. A member who HAD a staff admin role when cached still looks
 * like an admin after it is removed, and the guard would let their
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
 * The six staff admin roles, by role ID. These are the user's staff
 * roles, baked into the bot: a member holding any one of them is a bot
 * admin in every server where the role exists. In a server without
 * these roles, only the server owner is a bot admin. The Discord
 * Administrator permission alone grants NOTHING — a member with
 * Administrator but no admin role (and not the owner) is an ordinary
 * member. There is no command to change this list (a future option).
 */
export const ADMIN_ROLE_IDS: readonly string[] = [
  "1569765098883391510",
  "1572935769931255808",
  "1528406720588546128",
  "1528406720588546125",
  "1528406720588546124",
  "1572646478944407603",
];

/**
 * Server owner OR a holder of one of the six staff admin roles.
 * Admin-role holders can use the bot fully, exactly like the server
 * owner. Tolerant of partial/mock members: a member whose roles cannot
 * be read is not an admin unless their id is the owner's.
 */
export function isBotAdmin(
  member: GuildMember | null | undefined,
  ownerId: string | null | undefined,
): boolean {
  if (!member) return false;
  if (ownerId && member.id === ownerId) return true;
  const cache = (
    member as unknown as {
      roles?: { cache?: { some?: unknown; has?: unknown } };
    }
  ).roles?.cache;
  if (!cache) return false;
  try {
    if (typeof cache.some === "function") {
      return (cache.some as (predicate: (role: { id: string }) => boolean) => boolean)(
        (role) => ADMIN_ROLE_IDS.includes(role.id),
      );
    }
    if (typeof cache.has === "function") {
      return ADMIN_ROLE_IDS.some((id) =>
        (cache.has as (roleId: string) => boolean)(id),
      );
    }
  } catch {
    return false;
  }
  return false;
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
