import assert from "node:assert/strict";
import test from "node:test";
import { GuildMember } from "discord.js";
import {
  canAssignFgRole,
  canShareFgRole,
  isFgStaff,
} from "./authorization.js";
import { FgRoleAccess, GuildSettings } from "./config-store.js";

const FG_ROLE_ID = "333333333333333333";
const ASSIGNER_ROLE_ID = "444444444444444444";
const SHARER_ROLE_ID = "555555555555555555";
const MEMBER_ID = "666666666666666666";

function makeMember(id: string, roleIds: string[] = []): GuildMember {
  return {
    id,
    roles: {
      cache: {
        has: (roleId: string) => roleIds.includes(roleId),
        some: (predicate: (role: { id: string }) => boolean) =>
          roleIds.some((roleId) => predicate({ id: roleId })),
      },
    },
  } as unknown as GuildMember;
}

function makeSettings(access: FgRoleAccess): GuildSettings {
  return {
    protectedRoleIds: [FG_ROLE_ID],
    allowedUserIds: [],
    allowedRoleIds: [],
    fgStaffUserIds: [],
    fgStaffRoleIds: [],
    fgRoles: { [FG_ROLE_ID]: access },
    logChannelId: null,
    enforcementEnabled: true,
  };
}

test("FG assignment requires FG staff or a per-role assign whitelist", () => {
  const settings = makeSettings({
    assignUserIds: [],
    assignRoleIds: [ASSIGNER_ROLE_ID],
    shareUserIds: [],
    shareRoleIds: [],
  });

  assert.equal(canAssignFgRole(makeMember(MEMBER_ID, [ASSIGNER_ROLE_ID]), FG_ROLE_ID, settings), true);
  assert.equal(canAssignFgRole(makeMember(MEMBER_ID), FG_ROLE_ID, settings), false);

  settings.fgStaffUserIds.push(MEMBER_ID);
  assert.equal(canAssignFgRole(makeMember(MEMBER_ID), FG_ROLE_ID, settings), true);
  assert.equal(isFgStaff(makeMember(MEMBER_ID), settings), true);
});

test("FG sharing requires holding and being whitelisted for that FG role", () => {
  const access = {
    assignUserIds: [],
    assignRoleIds: [],
    shareUserIds: [MEMBER_ID],
    shareRoleIds: [],
  };

  assert.equal(canShareFgRole(makeMember(MEMBER_ID, [FG_ROLE_ID]), FG_ROLE_ID, access), true);
  assert.equal(canShareFgRole(makeMember(MEMBER_ID), FG_ROLE_ID, access), false);
  assert.equal(canShareFgRole(makeMember(MEMBER_ID, [FG_ROLE_ID]), FG_ROLE_ID, {
    ...access,
    shareUserIds: [],
  }), false);
});
