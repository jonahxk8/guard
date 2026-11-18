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
