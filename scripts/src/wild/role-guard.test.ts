import assert from "node:assert/strict";
import test from "node:test";
import {
  AuditLogEvent,
  EmbedBuilder,
  Guild,
  GuildAuditLogsEntry,
  PermissionFlagsBits,
} from "discord.js";
import { ConfigStore, GuildSettings } from "./config-store.js";
import { guardAuditLogEntry } from "./role-guard.js";

const GUILD_ID = "111111111111111111";
const MEMBER_ID = "222222222222222222";
const ROLE_ID = "333333333333333333";
const ALLOWED_ACTOR_ID = "444444444444444444";
const UNAPPROVED_ACTOR_ID = "555555555555555555";

interface SentMessage {
  embeds: EmbedBuilder[];
}

interface GuardSetup {
  guild: Guild;
  settings: GuildSettings;
  removedRoleIds: string[][];
  sentMessages: SentMessage[];
  memberFetchCount: number;
}

function createSetup(
  options: {
    allowedUserIds?: string[];
    hasManageRoles?: boolean;
    botAboveRole?: boolean;
  } = {},
): GuardSetup {
  const settings: GuildSettings = {
    protectedRoleIds: [ROLE_ID],
    allowedUserIds: options.allowedUserIds ?? [],
    logChannelId: "666666666666666666",
  };
  const removedRoleIds: string[][] = [];
  const sentMessages: SentMessage[] = [];
  let memberFetchCount = 0;

  const member = {
    id: MEMBER_ID,
    roles: {
      remove: async (roleIds: string[]) => {
        removedRoleIds.push(roleIds);
      },
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
    channels: {
      fetch: async () => channel,
    },
    members: {
      me: botMember,
      fetch: async () => {
        memberFetchCount += 1;
        return member;
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
): GuildAuditLogsEntry {
  return {
    id,
    action: AuditLogEvent.MemberRoleUpdate,
    targetId: MEMBER_ID,
    executorId,
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

test("keeps watched roles assigned by an allowlisted actor", async () => {
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
    "Wild could not verify the assigner.",
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
