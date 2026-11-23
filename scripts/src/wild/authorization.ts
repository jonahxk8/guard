import { GuildMember } from "discord.js";
import { FgRoleAccess, GuildSettings } from "./config-store.js";

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
 * Can this member share an FG role under the assign + auth model?
 * Authorised when they own the FG role, are whitelisted (user or role),
 * or are listed in that role's fgRoleSharers (assigned by staff, or
 * authed by the FG owner). Holding the role alone is NOT enough, and
 * the server owner is handled by callers (owner bypasses the guard).
 * Auth is permission to share only — an authed member need not hold
 * the role at all.
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
