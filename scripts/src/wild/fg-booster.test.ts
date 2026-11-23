import assert from "node:assert/strict";
import test from "node:test";
import {
  ChatInputCommandInteraction,
  EmbedBuilder,
  PermissionFlagsBits,
} from "discord.js";
import { ConfigStore, GuildSettings } from "./config-store.js";
import { handleFgCommand, parseFgColor } from "./fg-booster.js";

const GUILD_ID = "111111111111111111";
const OWNER_ID = "999999999999999999";
const MEMBER_ID = "222222222222222222";
const OTHER_ID = "333333333333333333";
const BASE_ROLE_ID = "444444444444444444";
const FG_ROLE_ID = "555555555555555555";
const AWARD_ROLE_ID = "666666666666666666";

interface Reply {
  content?: string;
  embeds?: EmbedBuilder[];
  ephemeral?: boolean;
}

function makeSettings(partial: Partial<GuildSettings> = {}): GuildSettings {
  return {
    protectedRoleIds: [],
    allowedUserIds: [],
    allowedRoleIds: [],
    fgStaffUserIds: [],
    fgStaffRoleIds: [],
    fgRoles: {},
    fgBaseRoleId: null,
    fgAwardRoleId: null,
    fgRoleOwners: {},
    blacklist: {},
    logChannelId: null,
    enforcementEnabled: true,
    ...partial,
  };
}

function createStore(initialSettings: GuildSettings = makeSettings()) {
  let settings = initialSettings;
  let saveCount = 0;
  const store = {
    get: () => JSON.parse(JSON.stringify(settings)) as GuildSettings,
    set: async (guildId: string, nextSettings: GuildSettings) => {
      assert.equal(guildId, GUILD_ID);
      settings = JSON.parse(JSON.stringify(nextSettings)) as GuildSettings;
      saveCount += 1;
    },
  } as unknown as ConfigStore;

  return { store, getSettings: () => settings, getSaveCount: () => saveCount };
}

interface MockRole {
  id: string;
  name: string;
  position: number;
  managed: boolean;
  permissions: { has: (permission: bigint) => boolean };
  color?: string;
  icon?: string | null;
  unicodeEmoji?: string | null;
  deleted: boolean;
  setName: (name: string) => Promise<MockRole>;
  setIcon: (icon: string) => Promise<MockRole>;
  setUnicodeEmoji: (emoji: string) => Promise<MockRole>;
  delete: () => Promise<void>;
}

function makeRole(id: string, name = "Role", position = 5): MockRole {
  const role = {
    id,
    name,
    position,
    managed: false,
    permissions: { has: () => false },
    deleted: false,
    setName: async (newName: string) => {
      role.name = newName;
      return role;
    },
    setIcon: async (icon: string) => {
      role.icon = icon;
      return role;
    },
    setUnicodeEmoji: async (emoji: string) => {
      role.unicodeEmoji = emoji;
      return role;
    },
    delete: async () => {
      role.deleted = true;
    },
  } as MockRole;
  return role;
}

function createGuild(options: {
  roles?: MockRole[];
  memberRoleIds?: Record<string, string[]>;
  missingMemberIds?: string[];
  premiumTier?: number;
  botAboveBase?: boolean;
}) {
  const rolesCache = new Map<string, MockRole>(
    (options.roles ?? []).map((role) => [role.id, role]),
  );
  const createdRoles: Array<Record<string, unknown>> = [];
  let nextRoleId = 1000;
  const botMember = {
    permissions: { has: () => true },
    roles: {
      highest: {
        comparePositionTo: (role: MockRole) =>
          options.botAboveBase === false ? -1 : 1,
      },
    },
  };
  const members = new Map<string, Record<string, unknown>>();
  const getMember = (memberId: string) => {
    if ((options.missingMemberIds ?? []).includes(memberId)) return null;
    if (!members.has(memberId)) {
      const held = new Set(options.memberRoleIds?.[memberId] ?? []);
      members.set(memberId, {
        id: memberId,
        roles: {
          cache: {
            has: (roleId: string) => held.has(roleId),
            some: (predicate: (role: { id: string }) => boolean) =>
              [...held].some((roleId) => predicate({ id: roleId })),
          },
          add: async (role: MockRole) => {
            held.add(role.id);
          },
        },
      });
    }
    return members.get(memberId)!;
  };
  const guild = {
    id: GUILD_ID,
    ownerId: OWNER_ID,
    premiumTier: options.premiumTier ?? 0,
    members: {
      me: botMember,
      fetch: async (memberId: string) => getMember(memberId),
      fetchMe: async () => botMember,
    },
    roles: {
      cache: rolesCache,
      create: async (createOptions: Record<string, unknown>) => {
        createdRoles.push(createOptions);
        const role = makeRole(
          String(100000000000000000 + nextRoleId++),
          createOptions.name as string,
          typeof createOptions.position === "number"
            ? (createOptions.position as number)
            : 5,
        );
        role.color = createOptions.color as string;
        rolesCache.set(role.id, role);
        return role;
      },
    },
  };
  return { guild, createdRoles, getMember };
}

function createInteraction(options: {
  group?: string | null;
  action: string;
  userId?: string;
  canManageServer?: boolean;
  roleId?: string;
  memberId?: string;
  strings?: Record<string, string>;
}) {
  const replies: Reply[] = [];
  const interaction = {
    commandName: "fg",
    guildId: GUILD_ID,
    user: { id: options.userId ?? MEMBER_ID },
    memberPermissions: {
      has: (permission: bigint) =>
        permission === PermissionFlagsBits.ManageGuild &&
        (options.canManageServer ?? true),
    },
    options: {
      getSubcommandGroup: () => options.group ?? null,
      getSubcommand: () => options.action,
      getRole: (_name: string, _required?: boolean) =>
        options.roleId ? { id: options.roleId } : null,
      getUser: (_name: string, _required?: boolean) =>
        options.memberId ? { id: options.memberId } : null,
      getString: (name: string, _required?: boolean) =>
        options.strings?.[name] ?? null,
    },
    reply: async (reply: Reply) => {
      replies.push(reply);
    },
  } as unknown as ChatInputCommandInteraction;
  return { interaction, replies };
}

function withGuild(
  guild: Record<string, unknown>,
  interaction: ChatInputCommandInteraction,
) {
  (interaction as unknown as { guild: unknown }).guild = guild;
  return interaction;
}

test("parseFgColor accepts hex, short hex, and colour names", () => {
  assert.equal(parseFgColor("#ff0000"), "#ff0000");
  assert.equal(parseFgColor("ff0000"), "#ff0000");
  assert.equal(parseFgColor("#f00"), "#ff0000");
  assert.equal(parseFgColor("blue"), "#0000ff");
  assert.equal(parseFgColor("grey"), "#808080");
  assert.equal(parseFgColor("not-a-colour"), null);
  assert.equal(parseFgColor("#gggggg"), null);
});

test("/fg base sets the base role for Manage Server members", async () => {
  const config = createStore();
  const { guild } = createGuild({
    roles: [makeRole(BASE_ROLE_ID, "FG Base", 10)],
  });
  const { interaction, replies } = createInteraction({
    action: "base",
    roleId: BASE_ROLE_ID,
  });

  await handleFgCommand(withGuild(guild, interaction), config.store);

  assert.equal(config.getSettings().fgBaseRoleId, BASE_ROLE_ID);
  assert.equal(replies[0].ephemeral, true);
  assert.match(replies[0].content ?? "", /base role/i);
});

test("/fg base without Manage Server is rejected", async () => {
  const config = createStore();
  const { guild } = createGuild({
    roles: [makeRole(BASE_ROLE_ID, "FG Base", 10)],
  });
  const { interaction, replies } = createInteraction({
    action: "base",
    roleId: BASE_ROLE_ID,
    canManageServer: false,
  });

  await handleFgCommand(withGuild(guild, interaction), config.store);

  assert.equal(config.getSettings().fgBaseRoleId, null);
  assert.match(replies[0].content ?? "", /Manage Server/i);
});

test("/fg color creates an owned FG role under the base with no permissions", async () => {
  const config = createStore(
    makeSettings({
      allowedUserIds: [MEMBER_ID],
      fgBaseRoleId: BASE_ROLE_ID,
      fgAwardRoleId: AWARD_ROLE_ID,
    }),
  );
  const { guild, createdRoles, getMember } = createGuild({
    roles: [
      makeRole(BASE_ROLE_ID, "FG Base", 10),
      makeRole(AWARD_ROLE_ID, "Award", 3),
    ],
    memberRoleIds: { [MEMBER_ID]: [] },
  });
  const { interaction, replies } = createInteraction({
    action: "color",
    strings: { color: "#ff0000", name: "My FG" },
  });

  await handleFgCommand(withGuild(guild, interaction), config.store);

  assert.equal(createdRoles.length, 1);
  // FG roles are created with no permissions.
  assert.deepEqual(createdRoles[0].permissions, []);
  assert.equal(createdRoles[0].position, 9);
  const settings = config.getSettings();
  const createdRoleId = Object.keys(settings.fgRoleOwners)[0];
  assert.equal(settings.fgRoleOwners[createdRoleId], MEMBER_ID);
  assert.ok(settings.protectedRoleIds.includes(createdRoleId));
  assert.ok(settings.fgRoles[createdRoleId]);
  assert.equal(replies[0].ephemeral, true);
  assert.match(replies[0].content ?? "", /is your FG role now/i);
  // Wild adaptation: the award role is granted on FG creation.
  assert.equal(
    (getMember(MEMBER_ID)!.roles as { cache: { has: (id: string) => boolean } }).cache.has(AWARD_ROLE_ID),
    true,
  );
});

test("/fg color rejects a second FG role for the same member", async () => {
  const config = createStore(
    makeSettings({
      allowedUserIds: [MEMBER_ID],
      fgRoleOwners: { [FG_ROLE_ID]: MEMBER_ID },
      fgRoles: {
        [FG_ROLE_ID]: {
          assignUserIds: [],
          assignRoleIds: [],
          shareUserIds: [],
          shareRoleIds: [],
        },
      },
    }),
  );
  const { guild, createdRoles } = createGuild({
    roles: [makeRole(FG_ROLE_ID, "Old FG", 9)],
  });
  const { interaction, replies } = createInteraction({
    action: "color",
    strings: { color: "blue", name: "Second FG" },
  });

  await handleFgCommand(withGuild(guild, interaction), config.store);

  assert.equal(createdRoles.length, 0);
  assert.match(replies[0].content ?? "", /already have an FG role/i);
});

test("/fg color rejects non-whitelisted members", async () => {
  const config = createStore();
  const { guild, createdRoles } = createGuild({ roles: [] });
  const { interaction, replies } = createInteraction({
    action: "color",
    strings: { color: "blue", name: "Nope" },
  });

  await handleFgCommand(withGuild(guild, interaction), config.store);

  assert.equal(createdRoles.length, 0);
  assert.match(replies[0].content ?? "", /whitelisted/i);
});

test("/fg rename only works on your own FG role", async () => {
  const config = createStore(
    makeSettings({ fgRoleOwners: { [FG_ROLE_ID]: MEMBER_ID } }),
  );
  const fgRole = makeRole(FG_ROLE_ID, "Old Name", 9);
  const { guild } = createGuild({ roles: [fgRole] });
  const { interaction, replies } = createInteraction({
    action: "rename",
    strings: { name: "New Name" },
  });

  await handleFgCommand(withGuild(guild, interaction), config.store);

  assert.equal(fgRole.name, "New Name");
  assert.match(replies[0].content ?? "", /now called/i);

  const other = createInteraction({
    action: "rename",
    userId: OTHER_ID,
    strings: { name: "Steal" },
  });
  await handleFgCommand(withGuild(guild, other.interaction), config.store);

  assert.equal(fgRole.name, "New Name");
  assert.match(other.replies[0].content ?? "", /don't have an FG role/i);
});

test("/fg icon sets a custom emoji icon", async () => {
  const config = createStore(
    makeSettings({ fgRoleOwners: { [FG_ROLE_ID]: MEMBER_ID } }),
  );
  const fgRole = makeRole(FG_ROLE_ID, "My FG", 9);
  const { guild } = createGuild({ roles: [fgRole] });
  const { interaction, replies } = createInteraction({
    action: "icon",
    strings: { url: "<:cool:123456789012345678>" },
  });

  await handleFgCommand(withGuild(guild, interaction), config.store);

  assert.equal(
    fgRole.icon,
    "https://cdn.discordapp.com/emojis/123456789012345678.png",
  );
  assert.match(replies[0].content ?? "", /icon is set/i);
  assert.match(replies[0].content ?? "", /Boost Level 2/i);
});

test("/fg remove deletes your FG role and unregisters it", async () => {
  const config = createStore(
    makeSettings({
      protectedRoleIds: [FG_ROLE_ID],
      fgRoleOwners: { [FG_ROLE_ID]: MEMBER_ID },
      fgRoles: {
        [FG_ROLE_ID]: {
          assignUserIds: [],
          assignRoleIds: [],
          shareUserIds: [],
          shareRoleIds: [],
        },
      },
    }),
  );
  const fgRole = makeRole(FG_ROLE_ID, "My FG", 9);
  const { guild } = createGuild({ roles: [fgRole] });
  const { interaction, replies } = createInteraction({ action: "remove" });

  await handleFgCommand(withGuild(guild, interaction), config.store);

  assert.equal(fgRole.deleted, true);
  assert.deepEqual(config.getSettings().protectedRoleIds, []);
  assert.deepEqual(config.getSettings().fgRoleOwners, {});
  assert.deepEqual(config.getSettings().fgRoles, {});
  assert.match(replies[0].content ?? "", /is gone/i);
});

test("/fg award set, view, and remove", async () => {
  const config = createStore();
  const awardRole = makeRole(AWARD_ROLE_ID, "Award", 3);
  const { guild } = createGuild({ roles: [awardRole] });

  const set = createInteraction({
    group: "award",
    action: "set",
    roleId: AWARD_ROLE_ID,
  });
  await handleFgCommand(withGuild(guild, set.interaction), config.store);
  assert.equal(config.getSettings().fgAwardRoleId, AWARD_ROLE_ID);

  const view = createInteraction({ group: "award", action: "view" });
  await handleFgCommand(withGuild(guild, view.interaction), config.store);
  assert.match(view.replies[0].content ?? "", /award role is/i);

  const remove = createInteraction({ group: "award", action: "remove" });
  await handleFgCommand(withGuild(guild, remove.interaction), config.store);
  assert.equal(config.getSettings().fgAwardRoleId, null);
});

test("/fg list shows FG roles with owners in a black embed", async () => {
  const config = createStore(
    makeSettings({ fgRoleOwners: { [FG_ROLE_ID]: MEMBER_ID } }),
  );
  const { guild } = createGuild({ roles: [makeRole(FG_ROLE_ID, "My FG", 9)] });
  const { interaction, replies } = createInteraction({ action: "list" });

  await handleFgCommand(withGuild(guild, interaction), config.store);

  const embed = replies[0].embeds?.[0].toJSON();
  assert.equal(embed?.color, 0);
  assert.equal(embed?.footer, undefined);
  assert.match(embed?.description ?? "", new RegExp(`<@&${FG_ROLE_ID}>`));
  assert.match(embed?.description ?? "", new RegExp(`<@${MEMBER_ID}>`));
});

test("/fg cleanup removes FG roles whose owner left", async () => {
  const config = createStore(
    makeSettings({
      protectedRoleIds: [FG_ROLE_ID],
      fgRoleOwners: { [FG_ROLE_ID]: OTHER_ID },
      fgRoles: {
        [FG_ROLE_ID]: {
          assignUserIds: [],
          assignRoleIds: [],
          shareUserIds: [],
          shareRoleIds: [],
        },
      },
    }),
  );
  const fgRole = makeRole(FG_ROLE_ID, "Gone FG", 9);
  const { guild } = createGuild({
    roles: [fgRole],
    missingMemberIds: [OTHER_ID],
  });
  const { interaction, replies } = createInteraction({ action: "cleanup" });

  await handleFgCommand(withGuild(guild, interaction), config.store);

  assert.equal(fgRole.deleted, true);
  assert.deepEqual(config.getSettings().fgRoleOwners, {});
  assert.match(replies[0].content ?? "", /Cleaned up 1 FG role/i);
});

test("/fg share errors are ephemeral plain text", async () => {
  const config = createStore(
    makeSettings({
      allowedUserIds: [MEMBER_ID],
      fgRoleOwners: { [FG_ROLE_ID]: MEMBER_ID },
      fgRoles: {
        [FG_ROLE_ID]: {
          assignUserIds: [],
          assignRoleIds: [],
          shareUserIds: [],
          shareRoleIds: [],
        },
      },
    }),
  );
  const { guild } = createGuild({
    roles: [makeRole(FG_ROLE_ID, "My FG", 9)],
    memberRoleIds: { [MEMBER_ID]: [FG_ROLE_ID], [OTHER_ID]: [FG_ROLE_ID] },
  });
  // Target already has the role: error path, no offer, no collector.
  const { interaction, replies } = createInteraction({
    action: "share",
    memberId: OTHER_ID,
    roleId: FG_ROLE_ID,
  });
  await handleFgCommand(withGuild(guild, interaction), config.store);

  assert.equal(replies[0].ephemeral, true);
  assert.equal(replies[0].embeds, undefined);
  assert.match(replies[0].content ?? "", /already have that FG role/i);
});

test("/fg share rejects a role that isn't an FG role", async () => {
  const config = createStore(makeSettings({ allowedUserIds: [MEMBER_ID] }));
  const { guild } = createGuild({ roles: [makeRole(FG_ROLE_ID, "Plain", 9)] });
  const { interaction, replies } = createInteraction({
    action: "share",
    memberId: OTHER_ID,
    roleId: FG_ROLE_ID,
  });

  await handleFgCommand(withGuild(guild, interaction), config.store);

  assert.equal(replies[0].ephemeral, true);
  assert.match(replies[0].content ?? "", /isn't an FG role/i);
});
