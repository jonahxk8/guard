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
  getOffenseCount,
  isDangerousRole,
  parseAuditReasonRequester,
  sweepMissedGrants,
  verifyExecutor,
} from "./role-guard.js";
import { clearOffenses } from "./offenders.js";

const GUILD_ID = "111111111111111111";
const MEMBER_ID = "222222222222222222";
const ROLE_ID = "333333333333333333";
const FG_ROLE_ID = "343434343434343434";
const FG_OWNER_ID = "565656565656565656";
const ALLOWED_ACTOR_ID = "444444444444444444";
const UNAPPROVED_ACTOR_ID = "555555555555555555";
const ALLOWED_ROLE_ID = "888888888888888888";
const REPEAT_ACTOR_ID = "121212121212121212";
const OWNER_ID = "999999999999999999";
const BLEED_BOT_ID = "131313131313131313";
const GREED_BOT_ID = "151515151515151515";
const WEAK3_ID = "141414141414141414";
// The user ID from the live Greed audit entry the user screenshotted:
// "Role update by 1umk (763299524789141525)".
const ONEUMK_ID = "763299524789141525";
const ONEUMK_NAME_ID = "161616161616161616";
const NOW = 1_700_000_000_000;

interface SentMessage {
  embeds: EmbedBuilder[];
}

interface DmMessage {
  embeds?: EmbedBuilder[];
  content?: string;
}

interface GuardSetup {
  guild: Guild;
  settings: GuildSettings;
  removedRoleIds: string[][];
  sentMessages: SentMessage[];
  dms: DmMessage[];
  memberFetchCount: number;
  memberFetchCalls: Array<{ user: string; force: boolean }>;
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
    actorIsAdmin?: boolean;
    actorHasManageRoles?: boolean;
    blacklist?: Record<string, string[]>;
    logChannelId?: string | null;
    fetchAuditLogs?: (options: unknown) => Promise<unknown>;
    protectedRoleIds?: string[];
    fgRoleId?: string;
    fgRoleOwnerId?: string | null;
    fgRoleSharers?: string[];
    fgStaffUserIds?: string[];
    fgStaffRoleIds?: string[];
    // Simulates the discord.js cache: when set, a fetch WITHOUT
    // force returns a stale member whose Administrator bit is
    // actorCachedIsAdmin, while a force fetch returns the fresh member
    // (Administrator = actorIsAdmin). This is the reported live bug.
    actorCachedIsAdmin?: boolean;
    // Members resolvable by username (REST member search): Bleed's
    // audit reason names the requester by username ("added role by
    // weak3"), and the guard resolves it to one of these.
    usernameMembers?: Array<{ id: string; username: string; displayName?: string }>;
    // User IDs a force fetch returns null for (simulates the real
    // API 404 for a member who is not in the guild): used to test
    // the fallback from a Greed reason's parenthesised ID to the
    // username in the same reason.
    unresolvableUserIds?: string[];
    // Whether the target member currently holds the watched role
    // (roles.cache.has). Defaults to true.
    targetHoldsRole?: boolean;
  } = {},
): GuardSetup {
  const fgRoleId = options.fgRoleId;
  const settings: GuildSettings = {
    protectedRoleIds: options.protectedRoleIds ?? [ROLE_ID],
    allowedUserIds: options.allowedUserIds ?? [],
    allowedRoleIds: options.allowedRoleIds ?? [],
    fgStaffUserIds: options.fgStaffUserIds ?? [],
    fgStaffRoleIds: options.fgStaffRoleIds ?? [],
    fgRoles: fgRoleId
      ? {
          [fgRoleId]: {
            assignUserIds: [],
            assignRoleIds: [],
            shareUserIds: [],
            shareRoleIds: [],
          },
        }
      : {},
    fgBaseRoleId: null,
    fgRoleSharers: fgRoleId
      ? { [fgRoleId]: options.fgRoleSharers ?? [] }
      : {},
    fgRoleOwners:
      fgRoleId && options.fgRoleOwnerId
        ? { [fgRoleId]: options.fgRoleOwnerId }
        : {},
    blacklist: options.blacklist ?? {},
    logChannelId: options.logChannelId === undefined ? "666666666666666666" : options.logChannelId,
    enforcementEnabled: options.enforcementEnabled ?? true,
  };
  const removedRoleIds: string[][] = [];
  const sentMessages: SentMessage[] = [];
  const dms: DmMessage[] = [];
  const memberFetchCalls: Array<{ user: string; force: boolean }> = [];
  let memberFetchCount = 0;

  const member = {
    id: MEMBER_ID,
    roles: {
      cache: {
        // The target currently holds the watched role unless the test
        // says otherwise (already-removed case).
        has: () => options.targetHoldsRole ?? true,
      },
      remove: async (roleIds: string[]) => {
        removedRoleIds.push(roleIds);
      },
    },
  };
  const actor = {
    id: UNAPPROVED_ACTOR_ID,
    user: { bot: false, username: "actor" },
    permissions: {
      has: (permission: bigint) => {
        if (permission === PermissionFlagsBits.Administrator) {
          return options.actorIsAdmin ?? false;
        }
        if (permission === PermissionFlagsBits.ManageRoles) {
          return options.actorHasManageRoles ?? true;
        }
        return false;
      },
    },
    roles: {
      cache: {
        // The actor holds the watched role when it is also the target
        // (self-grant), unless the test says the role is already gone.
        has: () => options.targetHoldsRole ?? true,
        some: (predicate: (role: { id: string }) => boolean) =>
          (options.actorRoleIds ?? []).some((roleId) => predicate({ id: roleId })),
      },
      // A self-grant target resolves to this same mock, so it must be
      // able to have roles removed like the member mock.
      remove: async (roleIds: string[]) => {
        removedRoleIds.push(roleIds);
      },
    },
    send: async (message: DmMessage) => {
      dms.push(message);
    },
  };
  // Stale cached copy of the actor: same member, but with the
  // Administrator bit as it was when the member was first cached.
  // Only used when the test sets actorCachedIsAdmin.
  const staleActor =
    options.actorCachedIsAdmin === undefined
      ? null
      : {
          ...actor,
          permissions: {
            has: (permission: bigint) => {
              if (permission === PermissionFlagsBits.Administrator) {
                return options.actorCachedIsAdmin ?? false;
              }
              if (permission === PermissionFlagsBits.ManageRoles) {
                return options.actorHasManageRoles ?? true;
              }
              return false;
            },
          },
        };
  // Bleed's bot user: the audit executor when a role is granted
  // through Bleed. Its DM send records, so a test can prove the guard
  // never DMs the bot itself.
  const bleedBot = {
    id: BLEED_BOT_ID,
    user: { bot: true, username: "bleed" },
    permissions: { has: () => false },
    roles: {
      cache: {
        has: () => false,
        some: () => false,
      },
    },
    send: async (message: DmMessage) => {
      dms.push(message);
    },
  };
  // Greed's bot user: the audit executor when a role is granted
  // through Greed. Same shape as the Bleed mock above.
  const greedBot = {
    id: GREED_BOT_ID,
    user: { bot: true, username: "greed" },
    permissions: { has: () => false },
    roles: {
      cache: {
        has: () => false,
        some: () => false,
      },
    },
    send: async (message: DmMessage) => {
      dms.push(message);
    },
  };
  // The FG role's owner, as a member: used for the FG-owner fallback
  // attribution and for DM assertions (their send records).
  const ownerMember = {
    id: FG_OWNER_ID,
    displayName: "Leen",
    user: { bot: false, username: "leen" },
    permissions: { has: () => false },
    roles: {
      cache: {
        has: () => false,
        some: () => false,
      },
    },
    send: async (message: DmMessage) => {
      dms.push(message);
    },
  };
  const usernameMembers = (options.usernameMembers ?? []).map((entry) => ({
    id: entry.id,
    displayName: entry.displayName ?? entry.username,
    user: { bot: false, username: entry.username },
    permissions: { has: () => false },
    roles: {
      cache: {
        has: () => false,
        some: () => false,
      },
    },
    send: async (message: DmMessage) => {
      dms.push(message);
    },
  }));
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
      // Simulates discord.js `GuildMemberManager.fetch`: without
      // `force: true` a cached member is returned with no API call,
      // with `force: true` the fresh member comes back. A `{ query }`
      // fetch is the REST member search: prefix matches on username.
      fetch: async (
        arg:
          | string
          | { user?: string; force?: boolean; query?: string; limit?: number },
      ) => {
        if (typeof arg === "object" && typeof arg.query === "string") {
          const query = arg.query.toLowerCase();
          const matches = new Map<string, unknown>();
          for (const candidate of usernameMembers) {
            if (candidate.user.username.toLowerCase().startsWith(query)) {
              matches.set(candidate.id, candidate);
            }
          }
          return matches;
        }
        const userId = typeof arg === "string" ? arg : (arg.user ?? "");
        const force = typeof arg === "object" && arg.force === true;
        if ((options.unresolvableUserIds ?? []).includes(userId)) {
          return null;
        }
        memberFetchCount += 1;
        memberFetchCalls.push({ user: userId, force });
        if (userId === MEMBER_ID) return member;
        if (userId === BLEED_BOT_ID) return bleedBot;
        if (userId === GREED_BOT_ID) return greedBot;
        if (userId === FG_OWNER_ID) return ownerMember;
        const usernameMember = usernameMembers.find(
          (candidate) => candidate.id === userId,
        );
        if (usernameMember) return usernameMember;
        if (!force && staleActor) return staleActor;
        return actor;
      },
      fetchMe: async () => botMember,
    },
    roles: {
      cache: new Map([
        [ROLE_ID, { id: ROLE_ID }],
        [FG_ROLE_ID, { id: FG_ROLE_ID, name: "leen" }],
      ]),
    },
  } as unknown as Guild;

  return {
    guild,
    settings,
    removedRoleIds,
    sentMessages,
    dms,
    memberFetchCalls,
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
  entryOptions: { roleId?: string; targetId?: string; reason?: string | null } = {},
): GuildAuditLogsEntry {
  return {
    id,
    action: AuditLogEvent.MemberRoleUpdate,
    targetId: entryOptions.targetId ?? MEMBER_ID,
    executorId,
    reason: entryOptions.reason ?? null,
    createdTimestamp,
    changes: [
      {
        key: "$add",
        new: [{ id: entryOptions.roleId ?? ROLE_ID }, { id: "777777777777777777" }],
      },
    ],
  } as unknown as GuildAuditLogsEntry;
}

function getLoggedEmbed(setup: GuardSetup): ReturnType<EmbedBuilder["toJSON"]> {
  assert.equal(setup.sentMessages.length, 1, "expected one moderation log");
  return setup.sentMessages[0].embeds[0].toJSON();
}

/** Assert the single sent log is the authorised-grant entry, with no DM. */
function assertAuthorizedLog(
  setup: GuardSetup,
  roleId: string,
  actorId: string,
  via?: string,
): void {
  const embed = getLoggedEmbed(setup);
  assert.equal(embed.title, "Authorized role assignment");
  assert.equal(
    embed.description,
    `Bot kept watched role(s) for <@${MEMBER_ID}>.`,
  );
  assert.equal(
    embed.fields?.find((field) => field.name === "Role(s)")?.value,
    `<@&${roleId}>`,
  );
  assert.equal(
    embed.fields?.find((field) => field.name === "Assigned by")?.value,
    `<@${actorId}>`,
  );
  assert.equal(
    embed.fields?.find((field) => field.name === "Reason")?.value,
    "The assigner is on the whitelist.",
  );
  assert.equal(
    embed.fields?.find((field) => field.name === "Via")?.value ?? null,
    via ?? null,
  );
  assert.equal(setup.dms.length, 0);
}

function getDmEmbed(setup: GuardSetup): ReturnType<EmbedBuilder["toJSON"]> {
  assert.equal(setup.dms.length, 1, "expected one DM");
  const embed = setup.dms[0].embeds?.[0];
  assert.ok(embed, "expected the DM to be an embed");
  return embed.toJSON();
}

function dmText(setup: GuardSetup): string {
  const embed = getDmEmbed(setup);
  return [
    embed.title ?? "",
    ...(embed.fields ?? []).map((field) => `${field.name}\n${field.value}`),
  ].join("\n");
}

test("logs watched roles assigned by a whitelisted actor", async () => {
  const setup = createSetup({ allowedUserIds: [ALLOWED_ACTOR_ID] });

  await guardAuditLogEntry(
    createEntry("audit-allowed", ALLOWED_ACTOR_ID),
    setup.guild,
    createStore(setup.settings),
  );

  assert.deepEqual(setup.removedRoleIds, []);
  // The guard decision itself still costs no fetch (id-authorised), but
  // the authorised log needs one fresh fetch of the actor to rule out
  // Administrator — the log must never claim a whitelisted admin's
  // grant was a plain whitelist grant.
  assert.equal(setup.memberFetchCount, 1);
  assertAuthorizedLog(setup, ROLE_ID, ALLOWED_ACTOR_ID);
  assert.equal(getOffenseCount(GUILD_ID, ALLOWED_ACTOR_ID), 0);
});

test("logs watched roles assigned by a member of a whitelisted role", async () => {
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
  assertAuthorizedLog(setup, ROLE_ID, UNAPPROVED_ACTOR_ID);
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
  // Plain text only: no emoji anywhere in the log embed.
  assert.doesNotMatch(
    JSON.stringify(embed),
    /[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{2B00}-\u{2BFF}\u{25A0}-\u{25FF}\u{2190}-\u{21FF}\u{2300}-\u{23FF}\u{FE0F}\u{200D}]/u,
  );
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
  const dm = getDmEmbed(setup);
  assert.equal(dm.title, "Role removed");
  assert.equal(dm.color, undefined);
  assert.equal(dm.footer, undefined);
  assert.equal(dm.timestamp, undefined);
  const fields = Object.fromEntries(
    (dm.fields ?? []).map((field) => [field.name, field.value]),
  );
  assert.match(fields["Role"] ?? "", new RegExp(ROLE_ID));
  assert.match(fields["Member"] ?? "", new RegExp(MEMBER_ID));
  assert.equal(fields["Server"], "Test Server");
  assert.match(
    fields["Reason"] ?? "",
    /aren't whitelisted to assign protected roles/,
  );
  assert.doesNotMatch(dmText(setup), /Ask a server admin/);
  assert.doesNotMatch(dmText(setup), /whitelist you/);
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
  assertAuthorizedLog(setup, ROLE_ID, ALLOWED_ACTOR_ID);
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
  const dm = getDmEmbed(setup);
  assert.equal(dm.title, "Role removed");
  assert.equal(
    dm.fields?.find((field) => field.name === "Reason")?.value,
    "The member is blacklisted from this role.",
  );
  assert.doesNotMatch(dmText(setup), /Ask a server admin/);
  assert.doesNotMatch(dmText(setup), /whitelisted to assign/i);
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

test("a grant to a non-blacklisted user by a whitelisted giver is logged, not removed", async () => {
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
  assertAuthorizedLog(setup, ROLE_ID, ALLOWED_ACTOR_ID);
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

test("keeps watched roles assigned by an Administrator (not whitelisted)", async () => {
  const setup = createSetup({ actorIsAdmin: true });

  await guardAuditLogEntry(
    createEntry("audit-admin", UNAPPROVED_ACTOR_ID),
    setup.guild,
    createStore(setup.settings),
  );

  assert.deepEqual(setup.removedRoleIds, []);
  assert.equal(setup.sentMessages.length, 0);
  assert.equal(setup.dms.length, 0);
});

test("does not remove a blacklisted grant given by an Administrator", async () => {
  const setup = createSetup({
    actorIsAdmin: true,
    blacklist: { [MEMBER_ID]: [ROLE_ID] },
  });

  await guardAuditLogEntry(
    createEntry("audit-blacklist-admin", UNAPPROVED_ACTOR_ID),
    setup.guild,
    createStore(setup.settings),
  );

  assert.deepEqual(setup.removedRoleIds, []);
  assert.equal(setup.sentMessages.length, 0);
  assert.equal(setup.dms.length, 0);
});

test("an unverified actor is still removed even if they would be an admin", async () => {
  // Fail closed: only a VERIFIED Administrator giver is trusted. Here the
  // audit log verifies nobody (executor null), so the grant is removed
  // even though the actor fake carries Administrator.
  const setup = createSetup({ actorIsAdmin: true });

  await guardAuditLogEntry(
    createEntry("audit-admin-unverified", null),
    setup.guild,
    createStore(setup.settings),
  );

  assert.deepEqual(setup.removedRoleIds, [[ROLE_ID]]);
});

test("removes an FG role a non-whitelisted member with Manage Roles gives to themselves", async () => {
  // The reported case: the giver has Manage Roles but is not whitelisted,
  // not an admin, and not the FG role's owner — and the FG role is not
  // in protectedRoleIds (old config / unprotected with /protect). The
  // self-grant must still be reverted instantly, like a protected role.
  clearOffenses();
  const setup = createSetup({
    protectedRoleIds: [],
    fgRoleId: FG_ROLE_ID,
    fgRoleOwnerId: FG_OWNER_ID,
    actorHasManageRoles: true,
  });

  await guardAuditLogEntry(
    createEntry("audit-fg-self-grant", UNAPPROVED_ACTOR_ID, NOW, {
      roleId: FG_ROLE_ID,
      targetId: UNAPPROVED_ACTOR_ID,
    }),
    setup.guild,
    createStore(setup.settings),
  );

  assert.deepEqual(setup.removedRoleIds, [[FG_ROLE_ID]]);
  assert.equal(setup.sentMessages.length, 1);
  assert.equal(getLoggedEmbed(setup).title, "Unauthorized role assignment");
  assert.equal(setup.dms.length, 1);
  assert.equal(getDmEmbed(setup).title, "Role removed");
});

test("removes an FG role an unauthorised member gives to someone else", async () => {
  clearOffenses();
  const setup = createSetup({
    protectedRoleIds: [],
    fgRoleId: FG_ROLE_ID,
    fgRoleOwnerId: FG_OWNER_ID,
  });

  await guardAuditLogEntry(
    createEntry("audit-fg-other", UNAPPROVED_ACTOR_ID, NOW, {
      roleId: FG_ROLE_ID,
    }),
    setup.guild,
    createStore(setup.settings),
  );

  assert.deepEqual(setup.removedRoleIds, [[FG_ROLE_ID]]);
  assert.equal(setup.sentMessages.length, 1);
  assert.equal(setup.dms.length, 1);
});

test("keeps an FG role its owner gives to themselves", async () => {
  const setup = createSetup({
    protectedRoleIds: [],
    fgRoleId: FG_ROLE_ID,
    fgRoleOwnerId: UNAPPROVED_ACTOR_ID,
  });

  await guardAuditLogEntry(
    createEntry("audit-fg-owner-self", UNAPPROVED_ACTOR_ID, NOW, {
      roleId: FG_ROLE_ID,
      targetId: UNAPPROVED_ACTOR_ID,
    }),
    setup.guild,
    createStore(setup.settings),
  );

  assert.deepEqual(setup.removedRoleIds, []);
  assert.equal(setup.sentMessages.length, 0);
  assert.equal(setup.dms.length, 0);
});

test("logs an FG role a whitelisted member gives to someone else", async () => {
  const setup = createSetup({
    protectedRoleIds: [],
    fgRoleId: FG_ROLE_ID,
    fgRoleOwnerId: FG_OWNER_ID,
    allowedUserIds: [ALLOWED_ACTOR_ID],
  });

  await guardAuditLogEntry(
    createEntry("audit-fg-whitelisted", ALLOWED_ACTOR_ID, NOW, {
      roleId: FG_ROLE_ID,
    }),
    setup.guild,
    createStore(setup.settings),
  );

  assert.deepEqual(setup.removedRoleIds, []);
  assertAuthorizedLog(setup, FG_ROLE_ID, ALLOWED_ACTOR_ID);
  assert.equal(getOffenseCount(GUILD_ID, ALLOWED_ACTOR_ID), 0);
});

test("keeps an FG role an Administrator gives to someone else", async () => {
  const setup = createSetup({
    protectedRoleIds: [],
    fgRoleId: FG_ROLE_ID,
    fgRoleOwnerId: FG_OWNER_ID,
    actorIsAdmin: true,
  });

  await guardAuditLogEntry(
    createEntry("audit-fg-admin", UNAPPROVED_ACTOR_ID, NOW, {
      roleId: FG_ROLE_ID,
    }),
    setup.guild,
    createStore(setup.settings),
  );

  assert.deepEqual(setup.removedRoleIds, []);
  assert.equal(setup.sentMessages.length, 0);
  assert.equal(setup.dms.length, 0);
});

test("keeps an FG role an authorised sharer gives to someone else", async () => {
  const setup = createSetup({
    protectedRoleIds: [],
    fgRoleId: FG_ROLE_ID,
    fgRoleOwnerId: FG_OWNER_ID,
    fgRoleSharers: [ALLOWED_ACTOR_ID],
  });

  await guardAuditLogEntry(
    createEntry("audit-fg-sharer", ALLOWED_ACTOR_ID, NOW, {
      roleId: FG_ROLE_ID,
    }),
    setup.guild,
    createStore(setup.settings),
  );

  assert.deepEqual(setup.removedRoleIds, []);
  assert.equal(setup.sentMessages.length, 0);
  assert.equal(setup.dms.length, 0);
});

test("flags a repeat offender on the third unauthorised FG self-grant", async () => {
  clearOffenses();
  const setup = createSetup({
    protectedRoleIds: [],
    fgRoleId: FG_ROLE_ID,
    fgRoleOwnerId: FG_OWNER_ID,
  });

  for (let i = 1; i <= 3; i += 1) {
    await guardAuditLogEntry(
      createEntry(`audit-fg-repeat-${i}`, REPEAT_ACTOR_ID, NOW, {
        roleId: FG_ROLE_ID,
        targetId: REPEAT_ACTOR_ID,
      }),
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
});

test("tells the giver when the bot could not remove a watched role", async () => {
  clearOffenses();
  const setup = createSetup({ botAboveRole: false });

  await guardAuditLogEntry(
    createEntry("audit-remove-failed", UNAPPROVED_ACTOR_ID),
    setup.guild,
    createStore(setup.settings),
  );

  assert.deepEqual(setup.removedRoleIds, []);
  const embed = getLoggedEmbed(setup);
  assert.match(
    embed.fields?.find((field) => field.name === "Action needed")?.value ?? "",
    /cannot manage one or more watched roles/i,
  );
  // Exactly one DM, and it says the removal failed — never "Role removed".
  assert.equal(setup.dms.length, 1);
  const dm = getDmEmbed(setup);
  assert.equal(dm.title, "Role could not be removed");
  assert.match(
    dm.fields?.find((field) => field.name === "Action needed")?.value ?? "",
    /cannot manage one or more watched roles/i,
  );
});

test("reverts an FG role self-grant when the cached member still shows Administrator but a fresh fetch does not", async () => {
  clearOffenses();
  // The reported live bug: the account had Administrator when the bot
  // cached it, then lost Administrator. A plain fetch returns the stale
  // cached member, so the old guard let the grant stand. The guard must
  // fetch fresh and revert.
  const setup = createSetup({
    protectedRoleIds: [],
    fgRoleId: FG_ROLE_ID,
    fgRoleOwnerId: FG_OWNER_ID,
    actorCachedIsAdmin: true,
    actorIsAdmin: false,
    actorHasManageRoles: true,
  });

  await guardAuditLogEntry(
    createEntry("audit-stale-admin", UNAPPROVED_ACTOR_ID, NOW, {
      roleId: FG_ROLE_ID,
      targetId: UNAPPROVED_ACTOR_ID,
    }),
    setup.guild,
    createStore(setup.settings),
  );

  assert.deepEqual(setup.removedRoleIds, [[FG_ROLE_ID]]);
  assert.equal(setup.dms.length, 1);
  assert.equal(setup.sentMessages.length, 1);
  // The authorisation fetch went to the API (force), it did not trust
  // the cache — that is what makes the stale Administrator invisible.
  assert.ok(
    setup.memberFetchCalls.some(
      (call) => call.user === UNAPPROVED_ACTOR_ID && call.force,
    ),
    "expected a force fetch of the actor",
  );
});

test("does nothing when the target no longer holds the watched role", async () => {
  clearOffenses();
  const setup = createSetup({ targetHoldsRole: false });

  await guardAuditLogEntry(
    createEntry("audit-already-gone", UNAPPROVED_ACTOR_ID),
    setup.guild,
    createStore(setup.settings),
  );

  assert.deepEqual(setup.removedRoleIds, []);
  assert.equal(setup.dms.length, 0);
  assert.equal(setup.sentMessages.length, 0);
  assert.equal(getOffenseCount(GUILD_ID, UNAPPROVED_ACTOR_ID), 0);
});

test("sweepMissedGrants re-checks recent entries and skips old ones", async () => {
  clearOffenses();
  const recent = createEntry("audit-recent", UNAPPROVED_ACTOR_ID, NOW, {
    roleId: ROLE_ID,
  });
  const old = createEntry("audit-old", UNAPPROVED_ACTOR_ID, NOW - 11 * 60 * 1000, {
    roleId: ROLE_ID,
  });
  const setup = createSetup({
    fetchAuditLogs: async () => ({
      entries: new Map([
        ["audit-recent", recent],
        ["audit-old", old],
      ]),
    }),
  });

  await sweepMissedGrants(setup.guild, createStore(setup.settings), NOW);

  // Only the recent grant was re-checked and removed.
  assert.deepEqual(setup.removedRoleIds, [[ROLE_ID]]);
  assert.equal(setup.sentMessages.length, 1);
});

test("sweepMissedGrants never throws when the audit log cannot be read", async () => {
  const setup = createSetup({
    fetchAuditLogs: async () => {
      throw new Error("no audit log access");
    },
  });
  await sweepMissedGrants(setup.guild, createStore(setup.settings), NOW);
  assert.deepEqual(setup.removedRoleIds, []);

  const noFetchSetup = createSetup();
  await sweepMissedGrants(
    { ...noFetchSetup.guild, fetchAuditLogs: undefined } as unknown as Guild,
    createStore(noFetchSetup.settings),
    NOW,
  );
  assert.deepEqual(noFetchSetup.removedRoleIds, []);
});

test("parseAuditReasonRequester pulls the requester out of Bleed and Greed audit reasons", () => {
  // Bleed: username only, or a bare ID.
  assert.deepEqual(parseAuditReasonRequester("added role by weak3"), {
    id: null,
    username: "weak3",
    matched: "added role by weak3",
  });
  assert.deepEqual(parseAuditReasonRequester("Added Role By Weak3"), {
    id: null,
    username: "Weak3",
    matched: "Added Role By Weak3",
  });
  assert.deepEqual(
    parseAuditReasonRequester("added role by 141414141414141414"),
    {
      id: "141414141414141414",
      username: null,
      matched: "added role by 141414141414141414",
    },
  );
  assert.deepEqual(
    parseAuditReasonRequester("added role by weak3, via booster"),
    { id: null, username: "weak3", matched: "added role by weak3" },
  );
  assert.deepEqual(parseAuditReasonRequester("added role by weak3#1234"), {
    id: null,
    username: "weak3",
    matched: "added role by weak3#1234",
  });
  // Greed: username plus the user ID in parentheses — the ID is
  // authoritative, the name is the fallback.
  assert.deepEqual(
    parseAuditReasonRequester("Role update by 1umk (763299524789141525)"),
    {
      id: "763299524789141525",
      username: "1umk",
      matched: "Role update by 1umk (763299524789141525)",
    },
  );
  assert.deepEqual(
    parseAuditReasonRequester("ROLE UPDATE BY 1umk (763299524789141525)"),
    {
      id: "763299524789141525",
      username: "1umk",
      matched: "ROLE UPDATE BY 1umk (763299524789141525)",
    },
  );
  assert.deepEqual(parseAuditReasonRequester("Role update by 1umk"), {
    id: null,
    username: "1umk",
    matched: "Role update by 1umk",
  });
  assert.equal(parseAuditReasonRequester("something else entirely"), null);
  assert.equal(parseAuditReasonRequester("added role by"), null);
  assert.equal(parseAuditReasonRequester("role update by"), null);
  assert.equal(parseAuditReasonRequester(null), null);
  assert.equal(parseAuditReasonRequester(""), null);
});

test("allows a Bleed grant when the audit reason names a whitelisted requester", async () => {
  // Bleed is the audit executor, but its reason names weak3 — and
  // weak3 is whitelisted, so the grant stands. The bot itself is never
  // treated as authorised just for being the executor.
  const setup = createSetup({
    protectedRoleIds: [],
    fgRoleId: FG_ROLE_ID,
    fgRoleOwnerId: FG_OWNER_ID,
    allowedUserIds: [WEAK3_ID],
    usernameMembers: [{ id: WEAK3_ID, username: "weak3" }],
  });

  await guardAuditLogEntry(
    createEntry("audit-bleed-allowed", BLEED_BOT_ID, NOW, {
      roleId: FG_ROLE_ID,
      reason: "added role by weak3",
    }),
    setup.guild,
    createStore(setup.settings),
  );

  assert.deepEqual(setup.removedRoleIds, []);
  // The grant stands, and because weak3 is whitelisted it is logged as
  // an authorised assignment — naming weak3, noting it came via Bleed.
  assertAuthorizedLog(setup, FG_ROLE_ID, WEAK3_ID, "via bleed");
  assert.equal(getOffenseCount(GUILD_ID, BLEED_BOT_ID), 0);
  assert.equal(getOffenseCount(GUILD_ID, WEAK3_ID), 0);
});

test("removes a Bleed grant when the audit reason names an unauthorised requester", async () => {
  clearOffenses();
  const setup = createSetup({
    protectedRoleIds: [],
    fgRoleId: FG_ROLE_ID,
    fgRoleOwnerId: FG_OWNER_ID,
    usernameMembers: [{ id: WEAK3_ID, username: "weak3" }],
  });

  await guardAuditLogEntry(
    createEntry("audit-bleed-denied", BLEED_BOT_ID, NOW, {
      roleId: FG_ROLE_ID,
      reason: "added role by weak3",
    }),
    setup.guild,
    createStore(setup.settings),
  );

  assert.deepEqual(setup.removedRoleIds, [[FG_ROLE_ID]]);
  assert.equal(setup.sentMessages.length, 1);
  const embed = getLoggedEmbed(setup);
  assert.equal(embed.title, "Unauthorized role assignment");
  assert.equal(
    embed.fields?.find((field) => field.name === "Assigned by")?.value,
    `<@${WEAK3_ID}>`,
  );
  assert.equal(
    embed.fields?.find((field) => field.name === "Attribution")?.value,
    "Audit reason: added role by weak3",
  );
  // The DM goes to weak3, the human — never to the Bleed bot.
  assert.equal(setup.dms.length, 1);
  assert.equal(getDmEmbed(setup).title, "Role removed");
  assert.equal(getOffenseCount(GUILD_ID, WEAK3_ID), 1);
  assert.equal(getOffenseCount(GUILD_ID, BLEED_BOT_ID), 0);
});

test("removes a Bleed grant of a protected role when the audit reason names an unauthorised requester", async () => {
  // The reason attribution covers protected roles too, not just FG
  // roles — the screenshot that proved this showed "pic perms".
  clearOffenses();
  const setup = createSetup({
    usernameMembers: [{ id: WEAK3_ID, username: "weak3" }],
  });

  await guardAuditLogEntry(
    createEntry("audit-bleed-protected", BLEED_BOT_ID, NOW, {
      roleId: ROLE_ID,
      reason: "added role by weak3",
    }),
    setup.guild,
    createStore(setup.settings),
  );

  assert.deepEqual(setup.removedRoleIds, [[ROLE_ID]]);
  assert.equal(setup.sentMessages.length, 1);
  const embed = getLoggedEmbed(setup);
  assert.equal(
    embed.fields?.find((field) => field.name === "Assigned by")?.value,
    `<@${WEAK3_ID}>`,
  );
  assert.equal(
    embed.fields?.find((field) => field.name === "Attribution")?.value,
    "Audit reason: added role by weak3",
  );
  assert.equal(setup.dms.length, 1);
  assert.equal(getDmEmbed(setup).title, "Role removed");
  assert.equal(getOffenseCount(GUILD_ID, WEAK3_ID), 1);
});

test("falls back to the FG role owner when a Bleed grant has no audit reason", async () => {
  // No reason to parse, so the grant is attributed to the FG role's
  // owner — who is authorised for their own role, so it stands.
  const setup = createSetup({
    protectedRoleIds: [],
    fgRoleId: FG_ROLE_ID,
    fgRoleOwnerId: FG_OWNER_ID,
    usernameMembers: [{ id: WEAK3_ID, username: "weak3" }],
  });

  await guardAuditLogEntry(
    createEntry("audit-bleed-no-reason", BLEED_BOT_ID, NOW, {
      roleId: FG_ROLE_ID,
    }),
    setup.guild,
    createStore(setup.settings),
  );

  assert.deepEqual(setup.removedRoleIds, []);
  assert.equal(setup.sentMessages.length, 0);
  assert.equal(setup.dms.length, 0);
});

test("removes a Bleed grant with an unresolvable requester and no FG owner to fall back to", async () => {
  clearOffenses();
  const setup = createSetup({
    usernameMembers: [{ id: WEAK3_ID, username: "weak3" }],
  });

  await guardAuditLogEntry(
    createEntry("audit-bleed-unknown", BLEED_BOT_ID, NOW, {
      roleId: ROLE_ID,
      reason: "added role by ghostuser",
    }),
    setup.guild,
    createStore(setup.settings),
  );

  assert.deepEqual(setup.removedRoleIds, [[ROLE_ID]]);
  assert.equal(setup.sentMessages.length, 1);
  const embed = getLoggedEmbed(setup);
  // No human could be attributed, so the log names the executor
  // (Bleed) and says so — and nobody is DM'd.
  assert.equal(
    embed.fields?.find((field) => field.name === "Assigned by")?.value,
    `<@${BLEED_BOT_ID}>`,
  );
  assert.equal(
    embed.fields?.find((field) => field.name === "Attribution")?.value,
    "No requester found in the audit reason",
  );
  assert.equal(setup.dms.length, 0);
  assert.equal(getOffenseCount(GUILD_ID, BLEED_BOT_ID), 0);
  assert.equal(getOffenseCount(GUILD_ID, WEAK3_ID), 0);
});

test("resolves a user ID in the audit reason to the requester", async () => {
  const setup = createSetup({
    protectedRoleIds: [],
    fgRoleId: FG_ROLE_ID,
    fgRoleOwnerId: FG_OWNER_ID,
    allowedUserIds: [WEAK3_ID],
    usernameMembers: [{ id: WEAK3_ID, username: "weak3" }],
  });

  await guardAuditLogEntry(
    createEntry("audit-bleed-by-id", BLEED_BOT_ID, NOW, {
      roleId: FG_ROLE_ID,
      reason: `added role by ${WEAK3_ID}`,
    }),
    setup.guild,
    createStore(setup.settings),
  );

  assert.deepEqual(setup.removedRoleIds, []);
  assertAuthorizedLog(setup, FG_ROLE_ID, WEAK3_ID, "via bleed");
});

test("allows a Greed grant when the audit reason names a whitelisted requester by ID", async () => {
  // Greed is the audit executor, but its reason names 1umk by ID —
  // and 1umk is whitelisted, so the grant stands.
  const setup = createSetup({
    allowedUserIds: [ONEUMK_ID],
    usernameMembers: [{ id: ONEUMK_ID, username: "1umk" }],
  });

  await guardAuditLogEntry(
    createEntry("audit-greed-allowed", GREED_BOT_ID, NOW, {
      roleId: ROLE_ID,
      reason: "Role update by 1umk (763299524789141525)",
    }),
    setup.guild,
    createStore(setup.settings),
  );

  assert.deepEqual(setup.removedRoleIds, []);
  // The grant stands, and because 1umk is whitelisted it is logged as
  // an authorised assignment — naming 1umk, noting it came via Greed.
  assertAuthorizedLog(setup, ROLE_ID, ONEUMK_ID, "via greed");
  assert.equal(getOffenseCount(GUILD_ID, GREED_BOT_ID), 0);
  assert.equal(getOffenseCount(GUILD_ID, ONEUMK_ID), 0);
});

test("removes a Greed grant when the audit reason's ID names an unauthorised requester, even if the username matches someone else", async () => {
  // The ID in the reason belongs to "differentname"; a different
  // member holds the username "1umk". The ID is authoritative, so the
  // grant is attributed to the ID holder — never the namesake, never
  // Greed itself.
  clearOffenses();
  const setup = createSetup({
    usernameMembers: [
      { id: ONEUMK_ID, username: "differentname" },
      { id: ONEUMK_NAME_ID, username: "1umk" },
    ],
  });

  await guardAuditLogEntry(
    createEntry("audit-greed-id-wins", GREED_BOT_ID, NOW, {
      roleId: ROLE_ID,
      reason: "Role update by 1umk (763299524789141525)",
    }),
    setup.guild,
    createStore(setup.settings),
  );

  assert.deepEqual(setup.removedRoleIds, [[ROLE_ID]]);
  assert.equal(setup.sentMessages.length, 1);
  const embed = getLoggedEmbed(setup);
  assert.equal(
    embed.fields?.find((field) => field.name === "Assigned by")?.value,
    `<@${ONEUMK_ID}>`,
  );
  assert.equal(
    embed.fields?.find((field) => field.name === "Attribution")?.value,
    "Audit reason: Role update by 1umk (763299524789141525)",
  );
  // The DM goes to the ID holder, the human — never to the Greed bot.
  assert.equal(setup.dms.length, 1);
  assert.equal(getDmEmbed(setup).title, "Role removed");
  assert.equal(getOffenseCount(GUILD_ID, ONEUMK_ID), 1);
  assert.equal(getOffenseCount(GUILD_ID, ONEUMK_NAME_ID), 0);
  assert.equal(getOffenseCount(GUILD_ID, GREED_BOT_ID), 0);
});

test("resolves a Greed reason without an ID by username", async () => {
  // Greed's reason sometimes carries no parenthesised ID — then the
  // username is the only attribution available.
  clearOffenses();
  const setup = createSetup({
    usernameMembers: [{ id: ONEUMK_NAME_ID, username: "1umk" }],
  });

  await guardAuditLogEntry(
    createEntry("audit-greed-no-id", GREED_BOT_ID, NOW, {
      roleId: ROLE_ID,
      reason: "Role update by 1umk",
    }),
    setup.guild,
    createStore(setup.settings),
  );

  assert.deepEqual(setup.removedRoleIds, [[ROLE_ID]]);
  assert.equal(setup.sentMessages.length, 1);
  const embed = getLoggedEmbed(setup);
  assert.equal(
    embed.fields?.find((field) => field.name === "Assigned by")?.value,
    `<@${ONEUMK_NAME_ID}>`,
  );
  assert.equal(
    embed.fields?.find((field) => field.name === "Attribution")?.value,
    "Audit reason: Role update by 1umk",
  );
  assert.equal(setup.dms.length, 1);
  assert.equal(getDmEmbed(setup).title, "Role removed");
  assert.equal(getOffenseCount(GUILD_ID, ONEUMK_NAME_ID), 1);
  assert.equal(getOffenseCount(GUILD_ID, GREED_BOT_ID), 0);
});

test("falls back to the username in a Greed reason when the ID in it does not resolve", async () => {
  // The parenthesised ID belongs to nobody in the guild, so the
  // username in the same reason is tried next — and it resolves.
  clearOffenses();
  const setup = createSetup({
    unresolvableUserIds: [ONEUMK_ID],
    usernameMembers: [{ id: ONEUMK_NAME_ID, username: "1umk" }],
  });

  await guardAuditLogEntry(
    createEntry("audit-greed-id-unresolvable", GREED_BOT_ID, NOW, {
      roleId: ROLE_ID,
      reason: "Role update by 1umk (763299524789141525)",
    }),
    setup.guild,
    createStore(setup.settings),
  );

  assert.deepEqual(setup.removedRoleIds, [[ROLE_ID]]);
  assert.equal(setup.sentMessages.length, 1);
  const embed = getLoggedEmbed(setup);
  assert.equal(
    embed.fields?.find((field) => field.name === "Assigned by")?.value,
    `<@${ONEUMK_NAME_ID}>`,
  );
  assert.equal(
    embed.fields?.find((field) => field.name === "Attribution")?.value,
    "Audit reason: Role update by 1umk (763299524789141525)",
  );
  assert.equal(setup.dms.length, 1);
  assert.equal(getDmEmbed(setup).title, "Role removed");
  assert.equal(getOffenseCount(GUILD_ID, ONEUMK_NAME_ID), 1);
  assert.equal(getOffenseCount(GUILD_ID, GREED_BOT_ID), 0);
});

test("removes a Greed grant when neither the ID nor the username in the reason resolves", async () => {
  // Neither the parenthesised ID nor the username matches anyone,
  // and this is a protected role with no FG owner to fall back to —
  // so the role is removed and logged, and nobody is DM'd.
  clearOffenses();
  const setup = createSetup({
    unresolvableUserIds: [ONEUMK_ID],
    usernameMembers: [{ id: ONEUMK_NAME_ID, username: "someoneelse" }],
  });

  await guardAuditLogEntry(
    createEntry("audit-greed-unresolvable", GREED_BOT_ID, NOW, {
      roleId: ROLE_ID,
      reason: "Role update by 1umk (763299524789141525)",
    }),
    setup.guild,
    createStore(setup.settings),
  );

  assert.deepEqual(setup.removedRoleIds, [[ROLE_ID]]);
  assert.equal(setup.sentMessages.length, 1);
  const embed = getLoggedEmbed(setup);
  assert.equal(
    embed.fields?.find((field) => field.name === "Assigned by")?.value,
    `<@${GREED_BOT_ID}>`,
  );
  assert.equal(
    embed.fields?.find((field) => field.name === "Attribution")?.value,
    "No requester found in the audit reason",
  );
  assert.equal(setup.dms.length, 0);
  assert.equal(getOffenseCount(GUILD_ID, GREED_BOT_ID), 0);
  assert.equal(getOffenseCount(GUILD_ID, ONEUMK_NAME_ID), 0);
});

test("a whitelisted grant with no log channel set is allowed and sends nothing", async () => {
  // Same skip-silently behaviour as the unauthorised logs: sendLog
  // returns early when logChannelId is not set, and the grant stands.
  const setup = createSetup({
    allowedUserIds: [ALLOWED_ACTOR_ID],
    logChannelId: null,
  });

  await guardAuditLogEntry(
    createEntry("audit-allowed-no-log", ALLOWED_ACTOR_ID),
    setup.guild,
    createStore(setup.settings),
  );

  assert.deepEqual(setup.removedRoleIds, []);
  assert.equal(setup.sentMessages.length, 0);
  assert.equal(setup.dms.length, 0);
  assert.equal(getOffenseCount(GUILD_ID, ALLOWED_ACTOR_ID), 0);
});

test("stays silent when a whitelisted FG owner shares their own FG role", async () => {
  // The FG-owner rule wins over the whitelist for that role: an owner
  // sharing their own role is a normal FG share, not a whitelist
  // grant to log — even when the owner is also whitelisted.
  const setup = createSetup({
    protectedRoleIds: [],
    fgRoleId: FG_ROLE_ID,
    fgRoleOwnerId: ALLOWED_ACTOR_ID,
    allowedUserIds: [ALLOWED_ACTOR_ID],
  });

  await guardAuditLogEntry(
    createEntry("audit-fg-owner-whitelisted", ALLOWED_ACTOR_ID, NOW, {
      roleId: FG_ROLE_ID,
      targetId: ALLOWED_ACTOR_ID,
    }),
    setup.guild,
    createStore(setup.settings),
  );

  assert.deepEqual(setup.removedRoleIds, []);
  assert.equal(setup.sentMessages.length, 0);
  assert.equal(setup.dms.length, 0);
});

test("stays silent when a whitelisted Administrator grants a protected role", async () => {
  // The Administrator rule wins over the whitelist: admin grants stay
  // silent even when the admin is also whitelisted by user ID.
  const setup = createSetup({
    allowedUserIds: [UNAPPROVED_ACTOR_ID],
    actorIsAdmin: true,
  });

  await guardAuditLogEntry(
    createEntry("audit-admin-whitelisted", UNAPPROVED_ACTOR_ID),
    setup.guild,
    createStore(setup.settings),
  );

  assert.deepEqual(setup.removedRoleIds, []);
  assert.equal(setup.sentMessages.length, 0);
  assert.equal(setup.dms.length, 0);
});

test("stays silent when a whitelisted authorised sharer shares an FG role", async () => {
  // The sharer rule wins over the whitelist for that role: a sharer
  // sharing a role they are authed for is a normal share, not a
  // whitelist grant to log — even when the sharer is also whitelisted.
  const setup = createSetup({
    protectedRoleIds: [],
    fgRoleId: FG_ROLE_ID,
    fgRoleOwnerId: FG_OWNER_ID,
    fgRoleSharers: [ALLOWED_ACTOR_ID],
    allowedUserIds: [ALLOWED_ACTOR_ID],
  });

  await guardAuditLogEntry(
    createEntry("audit-fg-sharer-whitelisted", ALLOWED_ACTOR_ID, NOW, {
      roleId: FG_ROLE_ID,
    }),
    setup.guild,
    createStore(setup.settings),
  );

  assert.deepEqual(setup.removedRoleIds, []);
  assert.equal(setup.sentMessages.length, 0);
  assert.equal(setup.dms.length, 0);
});

test("an unauthorised grant produces exactly one unauthorised log and no authorised one", async () => {
  // No double logging: a removed grant gets the unauthorised entry
  // only — never an authorised entry as well.
  clearOffenses();
  const setup = createSetup();

  await guardAuditLogEntry(
    createEntry("audit-no-double-log", UNAPPROVED_ACTOR_ID),
    setup.guild,
    createStore(setup.settings),
  );

  assert.deepEqual(setup.removedRoleIds, [[ROLE_ID]]);
  assert.equal(setup.sentMessages.length, 1);
  const embed = getLoggedEmbed(setup);
  assert.equal(embed.title, "Unauthorized role assignment");
  assert.equal(setup.dms.length, 1);
});
