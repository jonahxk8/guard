import assert from "node:assert/strict";
import test from "node:test";
import {
  AuditLogEvent,
  EmbedBuilder,
  Guild,
  GuildAuditLogsEntry,
  PermissionFlagsBits,
  Role,
} from "discord.js";
import { ConfigStore, GuildSettings } from "./config-store.js";
import {
  guardAuditLogEntry,
  isDangerousRole,
  verifyExecutor,
} from "./role-guard.js";
import { clearOffenses } from "./offenders.js";

const GUILD_ID = "111111111111111111";
const MEMBER_ID = "222222222222222222";
const ROLE_ID = "333333333333333333";
const ALLOWED_ACTOR_ID = "444444444444444444";
const UNAPPROVED_ACTOR_ID = "555555555555555555";
const ALLOWED_ROLE_ID = "888888888888888888";
const REPEAT_ACTOR_ID = "121212121212121212";
const OWNER_ID = "999999999999999999";
const NOW = 1_700_000_000_000;

interface SentMessage {
  embeds: EmbedBuilder[];
}

interface GuardSetup {
  guild: Guild;
  settings: GuildSettings;
  removedRoleIds: string[][];
  sentMessages: SentMessage[];
  dms: string[];
  memberFetchCount: number;
}

function createSetup(
  options: {
    allowedUserIds?: string[];
    allowedRoleIds?: string[];
    actorRoleIds?: string[];
    hasManageRoles?: boolean;
    botAboveRole?: boolean;
    enforcementEnabled?: boolean;
    ownerId?: string;
    blacklist?: Record<string, string[]>;
    logChannelId?: string | null;
    fetchAuditLogs?: (options: unknown) => Promise<unknown>;
  } = {},
): GuardSetup {
  const settings: GuildSettings = {
    protectedRoleIds: [ROLE_ID],
    allowedUserIds: options.allowedUserIds ?? [],
    allowedRoleIds: options.allowedRoleIds ?? [],
    fgStaffUserIds: [],
    fgStaffRoleIds: [],
    fgRoles: {},
    fgBaseRoleId: null,
    fgAwardRoleId: null,
    fgRoleOwners: {},
    blacklist: options.blacklist ?? {},
    logChannelId: options.logChannelId === undefined ? "666666666666666666" : options.logChannelId,
    enforcementEnabled: options.enforcementEnabled ?? true,
  };
  const removedRoleIds: string[][] = [];
  const sentMessages: SentMessage[] = [];
  const dms: string[] = [];
  let memberFetchCount = 0;

  const member = {
    id: MEMBER_ID,
    roles: {
      remove: async (roleIds: string[]) => {
        removedRoleIds.push(roleIds);
      },
    },
  };
  const actor = {
    id: UNAPPROVED_ACTOR_ID,
    roles: {
      cache: {
        some: (predicate: (role: { id: string }) => boolean) =>
          (options.actorRoleIds ?? []).some((roleId) => predicate({ id: roleId })),
      },
    },
    send: async (message: string) => {
      dms.push(message);
    },
  };
  const botMember = {
    permissions: {
      has: (permission: bigint) =>
        permission === PermissionFlagsBits.ManageRoles &&
        (options.hasManageRoles ?? true),
    },
    roles: {
      highest: {
        comparePositionTo: () => (options.botAboveRole === false ? -1 : 1),
      },
    },
  };
  const channel = {
    isTextBased: () => true,
    send: async (message: SentMessage) => {
      sentMessages.push(message);
    },
  };
  const guild = {
    id: GUILD_ID,
    name: "Test Server",
    ownerId: options.ownerId ?? OWNER_ID,
    fetchAuditLogs: options.fetchAuditLogs,
    channels: {
      fetch: async () => channel,
    },
    members: {
      me: botMember,
      fetch: async (memberId: string) => {
        memberFetchCount += 1;
        return memberId === MEMBER_ID ? member : actor;
      },
      fetchMe: async () => botMember,
    },
    roles: {
      cache: new Map([[ROLE_ID, { id: ROLE_ID }]]),
    },
  } as unknown as Guild;

  return {
    guild,
    settings,
    removedRoleIds,
    sentMessages,
    dms,
    get memberFetchCount() {
      return memberFetchCount;
    },
  };
}

function createStore(settings: GuildSettings): ConfigStore {
  return {
    get: () => ({
      ...settings,
      protectedRoleIds: [...settings.protectedRoleIds],
      allowedUserIds: [...settings.allowedUserIds],
    }),
  } as unknown as ConfigStore;
}

function createEntry(
  id: string,
  executorId: string | null,
  createdTimestamp: number = NOW,
): GuildAuditLogsEntry {
  return {
    id,
    action: AuditLogEvent.MemberRoleUpdate,
    targetId: MEMBER_ID,
    executorId,
    createdTimestamp,
    changes: [
      {
        key: "$add",
        new: [{ id: ROLE_ID }, { id: "777777777777777777" }],
      },
    ],
  } as unknown as GuildAuditLogsEntry;
}

function getLoggedEmbed(setup: GuardSetup): ReturnType<EmbedBuilder["toJSON"]> {
  assert.equal(setup.sentMessages.length, 1, "expected one moderation log");
  return setup.sentMessages[0].embeds[0].toJSON();
}

test("keeps watched roles assigned by a whitelisted actor", async () => {
  const setup = createSetup({ allowedUserIds: [ALLOWED_ACTOR_ID] });

  await guardAuditLogEntry(
    createEntry("audit-allowed", ALLOWED_ACTOR_ID),
    setup.guild,
    createStore(setup.settings),
  );

  assert.deepEqual(setup.removedRoleIds, []);
  assert.equal(setup.memberFetchCount, 0);
  assert.equal(setup.sentMessages.length, 0);
});

test("keeps watched roles assigned by a member of a whitelisted role", async () => {
  const setup = createSetup({
    allowedRoleIds: [ALLOWED_ROLE_ID],
    actorRoleIds: [ALLOWED_ROLE_ID],
  });

  await guardAuditLogEntry(
    createEntry("audit-allowed-role", UNAPPROVED_ACTOR_ID),
    setup.guild,
    createStore(setup.settings),
  );

  assert.deepEqual(setup.removedRoleIds, []);
  assert.equal(setup.sentMessages.length, 0);
});

test("removes watched roles assigned by an unapproved actor", async () => {
  const setup = createSetup();

  await guardAuditLogEntry(
    createEntry("audit-unapproved", UNAPPROVED_ACTOR_ID),
    setup.guild,
    createStore(setup.settings),
  );

  assert.deepEqual(setup.removedRoleIds, [[ROLE_ID]]);
  const embed = getLoggedEmbed(setup);
  assert.equal(embed.title, "Unauthorized role assignment");
  assert.equal(
    embed.fields?.find((field) => field.name === "Assigned by")?.value,
    `<@${UNAPPROVED_ACTOR_ID}>`,
  );
  assert.equal(
    embed.fields?.some((field) => field.name === "Action needed"),
    false,
  );
});

test("a legacy paused config does not stop enforcement anymore", async () => {
  // There is no pause command anymore, so a stale enforcementEnabled: false
  // in an old config file must not silently turn the guard off.
  const setup = createSetup({ enforcementEnabled: false });

  await guardAuditLogEntry(
    createEntry("audit-paused", UNAPPROVED_ACTOR_ID),
    setup.guild,
    createStore(setup.settings),
  );

  assert.deepEqual(setup.removedRoleIds, [[ROLE_ID]]);
  assert.equal(setup.sentMessages.length, 1);
});

test("removes watched roles when the audit log does not verify an actor", async () => {
  const setup = createSetup();

  await guardAuditLogEntry(
    createEntry("audit-unverified", null),
    setup.guild,
    createStore(setup.settings),
  );

  assert.deepEqual(setup.removedRoleIds, [[ROLE_ID]]);
  const embed = getLoggedEmbed(setup);
  assert.equal(
    embed.fields?.find((field) => field.name === "Assigned by")?.value,
    "Unknown (audit log has no assigner)",
  );
  assert.equal(
    embed.fields?.find((field) => field.name === "Reason")?.value,
    "Bot could not verify the assigner.",
  );
});

test("reports when Wild lacks Manage Roles permission", async () => {
  const setup = createSetup({ hasManageRoles: false });

  await guardAuditLogEntry(
    createEntry("audit-no-permission", UNAPPROVED_ACTOR_ID),
    setup.guild,
    createStore(setup.settings),
  );

  assert.deepEqual(setup.removedRoleIds, []);
  const embed = getLoggedEmbed(setup);
  assert.match(
    embed.fields?.find((field) => field.name === "Action needed")?.value ?? "",
    /cannot manage one or more watched roles/i,
  );
});

test("reports when a watched role is above Wild in the role hierarchy", async () => {
  const setup = createSetup({ botAboveRole: false });

  await guardAuditLogEntry(
    createEntry("audit-hierarchy", UNAPPROVED_ACTOR_ID),
    setup.guild,
    createStore(setup.settings),
  );

  assert.deepEqual(setup.removedRoleIds, []);
  const embed = getLoggedEmbed(setup);
  assert.match(
    embed.fields?.find((field) => field.name === "Action needed")?.value ?? "",
    /cannot manage one or more watched roles/i,
  );
});

test("keeps watched roles assigned by the server owner", async () => {
  const setup = createSetup({ ownerId: UNAPPROVED_ACTOR_ID });

  await guardAuditLogEntry(
    createEntry("audit-owner", UNAPPROVED_ACTOR_ID),
    setup.guild,
    createStore(setup.settings),
  );

  assert.deepEqual(setup.removedRoleIds, []);
  assert.equal(setup.sentMessages.length, 0);
  assert.equal(setup.dms.length, 0);
});

test("DMs the unapproved actor even with no log channel set", async () => {
  clearOffenses();
  const setup = createSetup({ logChannelId: null });

  await guardAuditLogEntry(
    createEntry("audit-dm-no-log", UNAPPROVED_ACTOR_ID),
    setup.guild,
    createStore(setup.settings),
  );

  assert.deepEqual(setup.removedRoleIds, [[ROLE_ID]]);
  assert.equal(setup.sentMessages.length, 0);
  assert.equal(setup.dms.length, 1);
  assert.match(setup.dms[0], new RegExp(ROLE_ID));
  assert.match(setup.dms[0], /whitelist/i);
});

test("flags a repeat offender on the third unauthorised assignment", async () => {
  clearOffenses();
  const setup = createSetup();

  for (let i = 1; i <= 3; i += 1) {
    await guardAuditLogEntry(
      createEntry(`audit-repeat-${i}`, REPEAT_ACTOR_ID),
      setup.guild,
      createStore(setup.settings),
    );
  }

  assert.equal(setup.removedRoleIds.length, 3);
  const thirdEmbed = setup.sentMessages[2].embeds[0].toJSON();
  assert.equal(
    thirdEmbed.fields?.find((field) => field.name === "Repeat offender")?.value,
    "3+ unauthorised assignments",
  );
  const firstEmbed = setup.sentMessages[0].embeds[0].toJSON();
  assert.equal(
    firstEmbed.fields?.some((field) => field.name === "Repeat offender"),
    false,
  );
});

test("keeps a grant when the audit log corroborates a whitelisted executor", async () => {
  const setup = createSetup({
    allowedUserIds: [ALLOWED_ACTOR_ID],
    fetchAuditLogs: async () => ({
      entries: new Map([
        [
          "audit-corr",
          {
            id: "audit-corr",
            targetId: MEMBER_ID,
            executorId: ALLOWED_ACTOR_ID,
            createdTimestamp: NOW,
            changes: [{ key: "$add", new: [{ id: ROLE_ID }] }],
          },
        ],
      ]),
    }),
  });

  await guardAuditLogEntry(
    createEntry("audit-event", UNAPPROVED_ACTOR_ID),
    setup.guild,
    createStore(setup.settings),
  );

  assert.deepEqual(setup.removedRoleIds, []);
  assert.equal(setup.sentMessages.length, 0);
});

test("still removes a grant when audit-log corroboration returns nothing", async () => {
  clearOffenses();
  const setup = createSetup({
    fetchAuditLogs: async () => ({ entries: new Map() }),
  });

  await guardAuditLogEntry(
    createEntry("audit-no-corr", UNAPPROVED_ACTOR_ID),
    setup.guild,
    createStore(setup.settings),
  );

  assert.deepEqual(setup.removedRoleIds, [[ROLE_ID]]);
});

test("verifyExecutor tolerates a guild with no fetchAuditLogs method", async () => {
  const setup = createSetup();
  const entry = createEntry("audit-no-fetch", UNAPPROVED_ACTOR_ID);
  assert.equal(await verifyExecutor(entry, setup.guild), UNAPPROVED_ACTOR_ID);
});

test("isDangerousRole flags Administrator roles and only those", () => {
  const adminRole = {
    permissions: {
      has: (permission: bigint) =>
        permission === PermissionFlagsBits.Administrator,
    },
  } as unknown as Role;
  const normalRole = {
    permissions: { has: () => false },
  } as unknown as Role;
  assert.equal(isDangerousRole(adminRole), true);
  assert.equal(isDangerousRole(normalRole), false);
});

test("removes a blacklisted grant even when the giver is whitelisted", async () => {
  clearOffenses();
  const setup = createSetup({
    allowedUserIds: [ALLOWED_ACTOR_ID],
    blacklist: { [MEMBER_ID]: [ROLE_ID] },
  });

  await guardAuditLogEntry(
    createEntry("audit-blacklist-whitelisted-giver", ALLOWED_ACTOR_ID),
    setup.guild,
    createStore(setup.settings),
  );

  assert.deepEqual(setup.removedRoleIds, [[ROLE_ID]]);
  const embed = getLoggedEmbed(setup);
  assert.equal(embed.title, "Blacklisted role assignment");
  assert.equal(
    embed.fields?.find((field) => field.name === "Reason")?.value,
    "The member is blacklisted from this role.",
  );
  // The giver was authorised, so this is not recorded as an offence —
  // the DM explains the blacklist instead of the whitelist.
  assert.equal(setup.dms.length, 1);
  assert.match(setup.dms[0], /blacklisted/i);
  assert.doesNotMatch(setup.dms[0], /whitelisted to assign/i);
});

test("does not remove a blacklisted grant given by the server owner", async () => {
  const setup = createSetup({
    ownerId: ALLOWED_ACTOR_ID,
    allowedUserIds: [ALLOWED_ACTOR_ID],
    blacklist: { [MEMBER_ID]: [ROLE_ID] },
  });

  await guardAuditLogEntry(
    createEntry("audit-blacklist-owner", ALLOWED_ACTOR_ID),
    setup.guild,
    createStore(setup.settings),
  );

  assert.deepEqual(setup.removedRoleIds, []);
  assert.equal(setup.sentMessages.length, 0);
  assert.equal(setup.dms.length, 0);
});

test("a grant to a non-blacklisted user by a whitelisted giver is unaffected", async () => {
  const setup = createSetup({
    allowedUserIds: [ALLOWED_ACTOR_ID],
    blacklist: { ["121212121212121213"]: [ROLE_ID] },
  });

  await guardAuditLogEntry(
    createEntry("audit-blacklist-other-user", ALLOWED_ACTOR_ID),
    setup.guild,
    createStore(setup.settings),
  );

  assert.deepEqual(setup.removedRoleIds, []);
  assert.equal(setup.sentMessages.length, 0);
  assert.equal(setup.dms.length, 0);
});

test("still removes a blacklisted grant when the assigner cannot be verified", async () => {
  clearOffenses();
  const setup = createSetup({
    blacklist: { [MEMBER_ID]: [ROLE_ID] },
  });

  await guardAuditLogEntry(
    createEntry("audit-blacklist-unverified", null),
    setup.guild,
    createStore(setup.settings),
  );

  assert.deepEqual(setup.removedRoleIds, [[ROLE_ID]]);
  const embed = getLoggedEmbed(setup);
  assert.match(
    embed.fields?.find((field) => field.name === "Reason")?.value ?? "",
    /blacklisted/i,
  );
});
