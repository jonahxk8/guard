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
