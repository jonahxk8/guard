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
  components?: Array<{ toJSON: () => unknown }>;
}

/** A fake button press, recording what the handler replies/updates with. */
function makeButton(customId: string, userId: string) {
  const button = {
    customId,
    user: { id: userId },
    replied: false,
    deferred: false,
    replies: [] as Reply[],
    updates: [] as Reply[],
    reply: async (options: Reply) => {
      button.replied = true;
      button.replies.push(options);
    },
    update: async (options: Reply) => {
      button.replied = true;
      button.updates.push(options);
    },
    deferUpdate: async () => {
      button.deferred = true;
    },
  };
  return button;
}

/** Text of a button update's embed, for assertions. */
function buttonTextOf(button: ReturnType<typeof makeButton>): string {
  const update = button.updates[0];
  const embed = update?.embeds?.[0]?.toJSON() as
    | { description?: string; title?: string }
    | undefined;
  return embed?.description ?? embed?.title ?? "";
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
    fgRoleSharers: {},
    fgRoleOwners: {},
    blacklist: {},
    logChannelId: null,
    enforcementEnabled: true,
    ...partial,
  };
}

function createStore(
  initialSettings: GuildSettings = makeSettings(),
) {
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

/** Text of a small reply: now always an embed description, never plain content. */
function replyTextOf(reply: Reply): string {
  const embed = reply.embeds?.[0]?.toJSON() as { description?: string } | undefined;
  return embed?.description ?? reply.content ?? "";
}

function createGuild(options: {
  roles?: MockRole[];
  memberRoleIds?: Record<string, string[]>;
  adminMemberIds?: string[];
  missingMemberIds?: string[];
  premiumTier?: number;
  botAboveBase?: boolean;
  /** Make roles.create reject gradient/holographic colors, like Discord does without the Enhanced Role Styles perk. */
  rejectEnhancedStyles?: boolean;
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
      const isAdmin = (options.adminMemberIds ?? []).includes(memberId);
      members.set(memberId, {
        id: memberId,
        permissions: {
          has: (permission: bigint) =>
            isAdmin && permission === PermissionFlagsBits.Administrator,
        },
        displayName:
          memberId === MEMBER_ID
            ? "Alex"
            : memberId === OTHER_ID
              ? "Sam"
              : "Owner",
        user: {
          id: memberId,
          username:
            memberId === MEMBER_ID
              ? "Alex"
              : memberId === OTHER_ID
                ? "Sam"
                : "Owner",
        },
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
      fetch: async (arg: string | { user?: string }) =>
        getMember(typeof arg === "string" ? arg : (arg.user ?? "")),
      fetchMe: async () => botMember,
    },
    roles: {
      cache: rolesCache,
      create: async (createOptions: Record<string, unknown>) => {
        const colors = createOptions.colors as
          | { primaryColor?: string; secondaryColor?: string; tertiaryColor?: string }
          | undefined;
        createdRoles.push(createOptions);
        if (
          options.rejectEnhancedStyles &&
          (colors?.secondaryColor || colors?.tertiaryColor)
        ) {
          throw new Error("Enhanced Role Styles not unlocked");
        }
        const role = makeRole(
          String(100000000000000000 + nextRoleId++),
          createOptions.name as string,
          typeof createOptions.position === "number"
            ? (createOptions.position as number)
            : 5,
        );
        role.color = colors?.primaryColor ?? (createOptions.color as string);
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
  isAdmin?: boolean;
  roleId?: string;
  memberId?: string;
  strings?: Record<string, string>;
}) {
  const replies: Reply[] = [];
  const offerEdits: Reply[] = [];
  const collectorHandlers: Record<string, Array<(...args: unknown[]) => unknown>> = {};
  const collector = {
    on: (event: string, fn: (...args: unknown[]) => unknown) => {
      (collectorHandlers[event] ??= []).push(fn);
    },
    stop: (_reason?: string) => {},
    fireCollect: async (button: unknown) => {
      for (const fn of collectorHandlers.collect ?? []) await fn(button);
    },
    fireEnd: async (reason: string) => {
      for (const fn of collectorHandlers.end ?? []) await fn(undefined, reason);
    },
  };
  const interaction = {
    commandName: "fg",
    guildId: GUILD_ID,
    user: { id: options.userId ?? MEMBER_ID, username: "Alex" },
    memberPermissions: {
      has: (permission: bigint) =>
        (permission === PermissionFlagsBits.Administrator &&
          (options.isAdmin ?? false)) ||
        (permission === PermissionFlagsBits.ManageGuild &&
          (options.canManageServer ?? true)),
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
    // Share offers and the remove confirmation call fetchReply() to
    // start a button collector. The fake collector records its handlers
    // so tests can fire button presses and timeouts at will.
    fetchReply: async () => ({
      edits: [] as Reply[],
      edit: async (options: Reply) => {
        offerEdits.push(options);
      },
      createMessageComponentCollector: () => collector,
    }),
  } as unknown as ChatInputCommandInteraction;
  return { interaction, replies, collector, offerEdits };
}

function withGuild(
  guild: Record<string, unknown>,
  interaction: ChatInputCommandInteraction,
) {
  (interaction as unknown as { guild: unknown }).guild = guild;
  return interaction;
}

test("parseFgColor accepts hex, short hex, and color names", () => {
  assert.equal(parseFgColor("#ff0000"), "#ff0000");
  assert.equal(parseFgColor("ff0000"), "#ff0000");
  assert.equal(parseFgColor("#f00"), "#ff0000");
  assert.equal(parseFgColor("blue"), "#0000ff");
  assert.equal(parseFgColor("grey"), "#808080");
  assert.equal(parseFgColor("not-a-color"), null);
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
  assert.match(replyTextOf(replies[0]), /base role/i);
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
  assert.match(replyTextOf(replies[0]), /Manage Server/i);
});

test("/fg color creates an owned FG role under the base with no permissions", async () => {
  const config = createStore(
    makeSettings({
      allowedUserIds: [MEMBER_ID],
      fgBaseRoleId: BASE_ROLE_ID,
      fgRoleSharers: {},
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
  assert.match(replyTextOf(replies[0]), /My FG is your FG role now/i);
  assert.doesNotMatch(replyTextOf(replies[0]), /\[object Object\]/);
  // The award system is gone: no extra role is granted on creation.
  assert.equal(
    (getMember(MEMBER_ID)!.roles as { cache: { has: (id: string) => boolean } }).cache.has(AWARD_ROLE_ID),
    false,
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
  assert.match(replyTextOf(replies[0]), /already have an FG role/i);
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
  assert.match(replyTextOf(replies[0]), /whitelisted/i);
});

test("/fg color with two colors creates a real gradient role", async () => {
  const config = createStore(
    makeSettings({
      allowedUserIds: [MEMBER_ID],
      fgBaseRoleId: BASE_ROLE_ID,
    }),
  );
  const { guild, createdRoles } = createGuild({
    roles: [makeRole(BASE_ROLE_ID, "FG Base", 10)],
  });
  const { interaction, replies } = createInteraction({
    action: "color",
    strings: { color: "#ff0000", second_color: "#0000ff", name: "Grad FG" },
  });

  await handleFgCommand(withGuild(guild, interaction), config.store);

  assert.equal(createdRoles.length, 1);
  assert.deepEqual(createdRoles[0].colors, {
    primaryColor: "#ff0000",
    secondaryColor: "#0000ff",
  });
  assert.match(replyTextOf(replies[0]), /Grad FG is your FG role now/i);
  assert.doesNotMatch(replyTextOf(replies[0]), /only show one color/i);
});

test("/fg color accepts two colors in the one color option", async () => {
  const config = createStore(
    makeSettings({
      allowedUserIds: [MEMBER_ID],
      fgBaseRoleId: BASE_ROLE_ID,
    }),
  );
  const { guild, createdRoles } = createGuild({
    roles: [makeRole(BASE_ROLE_ID, "FG Base", 10)],
  });
  const { interaction } = createInteraction({
    action: "color",
    strings: { color: "red, blue", name: "Grad FG" },
  });

  await handleFgCommand(withGuild(guild, interaction), config.store);

  assert.equal(createdRoles.length, 1);
  assert.deepEqual(createdRoles[0].colors, {
    primaryColor: "#ff0000",
    secondaryColor: "#0000ff",
  });
});

test("/fg color holographic creates a role with Discord's preset", async () => {
  const config = createStore(
    makeSettings({
      allowedUserIds: [MEMBER_ID],
      fgBaseRoleId: BASE_ROLE_ID,
    }),
  );
  const { guild, createdRoles } = createGuild({
    roles: [makeRole(BASE_ROLE_ID, "FG Base", 10)],
  });
  const { interaction } = createInteraction({
    action: "color",
    strings: { color: "holographic", name: "Holo FG" },
  });

  await handleFgCommand(withGuild(guild, interaction), config.store);

  assert.equal(createdRoles.length, 1);
  assert.deepEqual(createdRoles[0].colors, {
    primaryColor: "#a9c9ff",
    secondaryColor: "#ffbbec",
    tertiaryColor: "#ffc3a0",
  });
});

test("/fg color random creates a role with a valid hex color", async () => {
  const config = createStore(
    makeSettings({
      allowedUserIds: [MEMBER_ID],
      fgBaseRoleId: BASE_ROLE_ID,
    }),
  );
  const { guild, createdRoles } = createGuild({
    roles: [makeRole(BASE_ROLE_ID, "FG Base", 10)],
  });
  const { interaction } = createInteraction({
    action: "color",
    strings: { color: "random", name: "Random FG" },
  });

  await handleFgCommand(withGuild(guild, interaction), config.store);

  assert.equal(createdRoles.length, 1);
  assert.match(
    (createdRoles[0].colors as { primaryColor: string }).primaryColor,
    /^#[0-9a-f]{6}$/,
  );
});

test("/fg color rejects three colors", async () => {
  const config = createStore(
    makeSettings({
      allowedUserIds: [MEMBER_ID],
      fgBaseRoleId: BASE_ROLE_ID,
    }),
  );
  const { guild, createdRoles } = createGuild({
    roles: [makeRole(BASE_ROLE_ID, "FG Base", 10)],
  });
  const { interaction, replies } = createInteraction({
    action: "color",
    strings: { color: "red blue", second_color: "#00ff00", name: "Too Many" },
  });

  await handleFgCommand(withGuild(guild, interaction), config.store);

  assert.equal(createdRoles.length, 0);
  assert.match(replyTextOf(replies[0]), /Too many colors/i);
});

test("/fg color falls back to solid when the server lacks Enhanced Role Styles", async () => {
  const config = createStore(
    makeSettings({
      allowedUserIds: [MEMBER_ID],
      fgBaseRoleId: BASE_ROLE_ID,
    }),
  );
  const { guild, createdRoles } = createGuild({
    roles: [makeRole(BASE_ROLE_ID, "FG Base", 10)],
    rejectEnhancedStyles: true,
  });
  const { interaction, replies } = createInteraction({
    action: "color",
    strings: { color: "#ff0000", second_color: "#0000ff", name: "Grad FG" },
  });

  await handleFgCommand(withGuild(guild, interaction), config.store);

  // First attempt (gradient) rejected, second attempt (solid) kept.
  assert.equal(createdRoles.length, 2);
  assert.deepEqual(createdRoles[1].colors, { primaryColor: "#ff0000" });
  assert.match(replyTextOf(replies[0]), /Gradients need the Enhanced Role Styles perk/i);
  assert.match(replyTextOf(replies[0]), /solid #ff0000 for now/i);
});

test("/fg color holographic falls back to solid without Enhanced Role Styles", async () => {
  const config = createStore(
    makeSettings({
      allowedUserIds: [MEMBER_ID],
      fgBaseRoleId: BASE_ROLE_ID,
    }),
  );
  const { guild, createdRoles } = createGuild({
    roles: [makeRole(BASE_ROLE_ID, "FG Base", 10)],
    rejectEnhancedStyles: true,
  });
  const { interaction, replies } = createInteraction({
    action: "color",
    strings: { color: "holo", name: "Holo FG" },
  });

  await handleFgCommand(withGuild(guild, interaction), config.store);

  assert.equal(createdRoles.length, 2);
  assert.deepEqual(createdRoles[1].colors, { primaryColor: "#a9c9ff" });
  assert.match(replyTextOf(replies[0]), /Holographic needs the Enhanced Role Styles perk/i);
  assert.match(replyTextOf(replies[0]), /solid #a9c9ff for now/i);
});

test("/fg create creates an FG role for a named member (whitelisted caller)", async () => {
  const config = createStore(
    makeSettings({
      allowedUserIds: [MEMBER_ID],
      fgBaseRoleId: BASE_ROLE_ID,
      fgRoleSharers: {},
    }),
  );
  const { guild, createdRoles, getMember } = createGuild({
    roles: [
      makeRole(BASE_ROLE_ID, "FG Base", 10),
      makeRole(AWARD_ROLE_ID, "Award", 3),
    ],
    memberRoleIds: { [MEMBER_ID]: [], [OTHER_ID]: [] },
  });
  const { interaction, replies } = createInteraction({
    action: "create",
    memberId: OTHER_ID,
    strings: { name: "Sam FG", color: "blue" },
  });

  await handleFgCommand(withGuild(guild, interaction), config.store);

  assert.equal(createdRoles.length, 1);
  assert.deepEqual(createdRoles[0].permissions, []);
  assert.equal(createdRoles[0].position, 9);
  const settings = config.getSettings();
  const createdRoleId = Object.keys(settings.fgRoleOwners)[0];
  assert.equal(settings.fgRoleOwners[createdRoleId], OTHER_ID);
  assert.ok(settings.protectedRoleIds.includes(createdRoleId));
  assert.match(replyTextOf(replies[0]), /Created FG role Sam FG for Sam/i);
  assert.doesNotMatch(replyTextOf(replies[0]), /\[object Object\]/);
  // No award role is granted on creation anymore.
  assert.equal(
    (getMember(OTHER_ID)!.roles as { cache: { has: (id: string) => boolean } }).cache.has(AWARD_ROLE_ID),
    false,
  );
});

test("/fg create for yourself works when whitelisted", async () => {
  const config = createStore(
    makeSettings({ allowedUserIds: [MEMBER_ID], fgBaseRoleId: BASE_ROLE_ID }),
  );
  const { guild, createdRoles } = createGuild({
    roles: [makeRole(BASE_ROLE_ID, "FG Base", 10)],
  });
  const { interaction, replies } = createInteraction({
    action: "create",
    strings: { name: "My FG", color: "#ff0000" },
  });

  await handleFgCommand(withGuild(guild, interaction), config.store);

  assert.equal(createdRoles.length, 1);
  const createdRoleId = Object.keys(config.getSettings().fgRoleOwners)[0];
  assert.equal(config.getSettings().fgRoleOwners[createdRoleId], MEMBER_ID);
  assert.match(replyTextOf(replies[0]), /My FG is your FG role now/i);
});

test("/fg create by the server owner works without being whitelisted", async () => {
  const config = createStore(makeSettings({ fgBaseRoleId: BASE_ROLE_ID }));
  const { guild, createdRoles } = createGuild({
    roles: [makeRole(BASE_ROLE_ID, "FG Base", 10)],
  });
  const { interaction, replies } = createInteraction({
    action: "create",
    userId: OWNER_ID,
    strings: { name: "Owner FG", color: "red" },
  });

  await handleFgCommand(withGuild(guild, interaction), config.store);

  assert.equal(createdRoles.length, 1);
  const createdRoleId = Object.keys(config.getSettings().fgRoleOwners)[0];
  assert.equal(config.getSettings().fgRoleOwners[createdRoleId], OWNER_ID);
  assert.match(replyTextOf(replies[0]), /Owner FG is your FG role now/i);
});

test("/fg create by a member with a whitelisted role works", async () => {
  const WHITELIST_ROLE_ID = "777777777777777777";
  const config = createStore(
    makeSettings({
      allowedRoleIds: [WHITELIST_ROLE_ID],
      fgBaseRoleId: BASE_ROLE_ID,
    }),
  );
  const { guild, createdRoles } = createGuild({
    roles: [makeRole(BASE_ROLE_ID, "FG Base", 10)],
    memberRoleIds: { [MEMBER_ID]: [WHITELIST_ROLE_ID] },
  });
  const { interaction } = createInteraction({
    action: "create",
    strings: { name: "Role FG", color: "green" },
  });

  await handleFgCommand(withGuild(guild, interaction), config.store);

  assert.equal(createdRoles.length, 1);
});

test("/fg create rejects a non-whitelisted member", async () => {
  const config = createStore(makeSettings({ fgBaseRoleId: BASE_ROLE_ID }));
  const { guild, createdRoles } = createGuild({
    roles: [makeRole(BASE_ROLE_ID, "FG Base", 10)],
  });
  const { interaction, replies } = createInteraction({
    action: "create",
    strings: { name: "Nope", color: "blue" },
  });

  await handleFgCommand(withGuild(guild, interaction), config.store);

  assert.equal(createdRoles.length, 0);
  assert.match(
    replyTextOf(replies[0]),
    /Only the server owner, administrators, or whitelisted members can create FG roles/i,
  );
});

test("/fg create rejects a second FG role for the same target", async () => {
  const config = createStore(
    makeSettings({
      allowedUserIds: [MEMBER_ID],
      fgBaseRoleId: BASE_ROLE_ID,
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
  const { guild, createdRoles } = createGuild({
    roles: [
      makeRole(BASE_ROLE_ID, "FG Base", 10),
      makeRole(FG_ROLE_ID, "Old FG", 9),
    ],
  });
  const { interaction, replies } = createInteraction({
    action: "create",
    memberId: OTHER_ID,
    strings: { name: "Second FG", color: "blue" },
  });

  await handleFgCommand(withGuild(guild, interaction), config.store);

  assert.equal(createdRoles.length, 0);
  assert.match(replyTextOf(replies[0]), /already have an FG role/i);
});

test("/fg create errors when no base role is set", async () => {
  const config = createStore(makeSettings({ allowedUserIds: [MEMBER_ID] }));
  const { guild, createdRoles } = createGuild({ roles: [] });
  const { interaction, replies } = createInteraction({
    action: "create",
    strings: { name: "No Base", color: "blue" },
  });

  await handleFgCommand(withGuild(guild, interaction), config.store);

  assert.equal(createdRoles.length, 0);
  assert.match(replyTextOf(replies[0]), /Set an FG base role first/i);
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
  assert.match(replyTextOf(replies[0]), /Your FG role is now called New Name/i);
  assert.doesNotMatch(replyTextOf(replies[0]), /\[object Object\]/);

  const other = createInteraction({
    action: "rename",
    userId: OTHER_ID,
    strings: { name: "Steal" },
  });
  await handleFgCommand(withGuild(guild, other.interaction), config.store);

  assert.equal(fgRole.name, "New Name");
  assert.match(replyTextOf(other.replies[0]), /don't have an FG role/i);
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
  assert.match(replyTextOf(replies[0]), /icon is set/i);
  assert.match(replyTextOf(replies[0]), /Boost Level 2/i);
});

test("/fg remove asks for confirmation and Yes deletes the role", async () => {
  const config = createStore(
    makeSettings({
      protectedRoleIds: [FG_ROLE_ID],
      fgRoleOwners: { [FG_ROLE_ID]: MEMBER_ID },
      fgRoleSharers: { [FG_ROLE_ID]: [OTHER_ID] },
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
  const { interaction, replies, collector } = createInteraction({ action: "remove" });

  await handleFgCommand(withGuild(guild, interaction), config.store);

  // Nothing is deleted yet: the reply is the confirmation embed.
  assert.equal(fgRole.deleted, false);
  assert.deepEqual(config.getSettings().fgRoleOwners, { [FG_ROLE_ID]: MEMBER_ID });
  assert.equal(replies.length, 1);
  assert.equal(replies[0].ephemeral, true);
  const embed = replies[0].embeds?.[0]?.toJSON() as {
    title?: string;
    description?: string;
    fields?: Array<{ name?: string; value?: string }>;
  };
  assert.equal(embed.title, "Remove FG role");
  assert.match(embed.description ?? "", /Delete My FG for good/);
  assert.equal(embed.fields?.[0]?.value, `<@&${FG_ROLE_ID}>`);
  const row = replies[0].components?.[0]?.toJSON() as {
    components?: Array<{ custom_id?: string; label?: string; disabled?: boolean }>;
  };
  assert.deepEqual(
    (row.components ?? []).map((button) => button.custom_id),
    ["fg-remove:yes", "fg-remove:no"],
  );
  assert.deepEqual(
    (row.components ?? []).map((button) => button.label),
    ["Yes", "No"],
  );

  // Press Yes: the role and its sharers entry go away.
  const yes = makeButton("fg-remove:yes", MEMBER_ID);
  await collector.fireCollect(yes);
  assert.equal(fgRole.deleted, true);
  assert.deepEqual(config.getSettings().protectedRoleIds, []);
  assert.deepEqual(config.getSettings().fgRoleOwners, {});
  assert.deepEqual(config.getSettings().fgRoles, {});
  assert.deepEqual(config.getSettings().fgRoleSharers, {});
  assert.match(buttonTextOf(yes), /is gone/i);
});

test("/fg remove No keeps the role", async () => {
  const config = createStore(
    makeSettings({
      protectedRoleIds: [FG_ROLE_ID],
      fgRoleOwners: { [FG_ROLE_ID]: MEMBER_ID },
      fgRoleSharers: { [FG_ROLE_ID]: [OTHER_ID] },
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
  const { interaction, collector } = createInteraction({ action: "remove" });

  await handleFgCommand(withGuild(guild, interaction), config.store);

  const no = makeButton("fg-remove:no", MEMBER_ID);
  await collector.fireCollect(no);
  assert.equal(fgRole.deleted, false);
  assert.deepEqual(config.getSettings().fgRoleOwners, { [FG_ROLE_ID]: MEMBER_ID });
  assert.deepEqual(config.getSettings().fgRoleSharers, { [FG_ROLE_ID]: [OTHER_ID] });
  assert.match(buttonTextOf(no), /was kept/i);
});

test("/fg remove timeout keeps the role", async () => {
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
  const { interaction, collector, offerEdits } = createInteraction({ action: "remove" });

  await handleFgCommand(withGuild(guild, interaction), config.store);

  await collector.fireEnd("time");
  assert.equal(fgRole.deleted, false);
  assert.deepEqual(config.getSettings().fgRoleOwners, { [FG_ROLE_ID]: MEMBER_ID });
  assert.equal(offerEdits.length, 1);
  const edit = offerEdits[0].embeds?.[0]?.toJSON() as { description?: string };
  assert.match(edit.description ?? "", /expired.*was kept/i);
  const row = offerEdits[0].components?.[0]?.toJSON() as {
    components?: Array<{ disabled?: boolean }>;
  };
  assert.ok((row.components ?? []).every((button) => button.disabled));
});

test("/fg remove rejects another user's button press", async () => {
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
  const { interaction, collector } = createInteraction({ action: "remove" });

  await handleFgCommand(withGuild(guild, interaction), config.store);

  const stranger = makeButton("fg-remove:yes", OTHER_ID);
  await collector.fireCollect(stranger);
  assert.equal(fgRole.deleted, false);
  assert.equal(stranger.replies.length, 1);
  const replyEmbed = stranger.replies[0].embeds?.[0]?.toJSON() as {
    description?: string;
  };
  assert.match(replyEmbed.description ?? "", /isn't for you/i);
  assert.equal(stranger.replies[0].ephemeral, true);

  // The confirmation is still open for the owner afterwards.
  const yes = makeButton("fg-remove:yes", MEMBER_ID);
  await collector.fireCollect(yes);
  assert.equal(fgRole.deleted, true);
  assert.match(buttonTextOf(yes), /is gone/i);
});

test("/fg remove without an FG role errors with no buttons", async () => {
  const config = createStore();
  const { guild } = createGuild({ roles: [] });
  const { interaction, replies } = createInteraction({ action: "remove" });

  await handleFgCommand(withGuild(guild, interaction), config.store);

  assert.equal(replies.length, 1);
  assert.equal(replies[0].components, undefined);
  assert.match(replyTextOf(replies[0]), /don't have an FG role to remove/i);
});

test("/fg award no longer exists", async () => {
  const config = createStore();
  const { guild } = createGuild({ roles: [] });
  const { interaction, replies } = createInteraction({
    group: "award",
    action: "view",
  });

  await handleFgCommand(withGuild(guild, interaction), config.store);

  assert.match(replyTextOf(replies[0]), /Use \/help fg to see FG commands/i);
});

test("/fg assign gives the role and authorises sharing (whitelisted staff)", async () => {
  const config = createStore(
    makeSettings({
      allowedUserIds: [MEMBER_ID],
      fgRoleOwners: { [FG_ROLE_ID]: OWNER_ID },
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
  const { guild, getMember } = createGuild({
    roles: [makeRole(FG_ROLE_ID, "My FG", 9)],
    memberRoleIds: { [OTHER_ID]: [] },
  });
  const { interaction, replies } = createInteraction({
    action: "assign",
    memberId: OTHER_ID,
    roleId: FG_ROLE_ID,
  });

  await handleFgCommand(withGuild(guild, interaction), config.store);

  assert.equal(
    (getMember(OTHER_ID)!.roles as { cache: { has: (id: string) => boolean } }).cache.has(FG_ROLE_ID),
    true,
  );
  assert.deepEqual(config.getSettings().fgRoleSharers, { [FG_ROLE_ID]: [OTHER_ID] });
  assert.match(replyTextOf(replies[0]), /Sam now has My FG and can share it/i);
  assert.doesNotMatch(replyTextOf(replies[0]), /\[object Object\]/);
});

test("/fg assign by the server owner works without being whitelisted", async () => {
  const config = createStore(
    makeSettings({
      fgRoleOwners: { [FG_ROLE_ID]: OWNER_ID },
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
    memberRoleIds: { [OTHER_ID]: [] },
  });
  const { interaction, replies } = createInteraction({
    action: "assign",
    userId: OWNER_ID,
    memberId: OTHER_ID,
    roleId: FG_ROLE_ID,
  });

  await handleFgCommand(withGuild(guild, interaction), config.store);

  assert.deepEqual(config.getSettings().fgRoleSharers, { [FG_ROLE_ID]: [OTHER_ID] });
  assert.match(replyTextOf(replies[0]), /can share it/i);
});

test("/fg assign rejects a normal member", async () => {
  const config = createStore(
    makeSettings({
      fgRoleOwners: { [FG_ROLE_ID]: OWNER_ID },
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
  const { guild, getMember } = createGuild({
    roles: [makeRole(FG_ROLE_ID, "My FG", 9)],
    memberRoleIds: { [OTHER_ID]: [] },
  });
  const { interaction, replies } = createInteraction({
    action: "assign",
    memberId: OTHER_ID,
    roleId: FG_ROLE_ID,
  });

  await handleFgCommand(withGuild(guild, interaction), config.store);

  assert.deepEqual(config.getSettings().fgRoleSharers, {});
  assert.equal(
    (getMember(OTHER_ID)!.roles as { cache: { has: (id: string) => boolean } }).cache.has(FG_ROLE_ID),
    false,
  );
  assert.match(
    replyTextOf(replies[0]),
    /Only the server owner, administrators, or whitelisted members can create FG roles/i,
  );
});

test("/fg assign when the member already has the role just authorises them", async () => {
  const config = createStore(
    makeSettings({
      allowedUserIds: [MEMBER_ID],
      fgRoleOwners: { [FG_ROLE_ID]: OWNER_ID },
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
    memberRoleIds: { [OTHER_ID]: [FG_ROLE_ID] },
  });
  const { interaction, replies } = createInteraction({
    action: "assign",
    memberId: OTHER_ID,
    roleId: FG_ROLE_ID,
  });

  await handleFgCommand(withGuild(guild, interaction), config.store);

  assert.deepEqual(config.getSettings().fgRoleSharers, { [FG_ROLE_ID]: [OTHER_ID] });
  assert.match(replyTextOf(replies[0]), /can now share My FG/i);
});

test("/fg assign errors for a role that isn't an FG role", async () => {
  const config = createStore(makeSettings({ allowedUserIds: [MEMBER_ID] }));
  const { guild } = createGuild({ roles: [makeRole(FG_ROLE_ID, "Plain", 9)] });
  const { interaction, replies } = createInteraction({
    action: "assign",
    memberId: OTHER_ID,
    roleId: FG_ROLE_ID,
  });

  await handleFgCommand(withGuild(guild, interaction), config.store);

  assert.match(replyTextOf(replies[0]), /isn't an FG role/i);
});

test("/fg auth add works for the FG owner and does not give the role", async () => {
  const config = createStore(
    makeSettings({
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
  const { guild, getMember } = createGuild({
    roles: [makeRole(FG_ROLE_ID, "My FG", 9)],
    memberRoleIds: { [OTHER_ID]: [] },
  });
  const { interaction, replies } = createInteraction({
    group: "auth",
    action: "add",
    memberId: OTHER_ID,
    roleId: FG_ROLE_ID,
  });

  await handleFgCommand(withGuild(guild, interaction), config.store);

  assert.deepEqual(config.getSettings().fgRoleSharers, { [FG_ROLE_ID]: [OTHER_ID] });
  assert.equal(
    (getMember(OTHER_ID)!.roles as { cache: { has: (id: string) => boolean } }).cache.has(FG_ROLE_ID),
    false,
  );
  assert.match(replyTextOf(replies[0]), /Sam can now share My FG/i);
  assert.match(replyTextOf(replies[0]), /don't get the role/i);
});

test("/fg auth add works for whitelisted staff and rejects a random member", async () => {
  const settings = makeSettings({
    allowedUserIds: [MEMBER_ID],
    fgRoleOwners: { [FG_ROLE_ID]: OWNER_ID },
    fgRoles: {
      [FG_ROLE_ID]: {
        assignUserIds: [],
        assignRoleIds: [],
        shareUserIds: [],
        shareRoleIds: [],
      },
    },
  });
  const config = createStore(settings);
  const { guild } = createGuild({ roles: [makeRole(FG_ROLE_ID, "My FG", 9)] });
  const { interaction, replies } = createInteraction({
    group: "auth",
    action: "add",
    memberId: OTHER_ID,
    roleId: FG_ROLE_ID,
  });
  await handleFgCommand(withGuild(guild, interaction), config.store);
  assert.deepEqual(config.getSettings().fgRoleSharers, { [FG_ROLE_ID]: [OTHER_ID] });

  const random = createInteraction({
    group: "auth",
    action: "add",
    userId: OTHER_ID,
    memberId: MEMBER_ID,
    roleId: FG_ROLE_ID,
  });
  await handleFgCommand(withGuild(guild, random.interaction), config.store);
  assert.match(
    replyTextOf(random.replies[0]),
    /Only the FG role owner, the server owner, administrators, or whitelisted members/i,
  );
  assert.deepEqual(config.getSettings().fgRoleSharers, { [FG_ROLE_ID]: [OTHER_ID] });
});

test("/fg auth add rejects a duplicate and auth remove cannot remove the owner", async () => {
  const config = createStore(
    makeSettings({
      fgRoleOwners: { [FG_ROLE_ID]: MEMBER_ID },
      fgRoleSharers: { [FG_ROLE_ID]: [OTHER_ID] },
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
  const { guild } = createGuild({ roles: [makeRole(FG_ROLE_ID, "My FG", 9)] });

  const duplicate = createInteraction({
    group: "auth",
    action: "add",
    memberId: OTHER_ID,
    roleId: FG_ROLE_ID,
  });
  await handleFgCommand(withGuild(guild, duplicate.interaction), config.store);
  assert.match(replyTextOf(duplicate.replies[0]), /already authorised to share/i);

  const removeOwner = createInteraction({
    group: "auth",
    action: "remove",
    memberId: MEMBER_ID,
    roleId: FG_ROLE_ID,
  });
  await handleFgCommand(withGuild(guild, removeOwner.interaction), config.store);
  assert.match(replyTextOf(removeOwner.replies[0]), /can't remove the FG role owner/i);

  const remove = createInteraction({
    group: "auth",
    action: "remove",
    memberId: OTHER_ID,
    roleId: FG_ROLE_ID,
  });
  await handleFgCommand(withGuild(guild, remove.interaction), config.store);
  assert.deepEqual(config.getSettings().fgRoleSharers, { [FG_ROLE_ID]: [] });
  assert.match(replyTextOf(remove.replies[0]), /can no longer share My FG/i);

  const removeAgain = createInteraction({
    group: "auth",
    action: "remove",
    memberId: OTHER_ID,
    roleId: FG_ROLE_ID,
  });
  await handleFgCommand(withGuild(guild, removeAgain.interaction), config.store);
  assert.match(replyTextOf(removeAgain.replies[0]), /isn't authorised to share/i);
});

test("/fg auth list shows the owner first, then the authorised sharers", async () => {
  const config = createStore(
    makeSettings({
      fgRoleOwners: { [FG_ROLE_ID]: MEMBER_ID },
      fgRoleSharers: { [FG_ROLE_ID]: [OTHER_ID] },
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
  const { guild } = createGuild({ roles: [makeRole(FG_ROLE_ID, "My FG", 9)] });
  const { interaction, replies } = createInteraction({
    group: "auth",
    action: "list",
    roleId: FG_ROLE_ID,
  });

  await handleFgCommand(withGuild(guild, interaction), config.store);

  const embed = replies[0].embeds?.[0].toJSON();
  assert.equal(embed?.title, "Who can share My FG");
  const value = embed?.fields?.[0]?.value ?? "";
  assert.ok(value.startsWith("Owner: Alex"));
  assert.match(value, /Sam/);
});

test("/fg share succeeds for an assigned member who is not whitelisted", async () => {
  const config = createStore(
    makeSettings({
      fgRoleOwners: { [FG_ROLE_ID]: OWNER_ID },
      fgRoleSharers: { [FG_ROLE_ID]: [MEMBER_ID] },
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
  const targetId = "444444444444444444";
  const { guild } = createGuild({
    roles: [makeRole(FG_ROLE_ID, "My FG", 9)],
    memberRoleIds: { [MEMBER_ID]: [FG_ROLE_ID], [targetId]: [] },
  });
  const { interaction, replies } = createInteraction({
    action: "share",
    memberId: targetId,
    roleId: FG_ROLE_ID,
  });

  await handleFgCommand(withGuild(guild, interaction), config.store);

  // An offer was sent (public embed), not an error reply.
  assert.equal(replies[0].ephemeral, undefined);
  assert.ok(replies[0].embeds?.length === 1);
  assert.match(replies[0].embeds?.[0].toJSON().title ?? "", /FG role share/);
});

test("/fg share succeeds for an authed member who does not hold the role", async () => {
  const config = createStore(
    makeSettings({
      fgRoleOwners: { [FG_ROLE_ID]: OWNER_ID },
      fgRoleSharers: { [FG_ROLE_ID]: [MEMBER_ID] },
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
  const targetId = "444444444444444444";
  const { guild } = createGuild({
    roles: [makeRole(FG_ROLE_ID, "My FG", 9)],
    memberRoleIds: { [MEMBER_ID]: [], [targetId]: [] },
  });
  const { interaction, replies } = createInteraction({
    action: "share",
    memberId: targetId,
    roleId: FG_ROLE_ID,
  });

  await handleFgCommand(withGuild(guild, interaction), config.store);

  assert.equal(replies[0].ephemeral, undefined);
  assert.ok(replies[0].embeds?.length === 1);
});

test("/fg share rejects a member who holds the role but was never assigned or authed", async () => {
  const config = createStore(
    makeSettings({
      fgRoleOwners: { [FG_ROLE_ID]: OWNER_ID },
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
  const targetId = "444444444444444444";
  const { guild } = createGuild({
    roles: [makeRole(FG_ROLE_ID, "My FG", 9)],
    memberRoleIds: { [MEMBER_ID]: [FG_ROLE_ID], [targetId]: [] },
  });
  const { interaction, replies } = createInteraction({
    action: "share",
    memberId: targetId,
    roleId: FG_ROLE_ID,
  });

  await handleFgCommand(withGuild(guild, interaction), config.store);

  assert.equal(replies[0].ephemeral, true);
  assert.equal(replies[0].embeds?.length, 1);
  assert.match(replyTextOf(replies[0]), /aren't authorised to share that FG role/i);
});

test("/fg list shows FG roles with owners in a colorless embed", async () => {
  const config = createStore(
    makeSettings({ fgRoleOwners: { [FG_ROLE_ID]: MEMBER_ID } }),
  );
  const { guild } = createGuild({ roles: [makeRole(FG_ROLE_ID, "My FG", 9)] });
  const { interaction, replies } = createInteraction({ action: "list" });

  await handleFgCommand(withGuild(guild, interaction), config.store);

  const embed = replies[0].embeds?.[0].toJSON();
  assert.equal(embed?.color, undefined); // No color set: the embed blends in.
  assert.equal(embed?.footer, undefined);
  assert.equal(embed?.timestamp, undefined);
  assert.equal(embed?.fields?.length, 1);
  assert.equal(embed?.fields?.[0]?.name, "My FG");
  assert.match(embed?.fields?.[0]?.value ?? "", new RegExp(`<@${MEMBER_ID}>`));
  // Plain text only: no emoji anywhere in the FG list embed.
  assert.doesNotMatch(
    JSON.stringify(embed),
    /[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{2B00}-\u{2BFF}\u{25A0}-\u{25FF}\u{2190}-\u{21FF}\u{2300}-\u{23FF}\u{FE0F}\u{200D}]/u,
  );
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
  assert.match(replyTextOf(replies[0]), /Cleaned up 1 FG role/i);
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
  assert.equal(replies[0].embeds?.length, 1);
  assert.match(replyTextOf(replies[0]), /already have that FG role/i);
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
  assert.match(replyTextOf(replies[0]), /isn't an FG role/i);
});

/** Administrator counts as owner: verified in the guard, the FG gates, and help. */

test("/fg create by an Administrator works without being whitelisted", async () => {
  const config = createStore(makeSettings({ fgBaseRoleId: BASE_ROLE_ID }));
  const { guild, createdRoles } = createGuild({
    roles: [makeRole(BASE_ROLE_ID, "FG Base", 10)],
    adminMemberIds: [MEMBER_ID],
  });
  const { interaction, replies } = createInteraction({
    action: "create",
    strings: { name: "Admin FG", color: "crimson" },
  });

  await handleFgCommand(withGuild(guild, interaction), config.store);

  assert.equal(createdRoles.length, 1);
  assert.match(replyTextOf(replies[0]), /Admin FG is your FG role now/i);
});

test("/fg assign by an Administrator works without being whitelisted", async () => {
  const config = createStore(
    makeSettings({
      fgRoleOwners: { [FG_ROLE_ID]: OWNER_ID },
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
    adminMemberIds: [MEMBER_ID],
    memberRoleIds: { [OTHER_ID]: [] },
  });
  const { interaction, replies } = createInteraction({
    action: "assign",
    memberId: OTHER_ID,
    roleId: FG_ROLE_ID,
  });

  await handleFgCommand(withGuild(guild, interaction), config.store);

  assert.deepEqual(config.getSettings().fgRoleSharers, { [FG_ROLE_ID]: [OTHER_ID] });
  assert.match(replyTextOf(replies[0]), /can share it/i);
});

test("/fg auth add by an Administrator works without being whitelisted", async () => {
  const config = createStore(
    makeSettings({
      fgRoleOwners: { [FG_ROLE_ID]: OWNER_ID },
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
    adminMemberIds: [MEMBER_ID],
  });
  const { interaction, replies } = createInteraction({
    group: "auth",
    action: "add",
    memberId: OTHER_ID,
    roleId: FG_ROLE_ID,
  });

  await handleFgCommand(withGuild(guild, interaction), config.store);

  assert.deepEqual(config.getSettings().fgRoleSharers, { [FG_ROLE_ID]: [OTHER_ID] });
  assert.match(replyTextOf(replies[0]), /can now share/i);
});

test("/fg base by an Administrator works via the Manage Server gate", async () => {
  const config = createStore();
  const { guild } = createGuild({
    roles: [makeRole(BASE_ROLE_ID, "FG Base", 10)],
  });
  const { interaction, replies } = createInteraction({
    action: "base",
    roleId: BASE_ROLE_ID,
    isAdmin: true,
    canManageServer: false,
  });

  await handleFgCommand(withGuild(guild, interaction), config.store);

  assert.equal(config.getSettings().fgBaseRoleId, BASE_ROLE_ID);
  assert.match(replyTextOf(replies[0]), /base role/i);
});
