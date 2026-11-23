import assert from "node:assert/strict";
import test from "node:test";
import { deflateSync } from "node:zlib";
import {
  ChatInputCommandInteraction,
  EmbedBuilder,
  PermissionFlagsBits,
  PermissionsBitField,
} from "discord.js";
import { ConfigStore, GuildSettings } from "./config-store.js";
import { handleFgCommand, parseFgColor } from "./fg-booster.js";
import { ADMIN_ROLE_IDS } from "./authorization.js";

const GUILD_ID = "111111111111111111";
const OWNER_ID = "999999999999999999";
const MEMBER_ID = "222222222222222222";
const OTHER_ID = "333333333333333333";
const BASE_ROLE_ID = "444444444444444444";
const FG_ROLE_ID = "555555555555555555";
const AWARD_ROLE_ID = "666666666666666666";
const EXISTING_ROLE_ID = "777777777777777777";

interface Reply {
  content?: string;
  embeds?: EmbedBuilder[];
  ephemeral?: boolean;
  components?: Array<{ toJSON: () => unknown }>;
  allowedMentions?: { parse?: string[]; users?: string[]; roles?: string[] };
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

/** Text of a button update: embed description/title, or the plain content. */
function buttonTextOf(button: ReturnType<typeof makeButton>): string {
  const update = button.updates[0];
  const embed = update?.embeds?.[0]?.toJSON() as
    | { description?: string; title?: string }
    | undefined;
  return embed?.description ?? embed?.title ?? (update?.content as string) ?? "";
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
  /** Make setColors reject gradient/holographic colors, like Discord does without the Enhanced Role Styles perk. */
  rejectEnhancedStyles?: boolean;
  edits: Array<Record<string, unknown>>;
  /** Every setColors call, including ones Discord rejected. */
  setColorsAttempts: Array<Record<string, unknown>>;
  setName: (name: string) => Promise<MockRole>;
  setIcon: (icon: string) => Promise<MockRole>;
  setUnicodeEmoji: (emoji: string) => Promise<MockRole>;
  setColors: (colors: Record<string, unknown>) => Promise<MockRole>;
  delete: () => Promise<void>;
}

function makeRole(
  id: string,
  name = "Role",
  position = 5,
  options: { rejectEnhancedStyles?: boolean } = {},
): MockRole {
  const role = {
    id,
    name,
    position,
    managed: false,
    permissions: { has: () => false },
    deleted: false,
    rejectEnhancedStyles: options.rejectEnhancedStyles ?? false,
    edits: [] as Array<Record<string, unknown>>,
    setColorsAttempts: [] as Array<Record<string, unknown>>,
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
    setColors: async (colors: Record<string, unknown>) => {
      role.setColorsAttempts.push({ colors });
      if (
        role.rejectEnhancedStyles &&
        (colors.secondaryColor || colors.tertiaryColor)
      ) {
        throw new Error("Enhanced Role Styles not unlocked");
      }
      role.edits.push({ colors });
      role.color = (colors.primaryColor as string | undefined) ?? role.color;
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
  /** Make roles.add reject for these members, like Discord does when the bot's role is too low. */
  failRoleAddMemberIds?: string[];
  /** Make member.send reject for these members, like closed DMs. */
  failSendMemberIds?: string[];
  /** Make guild.members.fetch throw this error for a member, like a Discord API failure. */
  fetchMemberErrors?: Record<string, unknown>;
}) {
  const rolesCache = new Map<string, MockRole>(
    (options.roles ?? []).map((role) => [role.id, role]),
  );
  const createdRoles: Array<Record<string, unknown>> = [];
  const createdRoleObjects: MockRole[] = [];
  /** Every roles.add call, per member, so tests can see who got a role. */
  const addedByMember = new Map<string, string[]>();
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
    if (options.fetchMemberErrors?.[memberId] !== undefined) {
      throw options.fetchMemberErrors[memberId];
    }
    if ((options.missingMemberIds ?? []).includes(memberId)) return null;
    if (!addedByMember.has(memberId)) addedByMember.set(memberId, []);
    if (!members.has(memberId)) {
      const held = new Set(options.memberRoleIds?.[memberId] ?? []);
      const isAdmin = (options.adminMemberIds ?? []).includes(memberId);
      const sentDMs: Reply[] = [];
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
        displayAvatarURL: () =>
          `https://cdn.discordapp.com/avatars/${memberId}/avatar.png`,
        user: {
          id: memberId,
          username:
            memberId === MEMBER_ID
              ? "Alex"
              : memberId === OTHER_ID
                ? "Sam"
                : "Owner",
        },
        sentDMs,
        send: async (dm: Reply) => {
          if ((options.failSendMemberIds ?? []).includes(memberId)) {
            throw new Error("Cannot send messages to this user");
          }
          sentDMs.push(dm);
        },
        roles: {
          cache: {
            has: (roleId: string) => held.has(roleId),
            some: (predicate: (role: { id: string }) => boolean) =>
              [...held].some((roleId) => predicate({ id: roleId })),
          },
          add: async (role: MockRole) => {
            if ((options.failRoleAddMemberIds ?? []).includes(memberId)) {
              throw new Error("Missing Permissions");
            }
            held.add(role.id);
            addedByMember.get(memberId)!.push(role.id);
          },
          remove: async (role: MockRole) => {
            held.delete(role.id);
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
      // No argument fetches every member (used by /fg members); a
      // string or { user } fetches one member.
      fetch: async (arg?: string | { user?: string }) => {
        if (arg === undefined) return new Map(members);
        return getMember(typeof arg === "string" ? arg : (arg.user ?? ""));
      },
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
          { rejectEnhancedStyles: options.rejectEnhancedStyles },
        );
        role.color = colors?.primaryColor ?? (createOptions.color as string);
        rolesCache.set(role.id, role);
        createdRoleObjects.push(role);
        return role;
      },
    },
  };
  return { guild, createdRoles, createdRoleObjects, addedByMember, getMember };
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
  /**
   * Real PermissionsBitField to use as memberPermissions, instead of
   * the literal-bit mock. Use a real expanded bitfield
   * (PermissionsBitField.All) to model what Discord actually sends in
   * the interaction payload for a Discord Administrator.
   */
  memberPermissionsOverride?: PermissionsBitField;
}) {
  const replies: Reply[] = [];
  // Silent-ignore bookkeeping: the defer+delete calls the ignore path
  // makes on a real slash interaction (no error reply).
  const defers: Array<{ ephemeral?: boolean }> = [];
  const deletes: number[] = [];
  // /fg share defers first on slash, then sends the offer by editing
  // the deferred reply; errors after the defer go out as ephemeral
  // follow-ups instead of replies.
  const editReplies: Reply[] = [];
  const followUps: Reply[] = [];
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
    memberPermissions:
      options.memberPermissionsOverride ?? {
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
    deferReply: async (deferOptions: { ephemeral?: boolean }) => {
      defers.push(deferOptions);
    },
    editReply: async (reply: Reply) => {
      editReplies.push(reply);
    },
    followUp: async (reply: Reply) => {
      followUps.push(reply);
    },
    deleteReply: async () => {
      deletes.push(1);
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
  return { interaction, replies, collector, offerEdits, defers, deletes, editReplies, followUps };
}

function withGuild(
  guild: Record<string, unknown>,
  interaction: ChatInputCommandInteraction,
) {
  (interaction as unknown as { guild: unknown }).guild = guild;
  return interaction;
}

/** Small CRC32 for building test PNGs. */
const CRC_TABLE: Uint32Array = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c >>> 0;
  }
  return table;
})();

function pngChunk(type: string, data: Buffer): Buffer {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const typeBuffer = Buffer.from(type, "ascii");
  let c = 0xffffffff;
  for (const byte of Buffer.concat([typeBuffer, data])) {
    c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  }
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE((c ^ 0xffffffff) >>> 0, 0);
  return Buffer.concat([length, typeBuffer, data, crc]);
}

/** A 1x1 RGB PNG of one solid color, for avatar-color tests. */
function solidPng(r: number, g: number, b: number): Buffer {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(1, 0);
  ihdr.writeUInt32BE(1, 4);
  ihdr[8] = 8;
  ihdr[9] = 2; // RGB
  const raw = Buffer.from([0, r, g, b]);
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    pngChunk("IHDR", ihdr),
    pngChunk("IDAT", deflateSync(raw)),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

/**
 * Stub global fetch so avatar reads return the given PNG (or throw),
 * restoring the real fetch afterwards. Returns a cleanup function.
 */
function stubAvatarFetch(png: Buffer | null): () => void {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => {
    if (!png) throw new Error("network down");
    return {
      ok: true,
      arrayBuffer: async () =>
        png.buffer.slice(png.byteOffset, png.byteOffset + png.byteLength),
    };
  }) as unknown as typeof fetch;
  return () => {
    globalThis.fetch = originalFetch;
  };
}

test("parseFgColor accepts hex and rejects names", () => {
  assert.equal(parseFgColor("#ff0000"), "#ff0000");
  assert.equal(parseFgColor("ff0000"), "#ff0000");
  assert.equal(parseFgColor("#f00"), "#ff0000");
  assert.equal(parseFgColor("blue"), null);
  assert.equal(parseFgColor("light blue"), null);
  assert.equal(parseFgColor("not-a-color"), null);
  assert.equal(parseFgColor("#gggggg"), null);
});

function fgOwnedSettings(): GuildSettings {
  return makeSettings({
    allowedUserIds: [MEMBER_ID],
    fgBaseRoleId: BASE_ROLE_ID,
    fgRoleOwners: { [FG_ROLE_ID]: MEMBER_ID },
    fgRoles: {
      [FG_ROLE_ID]: {
        assignUserIds: [],
        assignRoleIds: [],
        shareUserIds: [],
        shareRoleIds: [],
      },
    },
  });
}

test("/fg color recolors your own FG role", async () => {
  const config = createStore(fgOwnedSettings());
  const fgRole = makeRole(FG_ROLE_ID, "Old FG", 9);
  const { guild } = createGuild({
    roles: [makeRole(BASE_ROLE_ID, "FG Base", 10), fgRole],
  });
  const { interaction, replies } = createInteraction({
    action: "color",
    strings: { color: "#ff0000" },
  });

  await handleFgCommand(withGuild(guild, interaction), config.store);

  assert.equal(fgRole.edits.length, 1);
  assert.deepEqual(fgRole.edits[0].colors, { primaryColor: "#ff0000" });
  assert.equal(replies[0].ephemeral, true);
  assert.match(replyTextOf(replies[0]), /Your FG role is now #ff0000/i);
  assert.doesNotMatch(replyTextOf(replies[0]), /\[object Object\]/);
});

test("/fg color without an FG role tells you to make one with /fg create", async () => {
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
    strings: { color: "#ff0000" },
  });

  await handleFgCommand(withGuild(guild, interaction), config.store);

  assert.equal(createdRoles.length, 0);
  assert.match(replyTextOf(replies[0]), /make one with \/fg create first/i);
});

test("/fg color works for an FG owner who is not whitelisted", async () => {
  // Recoloring your own role is not gated on being whitelisted: like
  // Bleed, the owner customises their own role.
  const config = createStore(fgOwnedSettings());
  const fgRole = makeRole(FG_ROLE_ID, "Old FG", 9);
  const { guild } = createGuild({
    roles: [makeRole(BASE_ROLE_ID, "FG Base", 10), fgRole],
  });
  const { interaction, replies } = createInteraction({
    action: "color",
    strings: { color: "#00ff00" },
  });

  await handleFgCommand(withGuild(guild, interaction), config.store);

  assert.equal(fgRole.edits.length, 1);
  assert.match(replyTextOf(replies[0]), /Your FG role is now #00ff00/i);
});

test("/fg color with two hexes recolors as a real gradient", async () => {
  const config = createStore(fgOwnedSettings());
  const fgRole = makeRole(FG_ROLE_ID, "Old FG", 9);
  const { guild } = createGuild({
    roles: [makeRole(BASE_ROLE_ID, "FG Base", 10), fgRole],
  });
  const { interaction, replies } = createInteraction({
    action: "color",
    strings: { color: "#ff0000", second_color: "#0000ff" },
  });

  await handleFgCommand(withGuild(guild, interaction), config.store);

  assert.equal(fgRole.edits.length, 1);
  assert.deepEqual(fgRole.edits[0].colors, {
    primaryColor: "#ff0000",
    secondaryColor: "#0000ff",
  });
  assert.match(
    replyTextOf(replies[0]),
    /gradient from #ff0000 to #0000ff/i,
  );
  assert.doesNotMatch(replyTextOf(replies[0]), /only show one color/i);
});

test("/fg color accepts two hexes in the one color option", async () => {
  const config = createStore(fgOwnedSettings());
  const fgRole = makeRole(FG_ROLE_ID, "Old FG", 9);
  const { guild } = createGuild({
    roles: [makeRole(BASE_ROLE_ID, "FG Base", 10), fgRole],
  });
  const { interaction } = createInteraction({
    action: "color",
    strings: { color: "#ff0000, #0000ff" },
  });

  await handleFgCommand(withGuild(guild, interaction), config.store);

  assert.equal(fgRole.edits.length, 1);
  assert.deepEqual(fgRole.edits[0].colors, {
    primaryColor: "#ff0000",
    secondaryColor: "#0000ff",
  });
});

test("/fg color holographic recolors with Discord's preset", async () => {
  const config = createStore(fgOwnedSettings());
  const fgRole = makeRole(FG_ROLE_ID, "Old FG", 9);
  const { guild } = createGuild({
    roles: [makeRole(BASE_ROLE_ID, "FG Base", 10), fgRole],
  });
  const { interaction, replies } = createInteraction({
    action: "color",
    strings: { color: "holographic" },
  });

  await handleFgCommand(withGuild(guild, interaction), config.store);

  assert.equal(fgRole.edits.length, 1);
  assert.deepEqual(fgRole.edits[0].colors, {
    primaryColor: "#a9c9ff",
    secondaryColor: "#ffbbec",
    tertiaryColor: "#ffc3a0",
  });
  assert.match(replyTextOf(replies[0]), /now holographic/i);
});

test("/fg color random recolors with a valid hex color", async () => {
  const config = createStore(fgOwnedSettings());
  const fgRole = makeRole(FG_ROLE_ID, "Old FG", 9);
  const { guild } = createGuild({
    roles: [makeRole(BASE_ROLE_ID, "FG Base", 10), fgRole],
  });
  const { interaction } = createInteraction({
    action: "color",
    strings: { color: "random" },
  });

  await handleFgCommand(withGuild(guild, interaction), config.store);

  assert.equal(fgRole.edits.length, 1);
  assert.match(
    (fgRole.edits[0].colors as { primaryColor: string }).primaryColor,
    /^#[0-9a-f]{6}$/,
  );
});

test("/fg color dominant recolors with the avatar's dominant color", async () => {
  const config = createStore(fgOwnedSettings());
  const fgRole = makeRole(FG_ROLE_ID, "Old FG", 9);
  const { guild } = createGuild({
    roles: [makeRole(BASE_ROLE_ID, "FG Base", 10), fgRole],
  });
  const { interaction, replies } = createInteraction({
    action: "color",
    strings: { color: "dominant" },
  });
  const restoreFetch = stubAvatarFetch(solidPng(0, 128, 255));
  try {
    await handleFgCommand(withGuild(guild, interaction), config.store);
  } finally {
    restoreFetch();
  }

  assert.equal(fgRole.edits.length, 1);
  assert.deepEqual(fgRole.edits[0].colors, { primaryColor: "#0080ff" });
  assert.match(replyTextOf(replies[0]), /matches your profile picture/i);
});

test("/fg color dominant falls back to the default color when the avatar can't be read", async () => {
  const config = createStore(fgOwnedSettings());
  const fgRole = makeRole(FG_ROLE_ID, "Old FG", 9);
  const { guild } = createGuild({
    roles: [makeRole(BASE_ROLE_ID, "FG Base", 10), fgRole],
  });
  const { interaction, replies } = createInteraction({
    action: "color",
    strings: { color: "dominant" },
  });
  const restoreFetch = stubAvatarFetch(null);
  try {
    await handleFgCommand(withGuild(guild, interaction), config.store);
  } finally {
    restoreFetch();
  }

  assert.equal(fgRole.edits.length, 1);
  assert.deepEqual(fgRole.edits[0].colors, { primaryColor: "#5865f2" });
  assert.match(replyTextOf(replies[0]), /couldn't read your profile picture/i);
});

test("/fg color rejects three colors", async () => {
  const config = createStore(fgOwnedSettings());
  const fgRole = makeRole(FG_ROLE_ID, "Old FG", 9);
  const { guild } = createGuild({
    roles: [makeRole(BASE_ROLE_ID, "FG Base", 10), fgRole],
  });
  const { interaction, replies } = createInteraction({
    action: "color",
    strings: { color: "#ff0000 #0000ff", second_color: "#00ff00" },
  });

  await handleFgCommand(withGuild(guild, interaction), config.store);

  assert.equal(fgRole.edits.length, 0);
  assert.match(replyTextOf(replies[0]), /Too many colors/i);
});

test("/fg color rejects a color name", async () => {
  const config = createStore(fgOwnedSettings());
  const fgRole = makeRole(FG_ROLE_ID, "Old FG", 9);
  const { guild } = createGuild({
    roles: [makeRole(BASE_ROLE_ID, "FG Base", 10), fgRole],
  });
  const { interaction, replies } = createInteraction({
    action: "color",
    strings: { color: "blue" },
  });

  await handleFgCommand(withGuild(guild, interaction), config.store);

  assert.equal(fgRole.edits.length, 0);
  assert.match(replyTextOf(replies[0]), /isn't a hex color/i);
});

test("/fg color falls back to solid when the server lacks Enhanced Role Styles", async () => {
  const config = createStore(fgOwnedSettings());
  const fgRole = makeRole(FG_ROLE_ID, "Old FG", 9, {
    rejectEnhancedStyles: true,
  });
  const { guild } = createGuild({
    roles: [makeRole(BASE_ROLE_ID, "FG Base", 10), fgRole],
  });
  const { interaction, replies } = createInteraction({
    action: "color",
    strings: { color: "#ff0000", second_color: "#0000ff" },
  });

  await handleFgCommand(withGuild(guild, interaction), config.store);

  // First attempt (gradient) rejected, second attempt (solid) kept.
  assert.equal(fgRole.setColorsAttempts.length, 2);
  assert.equal(fgRole.edits.length, 1);
  assert.deepEqual(fgRole.edits[0].colors, { primaryColor: "#ff0000" });
  assert.match(replyTextOf(replies[0]), /Gradients need the Enhanced Role Styles perk/i);
  assert.match(replyTextOf(replies[0]), /solid #ff0000 for now/i);
});

test("/fg color holographic falls back to solid without Enhanced Role Styles", async () => {
  const config = createStore(fgOwnedSettings());
  const fgRole = makeRole(FG_ROLE_ID, "Old FG", 9, {
    rejectEnhancedStyles: true,
  });
  const { guild } = createGuild({
    roles: [makeRole(BASE_ROLE_ID, "FG Base", 10), fgRole],
  });
  const { interaction, replies } = createInteraction({
    action: "color",
    strings: { color: "holo" },
  });

  await handleFgCommand(withGuild(guild, interaction), config.store);

  assert.equal(fgRole.setColorsAttempts.length, 2);
  assert.equal(fgRole.edits.length, 1);
  assert.deepEqual(fgRole.edits[0].colors, { primaryColor: "#a9c9ff" });
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
  const { guild, createdRoles, addedByMember, getMember } = createGuild({
    roles: [
      makeRole(BASE_ROLE_ID, "FG Base", 10),
      makeRole(AWARD_ROLE_ID, "Award", 3),
    ],
    memberRoleIds: { [MEMBER_ID]: [], [OTHER_ID]: [] },
  });
  const { interaction, replies } = createInteraction({
    action: "create",
    memberId: OTHER_ID,
    strings: { name: "Sam FG" },
  });

  // Sam's avatar is solid red, so the role takes that color.
  const restoreFetch = stubAvatarFetch(solidPng(255, 0, 0));
  try {
    await handleFgCommand(withGuild(guild, interaction), config.store);
  } finally {
    restoreFetch();
  }

  assert.equal(createdRoles.length, 1);
  assert.deepEqual(createdRoles[0].permissions, []);
  assert.equal(createdRoles[0].position, 9);
  assert.deepEqual(createdRoles[0].colors, { primaryColor: "#ff0000" });
  const settings = config.getSettings();
  const createdRoleId = Object.keys(settings.fgRoleOwners)[0];
  assert.equal(settings.fgRoleOwners[createdRoleId], OTHER_ID);
  assert.ok(settings.protectedRoleIds.includes(createdRoleId));
  assert.match(replyTextOf(replies[0]), /Created FG role Sam FG for Sam/i);
  assert.doesNotMatch(replyTextOf(replies[0]), /\[object Object\]/);
  // The new role is actually given to Sam, not just created.
  assert.deepEqual(addedByMember.get(OTHER_ID), [createdRoleId]);
  assert.equal(
    (getMember(OTHER_ID)!.roles as { cache: { has: (id: string) => boolean } }).cache.has(createdRoleId),
    true,
  );
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
  const { guild, createdRoles, addedByMember, getMember } = createGuild({
    roles: [makeRole(BASE_ROLE_ID, "FG Base", 10)],
  });
  const { interaction, replies } = createInteraction({
    action: "create",
    strings: { name: "My FG" },
  });

  const restoreFetch = stubAvatarFetch(solidPng(0, 255, 0));
  try {
    await handleFgCommand(withGuild(guild, interaction), config.store);
  } finally {
    restoreFetch();
  }

  assert.equal(createdRoles.length, 1);
  assert.deepEqual(createdRoles[0].colors, { primaryColor: "#00ff00" });
  const createdRoleId = Object.keys(config.getSettings().fgRoleOwners)[0];
  assert.equal(config.getSettings().fgRoleOwners[createdRoleId], MEMBER_ID);
  // The new role is actually given to the caller.
  assert.deepEqual(addedByMember.get(MEMBER_ID), [createdRoleId]);
  assert.equal(
    (getMember(MEMBER_ID)!.roles as { cache: { has: (id: string) => boolean } }).cache.has(createdRoleId),
    true,
  );
  assert.match(replyTextOf(replies[0]), /My FG is your FG role now/i);
  assert.match(replyTextOf(replies[0]), /matches their profile picture/i);
});

test("/fg create by the server owner works without being whitelisted", async () => {
  const config = createStore(makeSettings({ fgBaseRoleId: BASE_ROLE_ID }));
  const { guild, createdRoles } = createGuild({
    roles: [makeRole(BASE_ROLE_ID, "FG Base", 10)],
  });
  const { interaction, replies } = createInteraction({
    action: "create",
    userId: OWNER_ID,
    strings: { name: "Owner FG" },
  });

  const restoreFetch = stubAvatarFetch(solidPng(0, 0, 255));
  try {
    await handleFgCommand(withGuild(guild, interaction), config.store);
  } finally {
    restoreFetch();
  }

  assert.equal(createdRoles.length, 1);
  assert.deepEqual(createdRoles[0].colors, { primaryColor: "#0000ff" });
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
    strings: { name: "Role FG" },
  });

  const restoreFetch = stubAvatarFetch(solidPng(255, 255, 0));
  try {
    await handleFgCommand(withGuild(guild, interaction), config.store);
  } finally {
    restoreFetch();
  }

  assert.equal(createdRoles.length, 1);
  assert.deepEqual(createdRoles[0].colors, { primaryColor: "#ffff00" });
});

test("/fg create uses the default color when the avatar can't be read", async () => {
  const config = createStore(
    makeSettings({ allowedUserIds: [MEMBER_ID], fgBaseRoleId: BASE_ROLE_ID }),
  );
  const { guild, createdRoles } = createGuild({
    roles: [makeRole(BASE_ROLE_ID, "FG Base", 10)],
  });
  const { interaction, replies } = createInteraction({
    action: "create",
    strings: { name: "My FG" },
  });

  const restoreFetch = stubAvatarFetch(null);
  try {
    await handleFgCommand(withGuild(guild, interaction), config.store);
  } finally {
    restoreFetch();
  }

  assert.equal(createdRoles.length, 1);
  assert.deepEqual(createdRoles[0].colors, { primaryColor: "#5865f2" });
  assert.match(replyTextOf(replies[0]), /couldn't read their profile picture/i);
  assert.match(replyTextOf(replies[0]), /My FG is your FG role now/i);
});

test("/fg create by a non-whitelisted member is silently ignored", async () => {
  // An authorisation failure sends NO reply at all — not even an
  // ephemeral error. Slash interactions are deferred ephemerally and
  // the deferred reply deleted, so the user briefly sees "thinking"
  // and then nothing.
  const config = createStore(makeSettings({ fgBaseRoleId: BASE_ROLE_ID }));
  const { guild, createdRoles } = createGuild({
    roles: [makeRole(BASE_ROLE_ID, "FG Base", 10)],
  });
  const { interaction, replies, defers, deletes } = createInteraction({
    action: "create",
    strings: { name: "Nope" },
  });

  await handleFgCommand(withGuild(guild, interaction), config.store);

  assert.equal(createdRoles.length, 0);
  assert.deepEqual(replies, []);
  assert.deepEqual(defers, [{ ephemeral: true }]);
  assert.equal(deletes.length, 1);
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
    // The target owns the role and actually holds it in the guild.
    memberRoleIds: { [OTHER_ID]: [FG_ROLE_ID] },
  });
  const { interaction, replies, defers } = createInteraction({
    action: "create",
    memberId: OTHER_ID,
    strings: { name: "Second FG" },
  });

  await handleFgCommand(withGuild(guild, interaction), config.store);

  assert.equal(createdRoles.length, 0);
  // A functional error still replies — only authorisation failures
  // are silently ignored.
  assert.deepEqual(defers, []);
  assert.match(replyTextOf(replies[0]), /already have an FG role/i);
});

test("/fg create errors when no base role is set", async () => {
  const config = createStore(makeSettings({ allowedUserIds: [MEMBER_ID] }));
  const { guild, createdRoles } = createGuild({ roles: [] });
  const { interaction, replies } = createInteraction({
    action: "create",
    strings: { name: "No Base" },
  });

  await handleFgCommand(withGuild(guild, interaction), config.store);

  assert.equal(createdRoles.length, 0);
  assert.match(replyTextOf(replies[0]), /Set an FG base role first/i);
});

test("/fg create deletes the role and says so when giving it to the target fails", async () => {
  const config = createStore(
    makeSettings({
      allowedUserIds: [MEMBER_ID],
      fgBaseRoleId: BASE_ROLE_ID,
      fgRoleSharers: {},
    }),
  );
  const { guild, createdRoles, createdRoleObjects, addedByMember } =
    createGuild({
      roles: [makeRole(BASE_ROLE_ID, "FG Base", 10)],
      memberRoleIds: { [MEMBER_ID]: [], [OTHER_ID]: [] },
      failRoleAddMemberIds: [OTHER_ID],
    });
  const { interaction, replies } = createInteraction({
    action: "create",
    memberId: OTHER_ID,
    strings: { name: "Sam FG" },
  });

  const restoreFetch = stubAvatarFetch(solidPng(255, 0, 0));
  try {
    await handleFgCommand(withGuild(guild, interaction), config.store);
  } finally {
    restoreFetch();
  }

  // The role was created, then deleted again — no orphan FG role is
  // left recorded, and Sam never got it.
  assert.equal(createdRoles.length, 1);
  assert.equal(createdRoleObjects[0].deleted, true);
  assert.deepEqual(config.getSettings().fgRoleOwners, {});
  assert.deepEqual(config.getSettings().protectedRoleIds, []);
  assert.deepEqual(addedByMember.get(OTHER_ID), []);
  assert.match(replyTextOf(replies[0]), /couldn't give the FG role to Sam/i);
  assert.match(replyTextOf(replies[0]), /bot's role is above the FG base role/i);
  assert.match(replyTextOf(replies[0]), /Manage Roles/i);
});

test("/fg add registers an existing role for a named member and gives it to them", async () => {
  const config = createStore(
    makeSettings({ allowedUserIds: [MEMBER_ID], fgBaseRoleId: BASE_ROLE_ID }),
  );
  const { guild, addedByMember, getMember } = createGuild({
    roles: [makeRole(BASE_ROLE_ID, "FG Base", 10), makeRole(EXISTING_ROLE_ID, "Old Role", 8)],
    memberRoleIds: { [MEMBER_ID]: [], [OTHER_ID]: [] },
  });
  const { interaction, replies } = createInteraction({
    action: "add",
    roleId: EXISTING_ROLE_ID,
    memberId: OTHER_ID,
  });

  await handleFgCommand(withGuild(guild, interaction), config.store);

  const settings = config.getSettings();
  assert.equal(settings.fgRoleOwners[EXISTING_ROLE_ID], OTHER_ID);
  assert.ok(settings.protectedRoleIds.includes(EXISTING_ROLE_ID));
  assert.deepEqual(settings.fgRoles[EXISTING_ROLE_ID], {
    assignUserIds: [],
    assignRoleIds: [],
    shareUserIds: [],
    shareRoleIds: [],
  });
  assert.deepEqual(addedByMember.get(OTHER_ID), [EXISTING_ROLE_ID]);
  assert.equal(
    (getMember(OTHER_ID)!.roles as { cache: { has: (id: string) => boolean } }).cache.has(EXISTING_ROLE_ID),
    true,
  );
  assert.match(replyTextOf(replies[0]), /Old Role is now Sam's FG role/i);
});

test("/fg add for yourself works when whitelisted", async () => {
  const config = createStore(
    makeSettings({ allowedUserIds: [MEMBER_ID], fgBaseRoleId: BASE_ROLE_ID }),
  );
  const { guild, addedByMember, getMember } = createGuild({
    roles: [makeRole(BASE_ROLE_ID, "FG Base", 10), makeRole(EXISTING_ROLE_ID, "Old Role", 8)],
    memberRoleIds: { [MEMBER_ID]: [] },
  });
  const { interaction, replies } = createInteraction({
    action: "add",
    roleId: EXISTING_ROLE_ID,
    memberId: MEMBER_ID,
  });

  await handleFgCommand(withGuild(guild, interaction), config.store);

  assert.equal(config.getSettings().fgRoleOwners[EXISTING_ROLE_ID], MEMBER_ID);
  assert.deepEqual(addedByMember.get(MEMBER_ID), [EXISTING_ROLE_ID]);
  assert.equal(
    (getMember(MEMBER_ID)!.roles as { cache: { has: (id: string) => boolean } }).cache.has(EXISTING_ROLE_ID),
    true,
  );
  assert.match(replyTextOf(replies[0]), /Old Role is your FG role now/i);
});

test("/fg add registers a role the member already holds without adding it again", async () => {
  const config = createStore(
    makeSettings({ allowedUserIds: [MEMBER_ID], fgBaseRoleId: BASE_ROLE_ID }),
  );
  const { guild, addedByMember } = createGuild({
    roles: [makeRole(BASE_ROLE_ID, "FG Base", 10), makeRole(EXISTING_ROLE_ID, "Old Role", 8)],
    memberRoleIds: { [MEMBER_ID]: [], [OTHER_ID]: [EXISTING_ROLE_ID] },
  });
  const { interaction, replies } = createInteraction({
    action: "add",
    roleId: EXISTING_ROLE_ID,
    memberId: OTHER_ID,
  });

  await handleFgCommand(withGuild(guild, interaction), config.store);

  assert.equal(config.getSettings().fgRoleOwners[EXISTING_ROLE_ID], OTHER_ID);
  assert.deepEqual(addedByMember.get(OTHER_ID), []);
  assert.match(replyTextOf(replies[0]), /Old Role is now Sam's FG role/i);
});

test("/fg add refuses a role that is already an FG role", async () => {
  const config = createStore(
    makeSettings({
      allowedUserIds: [MEMBER_ID],
      fgBaseRoleId: BASE_ROLE_ID,
      fgRoleOwners: { [EXISTING_ROLE_ID]: MEMBER_ID },
      fgRoles: {
        [EXISTING_ROLE_ID]: {
          assignUserIds: [],
          assignRoleIds: [],
          shareUserIds: [],
          shareRoleIds: [],
        },
      },
    }),
  );
  const { guild, addedByMember } = createGuild({
    roles: [makeRole(BASE_ROLE_ID, "FG Base", 10), makeRole(EXISTING_ROLE_ID, "Old Role", 8)],
    memberRoleIds: { [MEMBER_ID]: [], [OTHER_ID]: [] },
  });
  const { interaction, replies } = createInteraction({
    action: "add",
    roleId: EXISTING_ROLE_ID,
    memberId: OTHER_ID,
  });

  await handleFgCommand(withGuild(guild, interaction), config.store);

  assert.equal(config.getSettings().fgRoleOwners[EXISTING_ROLE_ID], MEMBER_ID);
  assert.deepEqual(addedByMember.get(OTHER_ID) ?? [], []);
  assert.match(replyTextOf(replies[0]), /already an FG role/i);
});

test("/fg add refuses a target who already holds a different FG role", async () => {
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
  const { guild, addedByMember } = createGuild({
    roles: [
      makeRole(BASE_ROLE_ID, "FG Base", 10),
      makeRole(FG_ROLE_ID, "Old FG", 9),
      makeRole(EXISTING_ROLE_ID, "Old Role", 8),
    ],
    memberRoleIds: { [MEMBER_ID]: [], [OTHER_ID]: [FG_ROLE_ID] },
  });
  const { interaction, replies } = createInteraction({
    action: "add",
    roleId: EXISTING_ROLE_ID,
    memberId: OTHER_ID,
  });

  await handleFgCommand(withGuild(guild, interaction), config.store);

  assert.equal(config.getSettings().fgRoleOwners[EXISTING_ROLE_ID], undefined);
  assert.deepEqual(addedByMember.get(OTHER_ID), []);
  assert.match(replyTextOf(replies[0]), /already have an FG role/i);
});

test("/fg add refuses the base role, @everyone, and managed roles", async () => {
  // The FG base role itself.
  const baseConfig = createStore(
    makeSettings({ allowedUserIds: [MEMBER_ID], fgBaseRoleId: BASE_ROLE_ID }),
  );
  const baseGuild = createGuild({
    roles: [makeRole(BASE_ROLE_ID, "FG Base", 10)],
  });
  const baseInteraction = createInteraction({
    action: "add",
    roleId: BASE_ROLE_ID,
    memberId: OTHER_ID,
  });
  await handleFgCommand(
    withGuild(baseGuild.guild, baseInteraction.interaction),
    baseConfig.store,
  );
  assert.equal(baseConfig.getSettings().fgRoleOwners[BASE_ROLE_ID], undefined);
  assert.match(replyTextOf(baseInteraction.replies[0]), /base role can't be an FG role/i);

  // @everyone (role id == guild id).
  const everyoneConfig = createStore(
    makeSettings({ allowedUserIds: [MEMBER_ID], fgBaseRoleId: BASE_ROLE_ID }),
  );
  const everyoneGuild = createGuild({
    roles: [makeRole(GUILD_ID, "@everyone", 0)],
  });
  const everyoneInteraction = createInteraction({
    action: "add",
    roleId: GUILD_ID,
    memberId: OTHER_ID,
  });
  await handleFgCommand(
    withGuild(everyoneGuild.guild, everyoneInteraction.interaction),
    everyoneConfig.store,
  );
  assert.equal(everyoneConfig.getSettings().fgRoleOwners[GUILD_ID], undefined);
  assert.match(replyTextOf(everyoneInteraction.replies[0]), /can't be an FG role/i);

  // A managed (integration/bot) role.
  const managedRole = makeRole(EXISTING_ROLE_ID, "Bot Role", 8);
  managedRole.managed = true;
  const managedConfig = createStore(
    makeSettings({ allowedUserIds: [MEMBER_ID], fgBaseRoleId: BASE_ROLE_ID }),
  );
  const managedGuild = createGuild({
    roles: [makeRole(BASE_ROLE_ID, "FG Base", 10), managedRole],
  });
  const managedInteraction = createInteraction({
    action: "add",
    roleId: EXISTING_ROLE_ID,
    memberId: OTHER_ID,
  });
  await handleFgCommand(
    withGuild(managedGuild.guild, managedInteraction.interaction),
    managedConfig.store,
  );
  assert.equal(managedConfig.getSettings().fgRoleOwners[EXISTING_ROLE_ID], undefined);
  assert.match(replyTextOf(managedInteraction.replies[0]), /can't be an FG role/i);
});

test("/fg add refuses an Administrator role", async () => {
  // An Administrator role must never become an FG role: /fg share
  // would hand the whole server to whoever accepts it. Same refusal
  // as /protect.
  const adminRole = makeRole(EXISTING_ROLE_ID, "Admin Role", 8);
  adminRole.permissions = {
    has: (permission: bigint) => permission === PermissionFlagsBits.Administrator,
  };
  const config = createStore(
    makeSettings({ allowedUserIds: [MEMBER_ID], fgBaseRoleId: BASE_ROLE_ID }),
  );
  const { guild } = createGuild({
    roles: [makeRole(BASE_ROLE_ID, "FG Base", 10), adminRole],
  });
  const { interaction, replies } = createInteraction({
    action: "add",
    roleId: EXISTING_ROLE_ID,
    memberId: OTHER_ID,
  });

  await handleFgCommand(withGuild(guild, interaction), config.store);

  assert.equal(config.getSettings().fgRoleOwners[EXISTING_ROLE_ID], undefined);
  assert.match(replyTextOf(replies[0]), /has Administrator, so it can't be an FG role/i);
});

test("/fg add refuses a role above the bot's role", async () => {
  const config = createStore(
    makeSettings({ allowedUserIds: [MEMBER_ID], fgBaseRoleId: BASE_ROLE_ID }),
  );
  const { guild, addedByMember } = createGuild({
    roles: [makeRole(BASE_ROLE_ID, "FG Base", 10), makeRole(EXISTING_ROLE_ID, "High Role", 50)],
    memberRoleIds: { [MEMBER_ID]: [], [OTHER_ID]: [] },
    botAboveBase: false,
  });
  const { interaction, replies } = createInteraction({
    action: "add",
    roleId: EXISTING_ROLE_ID,
    memberId: OTHER_ID,
  });

  await handleFgCommand(withGuild(guild, interaction), config.store);

  assert.equal(config.getSettings().fgRoleOwners[EXISTING_ROLE_ID], undefined);
  assert.deepEqual(addedByMember.get(OTHER_ID), []);
  assert.match(replyTextOf(replies[0]), /bot's role must be above that role/i);
});

test("/fg add does not register the role when giving it fails", async () => {
  const config = createStore(
    makeSettings({ allowedUserIds: [MEMBER_ID], fgBaseRoleId: BASE_ROLE_ID }),
  );
  const { guild, addedByMember } = createGuild({
    roles: [makeRole(BASE_ROLE_ID, "FG Base", 10), makeRole(EXISTING_ROLE_ID, "Old Role", 8)],
    memberRoleIds: { [MEMBER_ID]: [], [OTHER_ID]: [] },
    failRoleAddMemberIds: [OTHER_ID],
  });
  const { interaction, replies } = createInteraction({
    action: "add",
    roleId: EXISTING_ROLE_ID,
    memberId: OTHER_ID,
  });

  await handleFgCommand(withGuild(guild, interaction), config.store);

  assert.deepEqual(config.getSettings().fgRoleOwners, {});
  assert.deepEqual(config.getSettings().protectedRoleIds, []);
  assert.deepEqual(addedByMember.get(OTHER_ID), []);
  assert.match(replyTextOf(replies[0]), /couldn't give .* to Sam/i);
  assert.match(replyTextOf(replies[0]), /bot's role is above it/i);
  assert.match(replyTextOf(replies[0]), /Manage Roles/i);
});

test("/fg add by a non-whitelisted member is silently ignored", async () => {
  const config = createStore(makeSettings({ fgBaseRoleId: BASE_ROLE_ID }));
  const { guild, addedByMember } = createGuild({
    roles: [makeRole(BASE_ROLE_ID, "FG Base", 10), makeRole(EXISTING_ROLE_ID, "Old Role", 8)],
  });
  const { interaction, replies, defers, deletes } = createInteraction({
    action: "add",
    roleId: EXISTING_ROLE_ID,
    memberId: OTHER_ID,
  });

  await handleFgCommand(withGuild(guild, interaction), config.store);

  assert.deepEqual(config.getSettings().fgRoleOwners, {});
  assert.deepEqual(addedByMember.get(OTHER_ID) ?? [], []);
  assert.deepEqual(replies, []);
  assert.deepEqual(defers, [{ ephemeral: true }]);
  assert.equal(deletes.length, 1);
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
  assert.equal(embed.fields, undefined); // Sleek: one line, no Role field.
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

test("/fg remove keeps the role when the Discord delete fails", async () => {
  // The delete failing (role order, permissions) must not unregister
  // the role and claim it is gone — the role still exists.
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
  fgRole.delete = async () => {
    throw new Error("Missing Permissions");
  };
  const { guild } = createGuild({ roles: [fgRole] });
  const { interaction, replies, collector } = createInteraction({ action: "remove" });

  await handleFgCommand(withGuild(guild, interaction), config.store);

  const yes = makeButton("fg-remove:yes", MEMBER_ID);
  await collector.fireCollect(yes);
  assert.equal(fgRole.deleted, false);
  assert.deepEqual(config.getSettings().fgRoleOwners, { [FG_ROLE_ID]: MEMBER_ID });
  assert.deepEqual(Object.keys(config.getSettings().fgRoles), [FG_ROLE_ID]);
  assert.match(buttonTextOf(yes), /couldn't delete that role/i);
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

test("/fg share defers first, then sends the Greed-style offer by editing the deferred reply", async () => {
  // Slash: the interaction is answered (deferred) before the three
  // pre-send fetches, then the offer goes out as an edit of the
  // deferred reply — never as a fresh reply, which would throw
  // "already acknowledged" on real Discord.
  const config = createStore(fgOwnedSettings());
  const fgRole = makeRole(FG_ROLE_ID, "My FG", 9);
  const { guild, addedByMember } = createGuild({
    roles: [fgRole],
    memberRoleIds: { [MEMBER_ID]: [FG_ROLE_ID] },
  });
  const { interaction, collector, defers, replies, editReplies, followUps } =
    createInteraction({ action: "share", memberId: OTHER_ID });

  await handleFgCommand(withGuild(guild, interaction), config.store);

  // One defer with no options (public, not ephemeral), no fresh reply,
  // no follow-up.
  assert.equal(defers.length, 1);
  assert.equal(defers[0], undefined);
  assert.equal(replies.length, 0);
  assert.equal(followUps.length, 0);
  // The offer itself: plain message, target + role on line 1, the
  // question naming the owner on line 2, Approve/Decline buttons.
  assert.equal(editReplies.length, 1);
  assert.equal(editReplies[0].embeds, undefined);
  assert.equal(
    editReplies[0].content,
    `<@${OTHER_ID}> <@&${FG_ROLE_ID}>\nWould you like to accept Alex's FG role?`,
  );
  // The offer actually pings the target: their mention is in the
  // message content, and only that one user is allowed to ping — never
  // the role. Explicit users list ONLY: combining `parse: ["users"]`
  // with `users` is rejected by Discord as mutually exclusive (50035
  // MESSAGE_ALLOWED_MENTIONS_PARSE_EXCLUSIVE) and failed every share
  // offer send deterministically until this was fixed.
  assert.deepEqual(editReplies[0].allowedMentions, {
    users: [OTHER_ID],
  });
  assert.equal("parse" in (editReplies[0].allowedMentions ?? {}), false);
  const buttons = (editReplies[0].components ?? []).flatMap((row) =>
    (row.toJSON() as { components: Array<Record<string, unknown>> }).components,
  );
  assert.deepEqual(
    buttons.map((b) => ({ customId: b.custom_id, label: b.label, style: b.style })),
    [
      { customId: "fg-share:approve", label: "Approve", style: 3 },
      { customId: "fg-share:decline", label: "Decline", style: 4 },
    ],
  );

  // The target taps Approve: the role is added, the offer edits to accepted.
  const approve = makeButton("fg-share:approve", OTHER_ID);
  await collector.fireCollect(approve);
  assert.deepEqual(addedByMember.get(OTHER_ID), [FG_ROLE_ID]);
  assert.equal(approve.updates.length, 1);
  assert.equal(
    approve.updates[0].content,
    `<@${OTHER_ID}> accepted <@&${FG_ROLE_ID}>.`,
  );
});

test("/fg share defers before slow pre-send fetches finish", async () => {
  // The three pre-send fetches (requester, target, owner) each take
  // 150ms here; the defer must happen before any of them resolves —
  // that is what keeps the interaction inside Discord's 3-second
  // window on a slow connection.
  const config = createStore(fgOwnedSettings());
  const fgRole = makeRole(FG_ROLE_ID, "My FG", 9);
  const { guild } = createGuild({
    roles: [fgRole],
    memberRoleIds: { [MEMBER_ID]: [FG_ROLE_ID] },
  });
  const { interaction, defers, editReplies } = createInteraction({
    action: "share",
    memberId: OTHER_ID,
  });
  const order: string[] = [];
  const fetchImpl = guild.members.fetch as (
    arg?: string | { user?: string },
  ) => Promise<unknown>;
  (guild.members as unknown as { fetch: unknown }).fetch = (async (
    arg?: string | { user?: string },
  ) => {
    const result = await fetchImpl(arg);
    await new Promise((resolve) => setTimeout(resolve, 150));
    order.push("fetch-done");
    return result;
  }) as typeof fetchImpl;
  const deferImpl = interaction.deferReply;
  (interaction as unknown as { deferReply: unknown }).deferReply = (async (
    options?: { ephemeral?: boolean },
  ) => {
    order.push("defer");
    return deferImpl(options);
  }) as typeof deferImpl;

  await handleFgCommand(withGuild(guild, interaction), config.store);

  assert.equal(order[0], "defer");
  assert.equal(
    order.filter((step) => step === "fetch-done").length,
    3,
  );
  assert.equal(defers.length, 1);
  assert.equal(editReplies.length, 1);
});

test("/fg share swallows a failing deferUpdate on a stray button press", async () => {
  // A press with an unknown custom id is answered with deferUpdate.
  // If that defer itself fails (expired interaction), the collect
  // handler must not reject — the stray press is simply dropped.
  const config = createStore(fgOwnedSettings());
  const fgRole = makeRole(FG_ROLE_ID, "My FG", 9);
  const { guild } = createGuild({
    roles: [fgRole],
    memberRoleIds: { [MEMBER_ID]: [FG_ROLE_ID] },
  });
  const { interaction, collector, editReplies, followUps } = createInteraction({
    action: "share",
    memberId: OTHER_ID,
  });

  await handleFgCommand(withGuild(guild, interaction), config.store);

  const bogus = makeButton("fg-share:bogus", OTHER_ID);
  bogus.deferUpdate = async () => {
    throw new Error("Unknown interaction");
  };
  await collector.fireCollect(bogus);
  assert.equal(editReplies.length, 1);
  assert.equal(followUps.length, 0);
});

test("/fg share error after the defer goes out as an ephemeral follow-up", async () => {
  // The target already holds an FG role: the error must be an
  // ephemeral follow-up, not a fresh reply (which would throw
  // "already acknowledged" once the interaction is deferred).
  const config = createStore(fgOwnedSettings());
  const fgRole = makeRole(FG_ROLE_ID, "My FG", 9);
  const { guild } = createGuild({
    roles: [fgRole],
    memberRoleIds: { [MEMBER_ID]: [FG_ROLE_ID], [OTHER_ID]: [FG_ROLE_ID] },
  });
  const { interaction, defers, replies, followUps, editReplies } =
    createInteraction({ action: "share", memberId: OTHER_ID });

  await handleFgCommand(withGuild(guild, interaction), config.store);

  assert.equal(defers.length, 1);
  assert.equal(replies.length, 0);
  assert.equal(editReplies.length, 0);
  assert.equal(followUps.length, 1);
  assert.equal(followUps[0].ephemeral, true);
  const error = followUps[0].embeds?.[0]?.toJSON() as { description?: string };
  assert.match(error.description ?? "", /already have an FG role/i);
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

test("/fg remove swallows a failing deferUpdate on a stray button press", async () => {
  // Same guard as the share collector: a press with an unknown custom
  // id is answered with deferUpdate, and if that defer itself fails
  // the collect handler must not reject.
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

  const bogus = makeButton("fg-remove:bogus", MEMBER_ID);
  bogus.deferUpdate = async () => {
    throw new Error("Unknown interaction");
  };
  await collector.fireCollect(bogus);
  assert.equal(fgRole.deleted, false);
  assert.deepEqual(config.getSettings().fgRoleOwners, { [FG_ROLE_ID]: MEMBER_ID });
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
  });
  await handleFgCommand(withGuild(guild, interaction), config.store);
  assert.deepEqual(config.getSettings().fgRoleSharers, { [FG_ROLE_ID]: [OTHER_ID] });

  const random = createInteraction({
    group: "auth",
    action: "add",
    userId: OTHER_ID,
    memberId: MEMBER_ID,
  });
  await handleFgCommand(withGuild(guild, random.interaction), config.store);
  // OTHER_ID was just authed in the first half, so they CAN share the
  // role and auto-detection succeeds — but sharing is not authing:
  // the auth gate still rejects them, silently (no reply at all).
  assert.deepEqual(random.replies, []);
  assert.deepEqual(random.defers, [{ ephemeral: true }]);
  assert.equal(random.deletes.length, 1);
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
  });
  await handleFgCommand(withGuild(guild, duplicate.interaction), config.store);
  assert.match(replyTextOf(duplicate.replies[0]), /already authorised to share/i);

  const removeOwner = createInteraction({
    group: "auth",
    action: "remove",
    memberId: MEMBER_ID,
  });
  await handleFgCommand(withGuild(guild, removeOwner.interaction), config.store);
  assert.match(replyTextOf(removeOwner.replies[0]), /can't remove the FG role owner/i);

  const remove = createInteraction({
    group: "auth",
    action: "remove",
    memberId: OTHER_ID,
  });
  await handleFgCommand(withGuild(guild, remove.interaction), config.store);
  assert.deepEqual(config.getSettings().fgRoleSharers, { [FG_ROLE_ID]: [] });
  assert.match(replyTextOf(remove.replies[0]), /can no longer share My FG/i);

  const removeAgain = createInteraction({
    group: "auth",
    action: "remove",
    memberId: OTHER_ID,
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
  });

  await handleFgCommand(withGuild(guild, interaction), config.store);

  const embed = replies[0].embeds?.[0].toJSON();
  assert.equal(embed?.title, "Who can share My FG");
  const value = embed?.fields?.[0]?.value ?? "";
  assert.ok(value.startsWith("Owner: Alex"));
  assert.match(value, /Sam/);
});

test("/fg auth list with an explicit role uses that role", async () => {
  const config = createStore(
    makeSettings({
      allowedUserIds: [MEMBER_ID],
      fgRoleOwners: { [FG_ROLE_ID]: MEMBER_ID, [SECOND_FG_ROLE_ID]: OWNER_ID },
      fgRoleSharers: { [SECOND_FG_ROLE_ID]: [OTHER_ID] },
      fgRoles: {
        [FG_ROLE_ID]: {
          assignUserIds: [],
          assignRoleIds: [],
          shareUserIds: [],
          shareRoleIds: [],
        },
        [SECOND_FG_ROLE_ID]: {
          assignUserIds: [],
          assignRoleIds: [],
          shareUserIds: [],
          shareRoleIds: [],
        },
      },
    }),
  );
  const { guild } = createGuild({
    roles: [makeRole(FG_ROLE_ID, "My FG", 9), makeRole(SECOND_FG_ROLE_ID, "Other FG", 8)],
  });
  const { interaction, replies } = createInteraction({
    group: "auth",
    action: "list",
    roleId: SECOND_FG_ROLE_ID,
  });

  await handleFgCommand(withGuild(guild, interaction), config.store);

  const embed = replies[0].embeds?.[0].toJSON();
  assert.equal(embed?.title, "Who can share Other FG");
  assert.match(embed?.fields?.[0]?.value ?? "", /Sam/);
});

test("/fg auth list shows a plain ID, never a mention, for a sharer who left", async () => {
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
  const { guild } = createGuild({
    roles: [makeRole(FG_ROLE_ID, "My FG", 9)],
    missingMemberIds: [OTHER_ID],
  });
  const { interaction, replies } = createInteraction({
    group: "auth",
    action: "list",
  });

  await handleFgCommand(withGuild(guild, interaction), config.store);

  const embed = replies[0].embeds?.[0].toJSON();
  const value = embed?.fields?.[0]?.value ?? "";
  assert.ok(value.startsWith("Owner: Alex"));
  assert.ok(value.includes(OTHER_ID));
  assert.doesNotMatch(value, new RegExp(`<@${OTHER_ID}>`));
});

test("/fg auth add errors when the caller can share more than one FG role", async () => {
  const config = createStore(
    makeSettings({
      allowedUserIds: [MEMBER_ID],
      fgRoleOwners: { [FG_ROLE_ID]: OWNER_ID, [SECOND_FG_ROLE_ID]: OTHER_ID },
      fgRoles: {
        [FG_ROLE_ID]: {
          assignUserIds: [],
          assignRoleIds: [],
          shareUserIds: [],
          shareRoleIds: [],
        },
        [SECOND_FG_ROLE_ID]: {
          assignUserIds: [],
          assignRoleIds: [],
          shareUserIds: [],
          shareRoleIds: [],
        },
      },
    }),
  );
  const { guild } = createGuild({
    roles: [makeRole(FG_ROLE_ID, "My FG", 9), makeRole(SECOND_FG_ROLE_ID, "Other FG", 8)],
  });
  const { interaction, replies } = createInteraction({
    group: "auth",
    action: "add",
    memberId: OTHER_ID,
  });

  await handleFgCommand(withGuild(guild, interaction), config.store);

  // Whitelisted with no FG role of their own: auto-detection cannot
  // pick one, same as /fg share — the error names both roles.
  assert.match(replyTextOf(replies[0]), /can share more than one FG role/i);
  assert.match(replyTextOf(replies[0]), new RegExp(`<@&${FG_ROLE_ID}>`));
  assert.match(replyTextOf(replies[0]), new RegExp(`<@&${SECOND_FG_ROLE_ID}>`));
  assert.deepEqual(config.getSettings().fgRoleSharers, {});
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
  const { interaction, replies, defers, editReplies } = createInteraction({
    action: "share",
    memberId: targetId,
  });

  await handleFgCommand(withGuild(guild, interaction), config.store);

  // An offer was sent (public plain message), not an error reply.
  assert.equal(defers.length, 1);
  assert.equal(replies.length, 0);
  assert.equal(editReplies.length, 1);
  assert.equal(editReplies[0].embeds, undefined);
  assert.equal(
    editReplies[0].content,
    `<@${targetId}> <@&${FG_ROLE_ID}>\nWould you like to accept Owner's FG role?`,
  );
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
  const { interaction, replies, defers, editReplies } = createInteraction({
    action: "share",
    memberId: targetId,
  });

  await handleFgCommand(withGuild(guild, interaction), config.store);

  assert.equal(defers.length, 1);
  assert.equal(replies.length, 0);
  assert.equal(editReplies.length, 1);
  assert.equal(
    editReplies[0].content,
    `<@${targetId}> <@&${FG_ROLE_ID}>\nWould you like to accept Owner's FG role?`,
  );
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
  const { interaction, replies, defers, followUps } = createInteraction({
    action: "share",
    memberId: targetId,
  });

  await handleFgCommand(withGuild(guild, interaction), config.store);

  assert.equal(defers.length, 1);
  assert.equal(replies.length, 0);
  assert.equal(followUps.length, 1);
  assert.equal(followUps[0].ephemeral, true);
  assert.equal(followUps[0].embeds?.length, 1);
  assert.match(replyTextOf(followUps[0]), /aren't authorised to share an FG role/i);
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
  // One line per FG role in the DESCRIPTION: the role as an @mention
  // (mentions do not render in field names — they show as raw
  // "<@&id>" text), then the owner's plain display name as text,
  // never an @ mention of the owner.
  assert.equal(embed?.fields, undefined);
  assert.equal(embed?.description, `<@&${FG_ROLE_ID}> — Owner: Alex`);
  assert.doesNotMatch(embed?.description ?? "", new RegExp(`<@${MEMBER_ID}>`));
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

test("/fg cleanup does not delete a role when the owner fetch fails transiently", async () => {
  // A network/5xx blip must not be read as "the owner left": deleting
  // the role on a transient failure would destroy a live owner's FG role.
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
    fetchMemberErrors: { [OTHER_ID]: new Error("Service Unavailable") },
  });
  const { interaction, replies } = createInteraction({ action: "cleanup" });

  await handleFgCommand(withGuild(guild, interaction), config.store);

  assert.equal(fgRole.deleted, false);
  assert.deepEqual(config.getSettings().fgRoleOwners, { [FG_ROLE_ID]: OTHER_ID });
  assert.match(replyTextOf(replies[0]), /Nothing to clean up/i);
});

test("/fg cleanup deletes the role when the owner fetch is a 10007 Unknown Member", async () => {
  // The real Discord error for a member who is not in the guild:
  // only this (and a null fetch, covered by the test above) means left.
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
    fetchMemberErrors: {
      [OTHER_ID]: Object.assign(new Error("Unknown Member"), { code: 10007 }),
    },
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
  const { interaction, replies, defers, followUps } = createInteraction({
    action: "share",
    memberId: OTHER_ID,
  });
  await handleFgCommand(withGuild(guild, interaction), config.store);

  assert.equal(defers.length, 1);
  assert.equal(replies.length, 0);
  assert.equal(followUps.length, 1);
  assert.equal(followUps[0].ephemeral, true);
  assert.equal(followUps[0].embeds?.length, 1);
  assert.match(replyTextOf(followUps[0]), /already have an FG role/i);
});

test("/fg share rejects a caller who has no FG role to share", async () => {
  // Whitelisted, but owns no FG role and is authed for none: there is
  // no role argument anymore, so there is nothing to offer.
  const config = createStore(makeSettings({ allowedUserIds: [MEMBER_ID] }));
  const { guild } = createGuild({ roles: [makeRole(FG_ROLE_ID, "Plain", 9)] });
  const { interaction, replies, defers, followUps } = createInteraction({
    action: "share",
    memberId: OTHER_ID,
  });

  await handleFgCommand(withGuild(guild, interaction), config.store);

  assert.equal(defers.length, 1);
  assert.equal(replies.length, 0);
  assert.equal(followUps.length, 1);
  assert.equal(followUps[0].ephemeral, true);
  assert.match(replyTextOf(followUps[0]), /aren't authorised to share an FG role/i);
});

test("/fg assign no longer exists", async () => {
  const config = createStore();
  const { guild } = createGuild({ roles: [] });
  const { interaction, replies } = createInteraction({ action: "assign" });

  await handleFgCommand(withGuild(guild, interaction), config.store);

  assert.match(replyTextOf(replies[0]), /Use \/help fg to see FG commands/i);
});

/** A staff admin counts as owner: verified in the guard, the FG gates, and help. */

test("/fg create by a staff admin works without being whitelisted", async () => {
  const config = createStore(makeSettings({ fgBaseRoleId: BASE_ROLE_ID }));
  const { guild, createdRoles } = createGuild({
    roles: [makeRole(BASE_ROLE_ID, "FG Base", 10)],
    memberRoleIds: { [MEMBER_ID]: [ADMIN_ROLE_IDS[0]] },
  });
  const { interaction, replies } = createInteraction({
    action: "create",
    strings: { name: "Admin FG" },
  });

  const restoreFetch = stubAvatarFetch(solidPng(128, 0, 128));
  try {
    await handleFgCommand(withGuild(guild, interaction), config.store);
  } finally {
    restoreFetch();
  }

  assert.equal(createdRoles.length, 1);
  assert.deepEqual(createdRoles[0].colors, { primaryColor: "#800080" });
  assert.match(replyTextOf(replies[0]), /Admin FG is your FG role now/i);
});

test("/fg auth add by a staff admin works without being whitelisted", async () => {
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
    memberRoleIds: { [MEMBER_ID]: [ADMIN_ROLE_IDS[0]] },
  });
  const { interaction, replies } = createInteraction({
    group: "auth",
    action: "add",
    memberId: OTHER_ID,
  });

  await handleFgCommand(withGuild(guild, interaction), config.store);

  assert.deepEqual(config.getSettings().fgRoleSharers, { [FG_ROLE_ID]: [OTHER_ID] });
  assert.match(replyTextOf(replies[0]), /can now share/i);
});

test("/fg base by a staff admin works via the staff admin role", async () => {
  const config = createStore();
  const { guild } = createGuild({
    roles: [makeRole(BASE_ROLE_ID, "FG Base", 10)],
    memberRoleIds: { [MEMBER_ID]: [ADMIN_ROLE_IDS[0]] },
  });
  const { interaction, replies } = createInteraction({
    action: "base",
    roleId: BASE_ROLE_ID,
    canManageServer: false,
  });

  await handleFgCommand(withGuild(guild, interaction), config.store);

  assert.equal(config.getSettings().fgBaseRoleId, BASE_ROLE_ID);
  assert.match(replyTextOf(replies[0]), /base role/i);
});

test("/fg base by a Discord Administrator is silently ignored (real expanded payload)", async () => {
  // The key regression test for the payload-expansion leak: Discord
  // sends the member's *effective* permissions in the interaction
  // payload, and ADMINISTRATOR expands to ALL permissions there — so
  // a literal-bit mock would not catch a has(ManageGuild) leak. A real
  // PermissionsBitField.All models the production payload: the old
  // hasManageServer would have let this through and set the base.
  const config = createStore();
  const { guild } = createGuild({
    roles: [makeRole(BASE_ROLE_ID, "FG Base", 10)],
  });
  const { interaction, replies, defers, deletes } = createInteraction({
    action: "base",
    roleId: BASE_ROLE_ID,
    memberPermissionsOverride: new PermissionsBitField(
      PermissionsBitField.All,
    ),
  });

  await handleFgCommand(withGuild(guild, interaction), config.store);

  assert.equal(config.getSettings().fgBaseRoleId, null);
  assert.deepEqual(replies, []);
  assert.deepEqual(defers, [{ ephemeral: true }]);
  assert.equal(deletes.length, 1);
});

test("/fg base by a literal Manage Server holder works", async () => {
  // The Administrator exclusion must not break the real Manage Server
  // path: a member with literal Manage Server (and no Administrator)
  // still passes. Modelled with a real bitfield, as Discord sends it.
  const config = createStore();
  const { guild } = createGuild({
    roles: [makeRole(BASE_ROLE_ID, "FG Base", 10)],
  });
  const { interaction, replies, defers } = createInteraction({
    action: "base",
    roleId: BASE_ROLE_ID,
    memberPermissionsOverride: new PermissionsBitField(
      PermissionFlagsBits.ManageGuild,
    ),
  });

  await handleFgCommand(withGuild(guild, interaction), config.store);

  assert.equal(config.getSettings().fgBaseRoleId, BASE_ROLE_ID);
  assert.deepEqual(defers, []);
  assert.match(replyTextOf(replies[0]), /base role/i);
});

test("/fg auth add by a non-whitelisted admin with no FG role is silently ignored", async () => {
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
  const { guild } = createGuild({ roles: [makeRole(FG_ROLE_ID, "My FG", 9)] });
  const { interaction, replies, defers, deletes } = createInteraction({
    group: "auth",
    action: "add",
    userId: OTHER_ID,
    memberId: MEMBER_ID,
    isAdmin: true,
    canManageServer: false,
  });

  await handleFgCommand(withGuild(guild, interaction), config.store);

  assert.deepEqual(config.getSettings().fgRoleSharers, {});
  assert.deepEqual(replies, []);
  assert.deepEqual(defers, [{ ephemeral: true }]);
  assert.equal(deletes.length, 1);
});

test("/fg auth add by a non-whitelisted admin who owns an FG role works", async () => {
  // FG-owner access is not admin access: a Discord Administrator who
  // owns an FG role can still auth for their OWN role.
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
  const { guild } = createGuild({ roles: [makeRole(FG_ROLE_ID, "My FG", 9)] });
  const { interaction, replies, defers } = createInteraction({
    group: "auth",
    action: "add",
    userId: MEMBER_ID,
    memberId: OTHER_ID,
    isAdmin: true,
    canManageServer: false,
  });

  await handleFgCommand(withGuild(guild, interaction), config.store);

  assert.deepEqual(config.getSettings().fgRoleSharers, { [FG_ROLE_ID]: [OTHER_ID] });
  assert.deepEqual(defers, []);
  assert.match(replyTextOf(replies[0]), /Sam can now share My FG/i);
});

test("/fg list by a non-whitelisted admin still replies with the error (not ignored)", async () => {
  // SCOPE BOUNDARY: /fg list is deliberately NOT part of the
  // silent-ignore rule — its authorisation failure still replies.
  // NOTE: the handler also still GATES /fg list (owner / staff admin
  // / Manage Server / whitelisted only), so a non-whitelisted admin
  // does not see the list. If /fg list is meant to be open to
  // everyone, that is a separate change to this gate and to help.
  const config = createStore(
    makeSettings({ fgRoleOwners: { [FG_ROLE_ID]: MEMBER_ID } }),
  );
  const { guild } = createGuild({ roles: [makeRole(FG_ROLE_ID, "My FG", 9)] });
  const { interaction, replies, defers } = createInteraction({
    action: "list",
    userId: OTHER_ID,
    isAdmin: true,
    canManageServer: false,
  });

  await handleFgCommand(withGuild(guild, interaction), config.store);

  assert.deepEqual(defers, []);
  assert.match(
    replyTextOf(replies[0]),
    /Only Manage Server members or whitelisted members can list FG roles/i,
  );
});

test("/fg share by a non-whitelisted admin who owns an FG role works", async () => {
  // FG-owner access is not admin access: a Discord Administrator who
  // owns an FG role can still share it.
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
  const targetId = "444444444444444444";
  const { guild, getMember } = createGuild({
    roles: [makeRole(FG_ROLE_ID, "My FG", 9)],
    memberRoleIds: { [MEMBER_ID]: [FG_ROLE_ID], [targetId]: [] },
  });
  const { interaction, replies, defers, editReplies, collector } = createInteraction({
    action: "share",
    userId: MEMBER_ID,
    memberId: targetId,
    isAdmin: true,
  });

  await handleFgCommand(withGuild(guild, interaction), config.store);

  // The offer goes out (not ignored): one public defer, then the offer
  // as an edit of the deferred reply — no fresh reply.
  assert.equal(defers.length, 1);
  assert.equal(replies.length, 0);
  assert.equal(editReplies.length, 1);
  assert.equal(
    editReplies[0].content,
    `<@${targetId}> <@&${FG_ROLE_ID}>\nWould you like to accept Alex's FG role?`,
  );

  const approve = makeButton("fg-share:approve", targetId);
  await collector.fireCollect(approve);

  assert.match(buttonTextOf(approve), /accepted/i);
  assert.equal(
    (getMember(targetId)!.roles as { cache: { has: (id: string) => boolean } }).cache.has(FG_ROLE_ID),
    true,
  );
});

const SECOND_FG_ROLE_ID = "777777777777777777";

function twoFgRolesSettings(
  extra: Partial<GuildSettings> = {},
): GuildSettings {
  return makeSettings({
    fgRoleOwners: { [FG_ROLE_ID]: OWNER_ID, [SECOND_FG_ROLE_ID]: OTHER_ID },
    fgRoles: {
      [FG_ROLE_ID]: {
        assignUserIds: [],
        assignRoleIds: [],
        shareUserIds: [],
        shareRoleIds: [],
      },
      [SECOND_FG_ROLE_ID]: {
        assignUserIds: [],
        assignRoleIds: [],
        shareUserIds: [],
        shareRoleIds: [],
      },
    },
    ...extra,
  });
}

test("/fg share offer is a plain Greed-style message with Approve/Decline buttons", async () => {
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
  const targetId = "444444444444444444";
  const { guild } = createGuild({
    roles: [makeRole(FG_ROLE_ID, "My FG", 9)],
    memberRoleIds: { [MEMBER_ID]: [FG_ROLE_ID], [targetId]: [] },
  });
  const { interaction, replies, defers, editReplies } = createInteraction({
    action: "share",
    memberId: targetId,
  });

  await handleFgCommand(withGuild(guild, interaction), config.store);

  assert.equal(defers.length, 1);
  assert.equal(replies.length, 0);
  assert.equal(editReplies.length, 1);
  // Plain message, no embed: target + role on line 1, the question
  // naming the owner on line 2.
  assert.equal(editReplies[0].embeds, undefined);
  assert.equal(
    editReplies[0].content,
    `<@${targetId}> <@&${FG_ROLE_ID}>\nWould you like to accept Alex's FG role?`,
  );
  // The offer actually pings the target: their mention is in the
  // message content, and only that one user is allowed to ping — never
  // the role. Explicit users list ONLY — never `parse` + `users`
  // (Discord 50035, mutually exclusive).
  assert.deepEqual(editReplies[0].allowedMentions, {
    users: [targetId],
  });
  assert.equal("parse" in (editReplies[0].allowedMentions ?? {}), false);
  const buttons = (editReplies[0].components ?? []).flatMap((row) =>
    (row.toJSON() as { components: Array<Record<string, unknown>> }).components,
  );
  assert.deepEqual(
    buttons.map((b) => ({ customId: b.custom_id, label: b.label, style: b.style })),
    [
      { customId: "fg-share:approve", label: "Approve", style: 3 },
      { customId: "fg-share:decline", label: "Decline", style: 4 },
    ],
  );
  // Plain text only: no emoji anywhere in the offer.
  assert.doesNotMatch(
    editReplies[0].content ?? "",
    /[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{2B00}-\u{2BFF}\u{25A0}-\u{25FF}\u{2190}-\u{21FF}\u{2300}-\u{23FF}\u{FE0F}\u{200D}]/u,
  );
});

test("/fg share accept pings the target on the accepted message", async () => {
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
  const targetId = "444444444444444444";
  const { guild } = createGuild({
    roles: [makeRole(FG_ROLE_ID, "My FG", 9)],
    memberRoleIds: { [MEMBER_ID]: [FG_ROLE_ID], [targetId]: [] },
  });
  const { interaction, collector } = createInteraction({
    action: "share",
    memberId: targetId,
  });

  await handleFgCommand(withGuild(guild, interaction), config.store);

  const approve = makeButton("fg-share:approve", targetId);
  await collector.fireCollect(approve);

  assert.match(buttonTextOf(approve), /accepted/i);
  assert.equal(approve.updates[0].content, `<@${targetId}> accepted <@&${FG_ROLE_ID}>.`);
  // Same rule as the offer itself: explicit users list ONLY, never
  // `parse` + `users` (Discord 50035).
  assert.deepEqual(approve.updates[0].allowedMentions, {
    users: [targetId],
  });
  assert.equal("parse" in (approve.updates[0].allowedMentions ?? {}), false);
});

test("/fg share expiry edit lists only the target user (Discord 50035)", async () => {
  // The collector-end expiry edit goes through offer.edit — the third
  // site that combined `parse: ["users"]` with an explicit users list.
  // It was swallowed by a .catch, so it failed silently and left dead
  // buttons on the expired offer.
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
  const targetId = "444444444444444444";
  const fgRole = makeRole(FG_ROLE_ID, "My FG", 9);
  const { guild } = createGuild({
    roles: [fgRole],
    memberRoleIds: { [MEMBER_ID]: [FG_ROLE_ID], [targetId]: [] },
  });
  const { interaction, collector, offerEdits } = createInteraction({
    action: "share",
    memberId: targetId,
  });

  await handleFgCommand(withGuild(guild, interaction), config.store);

  await collector.fireEnd("time");
  assert.equal(offerEdits.length, 1);
  assert.match(offerEdits[0].content ?? "", /expired without a response/);
  assert.deepEqual(offerEdits[0].allowedMentions, { users: [targetId] });
  assert.equal("parse" in (offerEdits[0].allowedMentions ?? {}), false);
});

test("/fg drop gives back a shared FG role and frees the slot", async () => {
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
  const { guild, getMember } = createGuild({
    roles: [
      makeRole(BASE_ROLE_ID, "FG Base", 10),
      makeRole(FG_ROLE_ID, "Sam FG", 9),
    ],
    memberRoleIds: { [MEMBER_ID]: [FG_ROLE_ID], [OTHER_ID]: [FG_ROLE_ID] },
  });
  const drop = createInteraction({ action: "drop" });
  await handleFgCommand(withGuild(guild, drop.interaction), config.store);

  assert.match(replyTextOf(drop.replies[0]), /Dropped <@&555555555555555555>/);
  assert.equal(
    (getMember(MEMBER_ID)!.roles as { cache: { has: (id: string) => boolean } }).cache.has(FG_ROLE_ID),
    false,
  );
  // The slot is free: the same member can now create their own FG role.
  const create = createInteraction({
    action: "create",
    strings: { name: "My FG" },
  });
  const restoreFetch = stubAvatarFetch(solidPng(0, 255, 0));
  try {
    await handleFgCommand(withGuild(guild, create.interaction), config.store);
  } finally {
    restoreFetch();
  }
  assert.match(replyTextOf(create.replies[0]), /My FG is your FG role now/i);
});

test("/fg drop with no FG role errors", async () => {
  const config = createStore(
    makeSettings({
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
  const { guild } = createGuild({
    roles: [makeRole(FG_ROLE_ID, "Sam FG", 9)],
    memberRoleIds: { [MEMBER_ID]: [], [OTHER_ID]: [FG_ROLE_ID] },
  });
  const { interaction, replies } = createInteraction({ action: "drop" });
  await handleFgCommand(withGuild(guild, interaction), config.store);
  assert.match(replyTextOf(replies[0]), /don't have an FG role to drop/i);
});

test("/fg drop by the FG owner points at /fg remove", async () => {
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
    memberRoleIds: { [MEMBER_ID]: [FG_ROLE_ID] },
  });
  const { interaction, replies } = createInteraction({ action: "drop" });
  await handleFgCommand(withGuild(guild, interaction), config.store);
  assert.match(replyTextOf(replies[0]), /use \/fg remove to delete it/i);
  // The role is still theirs — nothing was removed.
  assert.equal(
    (getMember(MEMBER_ID)!.roles as { cache: { has: (id: string) => boolean } }).cache.has(FG_ROLE_ID),
    true,
  );
});

test("/fg members lists members with the owner first, plain names, no mentions", async () => {
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
  const thirdId = "400000000000000001";
  const { guild, getMember } = createGuild({
    roles: [makeRole(FG_ROLE_ID, "My FG", 9)],
    memberRoleIds: {
      [MEMBER_ID]: [FG_ROLE_ID],
      [OTHER_ID]: [FG_ROLE_ID],
      [thirdId]: [FG_ROLE_ID],
    },
  });
  for (const id of [MEMBER_ID, OTHER_ID, thirdId]) getMember(id);
  const { interaction, replies } = createInteraction({ action: "members" });
  await handleFgCommand(withGuild(guild, interaction), config.store);

  const embed = replies[0].embeds?.[0]?.toJSON() as {
    title?: string;
    description?: string;
  };
  assert.equal(embed.title, "Members of My FG");
  const lines = (embed.description ?? "").split("\n");
  assert.equal(lines[0], "Alex — Owner");
  assert.ok(lines.includes("Sam"));
  assert.doesNotMatch(embed.description ?? "", /<@/);
});

test("/fg members with only the owner says so in one line", async () => {
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
    memberRoleIds: { [MEMBER_ID]: [FG_ROLE_ID] },
  });
  getMember(MEMBER_ID);
  const { interaction, replies } = createInteraction({ action: "members" });
  await handleFgCommand(withGuild(guild, interaction), config.store);
  const embed = replies[0].embeds?.[0]?.toJSON() as { description?: string };
  assert.equal(embed.description, "Only Alex holds My FG.");
});

test("/fg members caps at 25 names with a +N more line", async () => {
  const holderIds = Array.from(
    { length: 26 },
    (_, i) => String(4000000000000000 + i + 1),
  );
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
  const memberRoleIds: Record<string, string[]> = {
    [MEMBER_ID]: [FG_ROLE_ID],
  };
  for (const id of holderIds) memberRoleIds[id] = [FG_ROLE_ID];
  const { guild, getMember } = createGuild({
    roles: [makeRole(FG_ROLE_ID, "My FG", 9)],
    memberRoleIds,
  });
  getMember(MEMBER_ID);
  for (const id of holderIds) getMember(id);
  const { interaction, replies } = createInteraction({ action: "members" });
  await handleFgCommand(withGuild(guild, interaction), config.store);
  const embed = replies[0].embeds?.[0]?.toJSON() as { description?: string };
  const lines = (embed.description ?? "").split("\n");
  assert.equal(lines.length, 26);
  assert.equal(lines[0], "Alex — Owner");
  assert.equal(lines[25], "+2 more");
});

test("/fg members works for an authorised sharer who does not own the role", async () => {
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
  const { guild, getMember } = createGuild({
    roles: [makeRole(FG_ROLE_ID, "My FG", 9)],
    memberRoleIds: { [MEMBER_ID]: [FG_ROLE_ID] },
  });
  getMember(MEMBER_ID);
  const { interaction, replies } = createInteraction({
    action: "members",
    userId: OTHER_ID,
  });
  await handleFgCommand(withGuild(guild, interaction), config.store);
  const embed = replies[0].embeds?.[0]?.toJSON() as { title?: string };
  assert.equal(embed.title, "Members of My FG");
});

test("/fg members errors for a caller with no FG role to report on", async () => {
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
  const { guild } = createGuild({
    roles: [makeRole(FG_ROLE_ID, "My FG", 9)],
    memberRoleIds: { [MEMBER_ID]: [FG_ROLE_ID] },
  });
  const { interaction, replies } = createInteraction({
    action: "members",
    userId: OTHER_ID,
  });
  await handleFgCommand(withGuild(guild, interaction), config.store);
  assert.match(replyTextOf(replies[0]), /aren't authorised to share an FG role/i);
});

test("/fg share accept DMs the FG owner when someone else shares their role", async () => {
  const config = createStore(
    makeSettings({
      fgRoleOwners: { [FG_ROLE_ID]: OWNER_ID },
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
  const { guild, addedByMember, getMember } = createGuild({
    roles: [makeRole(FG_ROLE_ID, "My FG", 9)],
    memberRoleIds: { [OTHER_ID]: [], [MEMBER_ID]: [] },
  });
  const { interaction, collector } = createInteraction({
    action: "share",
    userId: OTHER_ID,
    memberId: MEMBER_ID,
  });
  await handleFgCommand(withGuild(guild, interaction), config.store);

  const approve = makeButton("fg-share:approve", MEMBER_ID);
  await collector.fireCollect(approve);

  assert.match(buttonTextOf(approve), /accepted/i);
  assert.deepEqual(addedByMember.get(MEMBER_ID), [FG_ROLE_ID]);
  const dms = (
    getMember(OWNER_ID)! as unknown as { sentDMs: Reply[] }
  ).sentDMs;
  assert.equal(dms.length, 1);
  const dmText = (
    dms[0].embeds?.[0]?.toJSON() as { description?: string }
  ).description;
  assert.equal(dmText, "Sam shared your FG role My FG to Alex.");
});

test("/fg share accept sends no DM when the owner shares their own role", async () => {
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
    memberRoleIds: { [MEMBER_ID]: [FG_ROLE_ID], [OTHER_ID]: [] },
  });
  const { interaction, collector } = createInteraction({
    action: "share",
    memberId: OTHER_ID,
  });
  await handleFgCommand(withGuild(guild, interaction), config.store);

  const approve = makeButton("fg-share:approve", OTHER_ID);
  await collector.fireCollect(approve);

  assert.match(buttonTextOf(approve), /accepted/i);
  const dms = (
    getMember(MEMBER_ID)! as unknown as { sentDMs: Reply[] }
  ).sentDMs;
  assert.equal(dms.length, 0);
});

test("/fg share still completes when the owner DM fails", async () => {
  const config = createStore(
    makeSettings({
      fgRoleOwners: { [FG_ROLE_ID]: OWNER_ID },
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
  const { guild, addedByMember } = createGuild({
    roles: [makeRole(FG_ROLE_ID, "My FG", 9)],
    memberRoleIds: { [OTHER_ID]: [], [MEMBER_ID]: [] },
    failSendMemberIds: [OWNER_ID],
  });
  const { interaction, collector } = createInteraction({
    action: "share",
    userId: OTHER_ID,
    memberId: MEMBER_ID,
  });
  await handleFgCommand(withGuild(guild, interaction), config.store);

  const approve = makeButton("fg-share:approve", MEMBER_ID);
  await collector.fireCollect(approve);

  assert.match(buttonTextOf(approve), /accepted/i);
  assert.deepEqual(addedByMember.get(MEMBER_ID), [FG_ROLE_ID]);
});

test("/fg share with no role argument offers the caller's own FG role", async () => {
  const config = createStore(
    makeSettings({
      fgRoleOwners: { [FG_ROLE_ID]: MEMBER_ID, [SECOND_FG_ROLE_ID]: OTHER_ID },
      fgRoles: {
        [FG_ROLE_ID]: {
          assignUserIds: [],
          assignRoleIds: [],
          shareUserIds: [],
          shareRoleIds: [],
        },
        [SECOND_FG_ROLE_ID]: {
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
    roles: [
      makeRole(FG_ROLE_ID, "My FG", 9),
      makeRole(SECOND_FG_ROLE_ID, "Other FG", 8),
    ],
    memberRoleIds: { [MEMBER_ID]: [FG_ROLE_ID], [targetId]: [] },
  });
  const { interaction, replies, defers, editReplies } = createInteraction({
    action: "share",
    memberId: targetId,
  });

  await handleFgCommand(withGuild(guild, interaction), config.store);

  // An offer was sent (public plain message), for the caller's own role even
  // though another FG role exists.
  assert.equal(defers.length, 1);
  assert.equal(replies.length, 0);
  assert.equal(editReplies.length, 1);
  assert.equal(editReplies[0].embeds, undefined);
  assert.match(editReplies[0].content ?? "", new RegExp(`<@&${FG_ROLE_ID}>`));
  assert.doesNotMatch(editReplies[0].content ?? "", new RegExp(`<@&${SECOND_FG_ROLE_ID}>`));
});

test("/fg share offers the one FG role an authed member can share", async () => {
  // MEMBER_ID owns no FG role but is authed to share exactly one.
  const config = createStore(
    makeSettings({
      fgRoleOwners: { [FG_ROLE_ID]: OWNER_ID, [SECOND_FG_ROLE_ID]: OTHER_ID },
      fgRoleSharers: { [FG_ROLE_ID]: [MEMBER_ID] },
      fgRoles: {
        [FG_ROLE_ID]: {
          assignUserIds: [],
          assignRoleIds: [],
          shareUserIds: [],
          shareRoleIds: [],
        },
        [SECOND_FG_ROLE_ID]: {
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
    roles: [
      makeRole(FG_ROLE_ID, "My FG", 9),
      makeRole(SECOND_FG_ROLE_ID, "Other FG", 8),
    ],
    memberRoleIds: { [MEMBER_ID]: [], [targetId]: [] },
  });
  const { interaction, replies, defers, editReplies } = createInteraction({
    action: "share",
    memberId: targetId,
  });

  await handleFgCommand(withGuild(guild, interaction), config.store);

  assert.equal(defers.length, 1);
  assert.equal(replies.length, 0);
  assert.equal(editReplies.length, 1);
  assert.match(editReplies[0].content ?? "", new RegExp(`<@&${FG_ROLE_ID}>`));
});

test("/fg share errors when the caller can share more than one FG role", async () => {
  // MEMBER_ID is whitelisted (so authorised for every FG role) and owns
  // none: the bot cannot pick one for them.
  const config = createStore(
    twoFgRolesSettings({ allowedUserIds: [MEMBER_ID] }),
  );
  const targetId = "444444444444444444";
  const { guild } = createGuild({
    roles: [
      makeRole(FG_ROLE_ID, "My FG", 9),
      makeRole(SECOND_FG_ROLE_ID, "Other FG", 8),
    ],
    memberRoleIds: { [MEMBER_ID]: [], [targetId]: [] },
  });
  const { interaction, replies, defers, followUps } = createInteraction({
    action: "share",
    memberId: targetId,
  });

  await handleFgCommand(withGuild(guild, interaction), config.store);

  assert.equal(defers.length, 1);
  assert.equal(replies.length, 0);
  assert.equal(followUps.length, 1);
  assert.equal(followUps[0].ephemeral, true);
  assert.match(replyTextOf(followUps[0]), /can share more than one FG role/i);
  assert.match(replyTextOf(followUps[0]), new RegExp(`<@&${FG_ROLE_ID}>`));
  assert.match(replyTextOf(followUps[0]), new RegExp(`<@&${SECOND_FG_ROLE_ID}>`));
});

test("/fg share refuses a target who already holds a different FG role", async () => {
  const config = createStore(
    makeSettings({
      fgRoleOwners: { [FG_ROLE_ID]: MEMBER_ID, [SECOND_FG_ROLE_ID]: OWNER_ID },
      fgRoles: {
        [FG_ROLE_ID]: {
          assignUserIds: [],
          assignRoleIds: [],
          shareUserIds: [],
          shareRoleIds: [],
        },
        [SECOND_FG_ROLE_ID]: {
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
    roles: [
      makeRole(FG_ROLE_ID, "My FG", 9),
      makeRole(SECOND_FG_ROLE_ID, "Other FG", 8),
    ],
    memberRoleIds: {
      [MEMBER_ID]: [FG_ROLE_ID],
      [targetId]: [SECOND_FG_ROLE_ID],
    },
  });
  const { interaction, replies, defers, followUps } = createInteraction({
    action: "share",
    memberId: targetId,
  });

  await handleFgCommand(withGuild(guild, interaction), config.store);

  assert.equal(defers.length, 1);
  assert.equal(replies.length, 0);
  assert.equal(followUps.length, 1);
  assert.equal(followUps[0].ephemeral, true);
  assert.match(replyTextOf(followUps[0]), /already have an FG role/i);
});

test("/fg share refuses at accept time when the target gained an FG role", async () => {
  const config = createStore(
    makeSettings({
      fgRoleOwners: { [FG_ROLE_ID]: MEMBER_ID, [SECOND_FG_ROLE_ID]: OWNER_ID },
      fgRoles: {
        [FG_ROLE_ID]: {
          assignUserIds: [],
          assignRoleIds: [],
          shareUserIds: [],
          shareRoleIds: [],
        },
        [SECOND_FG_ROLE_ID]: {
          assignUserIds: [],
          assignRoleIds: [],
          shareUserIds: [],
          shareRoleIds: [],
        },
      },
    }),
  );
  const targetId = "444444444444444444";
  const { guild, getMember } = createGuild({
    roles: [
      makeRole(FG_ROLE_ID, "My FG", 9),
      makeRole(SECOND_FG_ROLE_ID, "Other FG", 8),
    ],
    memberRoleIds: { [MEMBER_ID]: [FG_ROLE_ID], [targetId]: [] },
  });
  const { interaction, replies, defers, editReplies, collector } = createInteraction({
    action: "share",
    memberId: targetId,
  });

  await handleFgCommand(withGuild(guild, interaction), config.store);

  // Offer was sent (deferred, then edited with the offer).
  assert.equal(defers.length, 1);
  assert.equal(replies.length, 0);
  assert.equal(editReplies.length, 1);
  // Between offer and accept, the target gains the other FG role.
  await (
    getMember(targetId)!.roles as {
      add: (role: unknown) => Promise<void>;
    }
  ).add(guild.roles.cache.get(SECOND_FG_ROLE_ID)!);
  const approve = makeButton("fg-share:approve", targetId);
  await collector.fireCollect(approve);

  assert.match(buttonTextOf(approve), /already has an FG role/i);
  assert.equal(
    (
      getMember(targetId)!.roles as {
        cache: { has: (id: string) => boolean };
      }
    ).cache.has(FG_ROLE_ID),
    false,
  );
});

test("/fg create refuses a target who holds a shared FG role", async () => {
  // OTHER_ID holds FG_ROLE_ID (owned by someone else) — holding any FG
  // role, owned or shared, blocks a new one.
  const config = createStore(
    makeSettings({
      allowedUserIds: [MEMBER_ID],
      fgBaseRoleId: BASE_ROLE_ID,
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
  const { guild, createdRoles } = createGuild({
    roles: [makeRole(BASE_ROLE_ID, "FG Base", 10), makeRole(FG_ROLE_ID, "My FG", 9)],
    memberRoleIds: { [OTHER_ID]: [FG_ROLE_ID] },
  });
  const { interaction, replies, defers } = createInteraction({
    action: "create",
    memberId: OTHER_ID,
    strings: { name: "Second FG" },
  });

  await handleFgCommand(withGuild(guild, interaction), config.store);

  assert.equal(createdRoles.length, 0);
  // A functional error still replies — only authorisation failures
  // are silently ignored.
  assert.deepEqual(defers, []);
  assert.match(replyTextOf(replies[0]), /already have an FG role/i);
});
