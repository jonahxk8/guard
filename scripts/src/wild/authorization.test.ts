import assert from "node:assert/strict";
import test from "node:test";
import { Guild, GuildMember, PermissionFlagsBits } from "discord.js";
import {
  canAssignFgRole,
  canAuthFgRole,
  canShareFgRole,
  fetchMemberFresh,
  isBotAdmin,
  isBotAdminPermissions,
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

/** Administrator counts as owner: the server owner, or anyone with the
 * Discord Administrator permission, can use the bot fully. */

test("isBotAdmin: owner, Administrator, and neither", () => {
  const ownerId = "999999999999999999";
  const adminMember = {
    id: "222222222222222222",
    permissions: {
      has: (permission: bigint) =>
        permission === PermissionFlagsBits.Administrator,
    },
    roles: { cache: { some: () => false } },
  } as unknown as GuildMember;
  const plainMember = {
    id: "222222222222222222",
    permissions: { has: () => false },
    roles: { cache: { some: () => false } },
  } as unknown as GuildMember;
  const ownerMember = {
    id: ownerId,
    permissions: { has: () => false },
    roles: { cache: { some: () => false } },
  } as unknown as GuildMember;

  assert.equal(isBotAdmin(ownerMember, ownerId), true);
  assert.equal(isBotAdmin(adminMember, ownerId), true);
  assert.equal(isBotAdmin(plainMember, ownerId), false);
  assert.equal(isBotAdmin(null, ownerId), false);
  assert.equal(isBotAdmin(undefined, ownerId), false);
  // A member with no permissions object is not an admin (unless owner).
  assert.equal(
    isBotAdmin({ id: "222222222222222222" } as unknown as GuildMember, ownerId),
    false,
  );
});

test("isBotAdminPermissions: owner or Administrator bit", () => {
  const ownerId = "999999999999999999";
  const adminPermissions = {
    has: (permission: bigint) =>
      permission === PermissionFlagsBits.Administrator,
  };
  const plainPermissions = { has: () => false };
  assert.equal(
    isBotAdminPermissions(adminPermissions, "222222222222222222", ownerId),
    true,
  );
  assert.equal(
    isBotAdminPermissions(plainPermissions, "222222222222222222", ownerId),
    false,
  );
  assert.equal(isBotAdminPermissions(plainPermissions, ownerId, ownerId), true);
  assert.equal(
    isBotAdminPermissions(null, "222222222222222222", ownerId),
    false,
  );
});

test("fetchMemberFresh bypasses the cache with force: true", async () => {
  const fresh = makeMember(MEMBER_ID, []);
  const stale = makeMember(MEMBER_ID, []);
  const calls: unknown[] = [];
  const guild = {
    members: {
      // Simulates discord.js: without force the cached member comes
      // back, with force the API (fresh) member comes back.
      fetch: async (arg: unknown) => {
        calls.push(arg);
        const force =
          typeof arg === "object" &&
          arg !== null &&
          (arg as { force?: boolean }).force === true;
        return force ? fresh : stale;
      },
    },
  } as unknown as Guild;

  assert.equal(await fetchMemberFresh(guild, MEMBER_ID), fresh);
  assert.deepEqual(calls, [{ user: MEMBER_ID, force: true }]);
});

test("fetchMemberFresh returns null when the fetch fails", async () => {
  const guild = {
    members: {
      fetch: async () => {
        throw new Error("API down");
      },
    },
  } as unknown as Guild;

  assert.equal(await fetchMemberFresh(guild, MEMBER_ID), null);
});
