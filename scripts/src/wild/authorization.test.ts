import assert from "node:assert/strict";
import test from "node:test";
import { GuildMember } from "discord.js";
import {
  canAssignFgRole,
  canAuthFgRole,
  canShareFgRole,
  isFgSharer,
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
    fgBaseRoleId: null,
    fgRoleSharers: {},
    fgRoleOwners: {},
    blacklist: {},
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

test("isFgSharer: FG owner, whitelisted, and listed sharers pass; holding alone fails", () => {
  const ownerId = "777777777777777777";
  const listedId = "888888888888888888";
  const settings = makeSettings({
    assignUserIds: [],
    assignRoleIds: [],
    shareUserIds: [],
    shareRoleIds: [],
  });
  settings.fgRoleOwners = { [FG_ROLE_ID]: ownerId };
  settings.fgRoleSharers = { [FG_ROLE_ID]: [listedId] };
  settings.allowedUserIds = [MEMBER_ID];

  // FG owner is always authorised, even without holding the role.
  assert.equal(isFgSharer(makeMember(ownerId), FG_ROLE_ID, settings), true);
  // Whitelisted staff are always authorised.
  assert.equal(isFgSharer(makeMember(MEMBER_ID), FG_ROLE_ID, settings), true);
  // A listed sharer is authorised, with or without the role.
  assert.equal(isFgSharer(makeMember(listedId), FG_ROLE_ID, settings), true);
  // Holding the role alone is NOT enough.
  assert.equal(
    isFgSharer(makeMember("999999999999999999", [FG_ROLE_ID]), FG_ROLE_ID, settings),
    false,
  );
  assert.equal(isFgSharer(makeMember("999999999999999999"), FG_ROLE_ID, settings), false);
});

test("canAuthFgRole: FG owner and whitelisted pass; holder and random member fail", () => {
  const ownerId = "777777777777777777";
  const holderId = "888888888888888888";
  const settings = makeSettings({
    assignUserIds: [],
    assignRoleIds: [],
    shareUserIds: [],
    shareRoleIds: [],
  });
  settings.fgRoleOwners = { [FG_ROLE_ID]: ownerId };
  settings.allowedUserIds = [MEMBER_ID];

  assert.equal(canAuthFgRole(makeMember(ownerId), FG_ROLE_ID, settings), true);
  assert.equal(canAuthFgRole(makeMember(MEMBER_ID), FG_ROLE_ID, settings), true);
  // Holding the role (assigned, not owner) is not enough to auth others.
  assert.equal(canAuthFgRole(makeMember(holderId, [FG_ROLE_ID]), FG_ROLE_ID, settings), false);
  assert.equal(canAuthFgRole(makeMember("999999999999999999"), FG_ROLE_ID, settings), false);
});
