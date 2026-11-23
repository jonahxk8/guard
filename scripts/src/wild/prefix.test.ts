import assert from "node:assert/strict";
import test from "node:test";
import { deflateSync } from "node:zlib";
import { ChannelType, Message, PermissionFlagsBits } from "discord.js";
import { ConfigStore, GuildSettings } from "./config-store.js";
import { handlePrefixMessage, parsePrefixMessage } from "./prefix.js";

const GUILD_ID = "111111111111111111";
const OWNER_ID = "999999999999999999";
const USER_ID = "222222222222222222";
const OTHER_ID = "333333333333333333";
const ROLE_ID = "444444444444444444";
const CHANNEL_ID = "555555555555555555";
const FG_ROLE_ID = "666666666666666666";

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

interface SentMessage {
  content?: string;
  embeds?: Array<{ toJSON: () => Record<string, unknown> }>;
  deleted: boolean;
}

/** Text of a sent prefix reply: now always an embed description, never plain content. */
function sentTextOf(sent: SentMessage): string {
  const embed = sent.embeds?.[0]?.toJSON() as { description?: string } | undefined;
  return embed?.description ?? sent.content ?? "";
}

function makeButton(customId: string, userId: string) {
  const button = {
    customId,
    user: { id: userId },
    replied: false,
    deferred: false,
    replies: [] as Array<Record<string, unknown>>,
    updates: [] as Array<Record<string, unknown>>,
    reply: async (options: Record<string, unknown>) => {
      button.replied = true;
      button.replies.push(options);
    },
    update: async (options: Record<string, unknown>) => {
      button.replied = true;
      button.updates.push(options);
    },
    deferUpdate: async () => {
      button.deferred = true;
    },
  };
  return button;
}

/** Text of a button interaction's update (or reply): embed description. */
function buttonTextOf(button: ReturnType<typeof makeButton>): string {
  const update = button.updates[0];
  const embed = update?.embeds as
    | Array<{ toJSON: () => { description?: string } }>
    | undefined;
  return embed?.[0]?.toJSON().description ?? "";
}

function createMessage(options: {
  content: string;
  settings?: GuildSettings;
  canManageServer?: boolean;
  /**
   * The author holds a role with the Discord Administrator permission
   * (literal role bits: Administrator only — Manage Server is false
   * unless canManageServer is also set). Models a Discord-Admin-only
   * member on the prefix path, where the fake interaction carries the
   * member's literal role bits.
   */
  authorIsAdmin?: boolean;
  botAboveRole?: boolean;
  authorId?: string;
  authorIsBot?: boolean;
  guild?: Record<string, unknown> | null;
  roles?: Array<{ id: string; managed?: boolean; isAdmin?: boolean }>;
  memberRoleIds?: Record<string, string[]>;
}) {
  const sent: SentMessage[] = [];
  const dms: Array<{ to: string; options: Record<string, unknown> }> = [];
  const collectors: Array<{
    on: (event: string, fn: (...args: unknown[]) => unknown) => void;
    stop: (reason?: string) => void;
    fireCollect: (button: unknown) => Promise<void>;
    fireEnd: (reason: string) => Promise<void>;
  }> = [];
  let commandDeleted = false;
  const rolesCache = new Map(
    (options.roles ?? [{ id: ROLE_ID }]).map((role) => {
      const entry = {
        id: role.id,
        name: "Role",
        position: 10,
        managed: role.managed ?? false,
        permissions: {
          has: (permission: bigint) =>
            permission === PermissionFlagsBits.Administrator &&
            (role.isAdmin ?? false),
        },
        deleted: false,
        setName: async (name: string) => {
          entry.name = name;
          return entry;
        },
        setIcon: async () => entry,
        setUnicodeEmoji: async () => entry,
        setColors: async (colors: Record<string, unknown>) => {
          (entry as { color?: string }).color = colors.primaryColor as string;
          return entry;
        },
        delete: async () => {
          entry.deleted = true;
        },
      };
      return [role.id, entry];
    }),
  );
  const botMember = {
    permissions: {
      has: () => true,
    },
    roles: {
      highest: {
        comparePositionTo: () => (options.botAboveRole === false ? -1 : 1),
      },
    },
  };
  const members = new Map<string, Record<string, unknown>>();
  const getMember = (memberId: string) => {
    if (!members.has(memberId)) {
      const held = new Set(options.memberRoleIds?.[memberId] ?? []);
      const displayName =
        memberId === USER_ID ? "Alex" : memberId === OTHER_ID ? "Sam" : "Member";
      members.set(memberId, {
        id: memberId,
        displayName,
        displayAvatarURL: () =>
          `https://cdn.discordapp.com/avatars/${memberId}/avatar.png`,
        user: { id: memberId, username: displayName },
        permissions: {
          has: (permission: bigint) =>
            (permission === PermissionFlagsBits.Administrator &&
              (options.authorIsAdmin ?? false)) ||
            (permission === PermissionFlagsBits.ManageGuild &&
              (options.canManageServer ?? true)),
        },
        roles: {
          cache: {
            has: (roleId: string) => held.has(roleId),
            some: (predicate: (role: { id: string }) => boolean) =>
              [...held].some((roleId) => predicate({ id: roleId })),
          },
          add: async (role: { id: string }) => {
            held.add(role.id);
          },
          remove: async (role: { id: string }) => {
            held.delete(role.id);
          },
        },
        send: async (sendOptions: Record<string, unknown>) => {
          dms.push({ to: memberId, options: sendOptions });
        },
      });
    }
    return members.get(memberId)!;
  };
  const channel = {
    id: CHANNEL_ID,
    type: ChannelType.GuildText,
    permissionsFor: () => ({ has: () => true }),
    send: async (messageOptions: Record<string, unknown>) => {
      const handlers: Record<string, Array<(...args: unknown[]) => unknown>> = {};
      const collector = {
        on: (event: string, fn: (...args: unknown[]) => unknown) => {
          (handlers[event] ??= []).push(fn);
        },
        stop: (_reason?: string) => {},
        fireCollect: async (button: unknown) => {
          for (const fn of handlers.collect ?? []) await fn(button);
        },
        fireEnd: async (reason: string) => {
          for (const fn of handlers.end ?? []) await fn(undefined, reason);
        },
      };
      collectors.push(collector);
      const sentMessage: SentMessage = {
        content: messageOptions.content as string | undefined,
        embeds: messageOptions.embeds as SentMessage["embeds"],
        deleted: false,
      };
      const record = sentMessage as unknown as Record<string, unknown>;
      record.edits = [] as Array<Record<string, unknown>>;
      record.delete = async () => {
        sentMessage.deleted = true;
      };
      record.edit = async (editOptions: Record<string, unknown>) => {
        (record.edits as Array<Record<string, unknown>>).push(editOptions);
        return sentMessage;
      };
      record.createMessageComponentCollector = () => collector;
      sent.push(sentMessage);
      return sentMessage;
    },
  };
  const guild =
    options.guild === undefined
      ? {
          id: GUILD_ID,
          ownerId: OWNER_ID,
          premiumTier: 0,
          members: {
            me: botMember,
            // No argument fetches every member (used by /fg members).
            fetch: async (arg?: string | { user?: string }) => {
              if (arg === undefined) return new Map(members);
              return getMember(typeof arg === "string" ? arg : (arg.user ?? ""));
            },
            fetchMe: async () => botMember,
          },
          roles: {
            cache: rolesCache,
            create: async (createOptions: Record<string, unknown>) => {
              const role = {
                id: "100000000000000001",
                name: createOptions.name as string,
                position: 5,
                managed: false,
                permissions: { has: () => false },
                deleted: false,
                setName: async (name: string) => {
                  (role as { name: string }).name = name;
                  return role;
                },
                setIcon: async () => role,
                setUnicodeEmoji: async () => role,
                setColors: async (colors: Record<string, unknown>) => {
                  (role as { color?: string }).color =
                    colors.primaryColor as string;
                  return role;
                },
                delete: async () => {
                  (role as { deleted: boolean }).deleted = true;
                },
              };
              rolesCache.set(role.id, role as never);
              return role;
            },
          },
          channels: {
            cache: new Map([[CHANNEL_ID, channel]]),
          },
        }
      : options.guild;
  const message = {
    content: options.content,
    author: { id: options.authorId ?? USER_ID, username: "Alex", bot: options.authorIsBot ?? false },
    guild,
    member: guild ? getMember(options.authorId ?? USER_ID) : null,
    channel,
    delete: async () => {
      commandDeleted = true;
    },
  } as unknown as Message;
  return {
    message,
    sent,
    dms,
    collectors,
    get commandDeleted() {
      return commandDeleted;
    },
  };
}

/** Small CRC32 + 1x1 PNG builder, for avatar-color tests. */
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

/** Stub global fetch so avatar reads return the given PNG. */
function stubAvatarFetch(png: Buffer): () => void {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => ({
    ok: true,
    arrayBuffer: async () =>
      png.buffer.slice(png.byteOffset, png.byteOffset + png.byteLength),
  })) as unknown as typeof fetch;
  return () => {
    globalThis.fetch = originalFetch;
  };
}

test("parsePrefixMessage parses mentions, raw ids, and fg color args", () => {
  assert.deepEqual(parsePrefixMessage(",guard <@&444444444444444444>"), {
    command: "guard",
    args: {
      roles: { role: "444444444444444444" },
      users: {},
      channels: {},
      strings: {},
      subcommand: "",
      subcommandGroup: null,
    },
  });
  // ,fg color is now a recolor only: the whole tail is the color spec.
  const fg = parsePrefixMessage(",fg color #ff0000 #00ff00");
  assert.equal(fg && "args" in fg && fg.args.subcommand, "color");
  assert.equal(fg && "args" in fg && fg.args.strings.color, "#ff0000 #00ff00");
  const single = parsePrefixMessage(",fg color #ff0000");
  assert.equal(single && "args" in single && single.args.strings.color, "#ff0000");
  const twoComma = parsePrefixMessage(",fg color #ff0000,#0000ff");
  assert.equal(twoComma && "args" in twoComma && twoComma.args.strings.color, "#ff0000 #0000ff");
  const nameRejected = parsePrefixMessage(",fg color blue");
  assert.ok(
    nameRejected && "error" in nameRejected,
    "color names are invalid — hex codes only",
  );
  const tooMany = parsePrefixMessage(",fg color #ff0000 #0000ff #00ff00");
  assert.equal(
    tooMany && "error" in tooMany && tooMany.error,
    "Too many colors — give one color, or two for a gradient.",
  );
  const random = parsePrefixMessage(",fg color random");
  assert.equal(random && "args" in random && random.args.strings.color, "random");
  const holo = parsePrefixMessage(",fg color holo");
  assert.equal(holo && "args" in holo && holo.args.strings.color, "holo");
  const dominant = parsePrefixMessage(",fg color dominant");
  assert.equal(dominant && "args" in dominant && dominant.args.strings.color, "dominant");
  const noColor = parsePrefixMessage(",fg color");
  assert.ok(noColor && "error" in noColor);
  // ,fg create is now name + optional member only: no color anymore.
  const create = parsePrefixMessage(",fg create My Cool Role");
  assert.equal(create && "args" in create && create.args.subcommand, "create");
  assert.equal(create && "args" in create && create.args.strings.name, "My Cool Role");
  assert.equal(create && "args" in create && create.args.users.member, undefined);
  const createFor = parsePrefixMessage(",fg create Sam FG <@333333333333333333>");
  assert.equal(createFor && "args" in createFor && createFor.args.strings.name, "Sam FG");
  assert.equal(createFor && "args" in createFor && createFor.args.users.member, "333333333333333333");
  const createRawId = parsePrefixMessage(",fg create Sam FG 333333333333333333");
  assert.equal(createRawId && "args" in createRawId && createRawId.args.strings.name, "Sam FG");
  assert.equal(createRawId && "args" in createRawId && createRawId.args.users.member, "333333333333333333");
  const createEmpty = parsePrefixMessage(",fg create");
  assert.ok(createEmpty && "error" in createEmpty);
  const createOldSyntax = parsePrefixMessage(",fg create My Role #ff0000");
  // No color argument anymore: a trailing hex is just part of the name.
  assert.equal(createOldSyntax && "args" in createOldSyntax && createOldSyntax.args.strings.name, "My Role #ff0000");
  const authAdd = parsePrefixMessage(",fg auth add <@333333333333333333>");
  assert.equal(authAdd && "args" in authAdd && authAdd.args.subcommandGroup, "auth");
  assert.equal(authAdd && "args" in authAdd && authAdd.args.subcommand, "add");
  assert.equal(authAdd && "args" in authAdd && authAdd.args.users.member, "333333333333333333");
  // A role argument is no longer taken: the bot works out which FG
  // role from the caller, like ,fg share.
  const authAddWithRole = parsePrefixMessage(",fg auth add <@333333333333333333> <@&666666666666666666>");
  assert.equal(
    authAddWithRole && "error" in authAddWithRole && authAddWithRole.error,
    "Use ,help fg to see FG commands.",
  );
  const authList = parsePrefixMessage(",fg auth list <@&666666666666666666>");
  assert.equal(authList && "args" in authList && authList.args.subcommand, "list");
  assert.equal(authList && "args" in authList && authList.args.roles.role, "666666666666666666");
  const authListNoRole = parsePrefixMessage(",fg auth list");
  assert.equal(authListNoRole && "args" in authListNoRole && authListNoRole.args.subcommand, "list");
  const shareWithRole = parsePrefixMessage(",fg share <@333333333333333333> <@&666666666666666666>");
  assert.equal(
    shareWithRole && "error" in shareWithRole && shareWithRole.error,
    "Use ,help fg to see FG commands.",
  );
  const award = parsePrefixMessage(",fg award view");
  assert.equal(award && "error" in award && award.error, "Use ,help fg to see FG commands.");
  const help = parsePrefixMessage(",help fg create");
  assert.equal(help && "args" in help && help.args.strings.topic, "fg create");
  assert.equal(parsePrefixMessage(",boosterrole base"), null);
  assert.equal(parsePrefixMessage(",br"), null);
  assert.equal(parsePrefixMessage(",autorole"), null);
  // Greed owns ,protect and ,setup — Wild stays silent on both.
  assert.equal(parsePrefixMessage(",protect"), null);
  assert.equal(parsePrefixMessage(",setup"), null);
  assert.equal(parsePrefixMessage("hello"), null);
  assert.equal(parsePrefixMessage(","), null);
});

test(",guard routes to the same handler as /protect and deletes the command", async () => {
  const config = createStore();
  const { message, sent } = createMessage({ content: ",guard <@&444444444444444444>" });

  assert.equal(await handlePrefixMessage(message, config.store), true);

  assert.deepEqual(config.getSettings().protectedRoleIds, [ROLE_ID]);
  assert.equal(sent.length, 1);
  assert.match(sentTextOf(sent[0]), /now protected/i);
  assert.equal(sent[0].deleted, false, "success replies stay");
});

test(",guard by a non-whitelisted admin is silently ignored", async () => {
  // An authorisation failure on the prefix path sends NO reply at
  // all — not even an error embed. The user's command message is
  // still deleted, as with every other prefix command.
  const config = createStore();
  const created = createMessage({
    content: ",guard <@&444444444444444444>",
    authorIsAdmin: true,
    canManageServer: false,
  });

  assert.equal(await handlePrefixMessage(created.message, config.store), true);

  assert.deepEqual(config.getSettings().protectedRoleIds, []);
  assert.deepEqual(created.sent, []);
  assert.equal(created.commandDeleted, true);
});

test(",guard by an authorised caller still works", async () => {
  // The ignore is only for authorisation failures: a whitelisted
  // member without Manage Server can still use ,guard.
  const config = createStore(makeSettings({ allowedUserIds: [USER_ID] }));
  const { message, sent } = createMessage({
    content: ",guard <@&444444444444444444>",
    canManageServer: false,
  });

  assert.equal(await handlePrefixMessage(message, config.store), true);

  assert.deepEqual(config.getSettings().protectedRoleIds, [ROLE_ID]);
  assert.equal(sent.length, 1);
  assert.match(sentTextOf(sent[0]), /now protected/i);
});

test(",whitelist toggles a user and a role", async () => {
  const config = createStore();
  const addUser = createMessage({ content: ",whitelist <@222222222222222222>" });
  await handlePrefixMessage(addUser.message, config.store);
  assert.deepEqual(config.getSettings().allowedUserIds, [USER_ID]);

  const addRole = createMessage({ content: ",whitelist <@&444444444444444444>" });
  await handlePrefixMessage(addRole.message, config.store);
  assert.deepEqual(config.getSettings().allowedRoleIds, [ROLE_ID]);

  // A raw id that is not a role is treated as a user.
  const rawUser = createMessage({ content: ",whitelist 333333333333333333" });
  await handlePrefixMessage(rawUser.message, config.store);
  assert.deepEqual(config.getSettings().allowedUserIds, [USER_ID, OTHER_ID]);
});

test(",status sends the colorless embed and ,logchannel off turns alerts off", async () => {
  const config = createStore(
    makeSettings({ protectedRoleIds: [ROLE_ID], logChannelId: CHANNEL_ID }),
  );
  const status = createMessage({ content: ",status" });
  await handlePrefixMessage(status.message, config.store);
  assert.equal(status.sent.length, 1);
  assert.equal(status.sent[0].embeds?.[0].toJSON().color, undefined); // No color set.
  const statusFields = Object.fromEntries(
    (
      (status.sent[0].embeds?.[0].toJSON().fields ?? []) as {
        name: string;
        value: string;
      }[]
    ).map((field) => [field.name, field.value]),
  );
  assert.ok(`Protected roles (1)` in statusFields);
  assert.equal(statusFields["Bot"], "Ready");

  const setup = createMessage({ content: ",logchannel off" });
  await handlePrefixMessage(setup.message, config.store);
  assert.equal(config.getSettings().logChannelId, null);
  assert.match(sentTextOf(setup.sent[0]), /Alerts are turned off/i);
});

test(",fg color recolors your FG role through the shared handler", async () => {
  const config = createStore(
    makeSettings({
      allowedUserIds: [USER_ID],
      fgRoleOwners: { [FG_ROLE_ID]: USER_ID },
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
  const { message, sent } = createMessage({
    content: ",fg color #ff0000",
    roles: [{ id: FG_ROLE_ID }],
  });

  assert.equal(await handlePrefixMessage(message, config.store), true);

  assert.match(sentTextOf(sent[0]), /Your FG role is now #ff0000/i);
});

test(",fg remove asks for confirmation and deletes nothing yet", async () => {
  const config = createStore(
    makeSettings({
      fgRoleOwners: { [FG_ROLE_ID]: USER_ID },
      fgRoles: {
        [FG_ROLE_ID]: {
          assignUserIds: [],
          assignRoleIds: [],
          shareUserIds: [],
          shareRoleIds: [],
        },
      },
      protectedRoleIds: [FG_ROLE_ID],
    }),
  );
  const created = createMessage({
    content: ",fg remove",
    roles: [{ id: FG_ROLE_ID }],
  });
  const { message, sent } = created;

  assert.equal(await handlePrefixMessage(message, config.store), true);

  // The confirmation is public on prefix, the role is still there, and
  // the invoking message is deleted like other prefix commands.
  assert.equal(sent.length, 1);
  const embed = sent[0].embeds?.[0]?.toJSON() as {
    title?: string;
    description?: string;
    fields?: Array<{ name?: string; value?: string }>;
  };
  assert.equal(embed.title, "Remove FG role");
  assert.match(embed.description ?? "", /Delete Role for good/);
  assert.deepEqual(config.getSettings().fgRoleOwners, { [FG_ROLE_ID]: USER_ID });
  assert.equal(created.commandDeleted, true);
});

test(",fg rename and ,fg share route to the shared FG handler", async () => {
  const config = createStore(
    makeSettings({
      allowedUserIds: [USER_ID],
      fgRoleOwners: { [FG_ROLE_ID]: USER_ID },
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
  const rename = createMessage({
    content: ",fg rename New Name",
    roles: [{ id: FG_ROLE_ID }],
  });
  await handlePrefixMessage(rename.message, config.store);
  assert.match(sentTextOf(rename.sent[0]), /now called/i);

  // ,fg share takes only @member: the bot offers the caller's own FG role.
  const share = createMessage({
    content: ",fg share <@333333333333333333>",
    roles: [{ id: FG_ROLE_ID }],
  });
  await handlePrefixMessage(share.message, config.store);
  const embed = share.sent[0].embeds?.[0]?.toJSON() as {
    title?: string;
    description?: string;
    fields?: unknown[];
  };
  assert.equal(embed.title, "fg share");
  assert.equal(embed.fields, undefined);
  assert.match(embed.description ?? "", /is offering/);
  assert.match(embed.description ?? "", new RegExp(`<@&${FG_ROLE_ID}>`));
});

test(",fg share end-to-end: offer, Yes accept, role added, owner DM only for non-owner sharers", async () => {
  // The caller owns the FG role; the target accepts the offer.
  const config = createStore(
    makeSettings({
      allowedUserIds: [USER_ID],
      fgRoleOwners: { [FG_ROLE_ID]: USER_ID },
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
  const share = createMessage({
    content: ",fg share <@333333333333333333>",
    roles: [{ id: FG_ROLE_ID }],
    memberRoleIds: { [USER_ID]: [FG_ROLE_ID] },
  });
  assert.equal(await handlePrefixMessage(share.message, config.store), true);

  // The offer went out: content pings the target, embed names the role.
  assert.equal(share.sent.length, 1);
  assert.equal(share.sent[0].content, `<@${OTHER_ID}>`);
  const offerEmbed = share.sent[0].embeds?.[0]?.toJSON() as {
    title?: string;
    description?: string;
  };
  assert.equal(offerEmbed.title, "fg share");
  assert.match(offerEmbed.description ?? "", /is offering/);

  // The target taps Yes: the role is added, the offer edits to accepted.
  assert.equal(share.collectors.length, 1);
  const yes = makeButton("fg-share:yes", OTHER_ID);
  await share.collectors[0].fireCollect(yes);
  assert.equal(yes.updates.length, 1);
  const acceptedEmbeds = yes.updates[0].embeds as Array<{
    toJSON: () => { title?: string; description?: string };
  }>;
  const accepted = acceptedEmbeds[0]?.toJSON() as {
    title?: string;
    description?: string;
  };
  assert.equal(accepted.title, "fg share accepted");
  assert.match(accepted.description ?? "", /accepted/);
  // No generic error reply was sent at any point.
  assert.equal(
    share.sent.filter((message) => /couldn't complete that command/i.test(sentTextOf(message)))
      .length,
    0,
  );
  // The owner shared their own role, so no owner DM about their own action.
  assert.equal(share.dms.length, 0);
});

test(",fg share by an authed non-owner DMs the FG owner on accept", async () => {
  // OTHER_ID is authed to share USER_ID's FG role; the target accepts.
  const TARGET_ID = "444444444444444444";
  const config = createStore(
    makeSettings({
      fgRoleOwners: { [FG_ROLE_ID]: USER_ID },
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
  const share = createMessage({
    content: ",fg share <@444444444444444444>",
    authorId: OTHER_ID,
    roles: [{ id: FG_ROLE_ID }],
    memberRoleIds: { [USER_ID]: [FG_ROLE_ID] },
  });
  assert.equal(await handlePrefixMessage(share.message, config.store), true);
  assert.equal(share.sent.length, 1);
  assert.equal(share.collectors.length, 1);

  const yes = makeButton("fg-share:yes", TARGET_ID);
  await share.collectors[0].fireCollect(yes);
  const acceptedEmbeds = yes.updates[0].embeds as Array<{
    toJSON: () => { title?: string };
  }>;
  const accepted = acceptedEmbeds[0]?.toJSON() as { title?: string };
  assert.equal(accepted.title, "fg share accepted");
  // The FG owner hears about it: one DM, naming the sharer and the role.
  assert.equal(share.dms.length, 1);
  assert.equal(share.dms[0].to, USER_ID);
  const dmText = (
    share.dms[0].options.embeds as Array<{ toJSON: () => { description?: string } }>
  )[0]
    .toJSON()
    .description;
  assert.match(dmText ?? "", /shared your FG role/);
});

test(",fg holders no longer exists", async () => {
  const parsed = parsePrefixMessage(",fg holders");
  assert.ok(parsed && "error" in parsed);
  assert.equal(parsed.error, "Use ,help fg to see FG commands.");
});

test(",fg assign no longer exists", async () => {
  const parsed = parsePrefixMessage(",fg assign <@333333333333333333> <@&666666666666666666>");
  assert.ok(parsed && "error" in parsed);
  assert.equal(parsed.error, "Use ,help fg to see FG commands.");
});

test(",fg drop gives back a shared FG role", async () => {
  const config = createStore(
    makeSettings({
      fgRoleOwners: { [FG_ROLE_ID]: "333333333333333333" },
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
  const { message, sent } = createMessage({
    content: ",fg drop",
    roles: [{ id: FG_ROLE_ID }],
    memberRoleIds: { [USER_ID]: [FG_ROLE_ID] },
  });
  assert.equal(await handlePrefixMessage(message, config.store), true);
  assert.match(sentTextOf(sent[0]), /Dropped <@&/);
});

test(",fg members lists the members of the caller's FG role", async () => {
  const config = createStore(
    makeSettings({
      fgRoleOwners: { [FG_ROLE_ID]: USER_ID },
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
  const { message, sent } = createMessage({
    content: ",fg members",
    roles: [{ id: FG_ROLE_ID }],
    memberRoleIds: { [USER_ID]: [FG_ROLE_ID] },
  });
  assert.equal(await handlePrefixMessage(message, config.store), true);
  const embed = sent[0].embeds?.[0]?.toJSON() as {
    title?: string;
    description?: string;
  };
  assert.match(embed.title ?? "", /Members of/);
  // Only the owner holds it here, so the one-line form is used.
  assert.match(embed.description ?? "", /Only Alex holds Role\./);
});

test(",fg create gives the new FG role to the named member", async () => {
  const config = createStore(
    makeSettings({
      allowedUserIds: [USER_ID],
      fgBaseRoleId: ROLE_ID,
    }),
  );
  const { message, sent } = createMessage({
    content: ",fg create Sam FG <@333333333333333333>",
    roles: [{ id: ROLE_ID }],
  });

  const restoreFetch = stubAvatarFetch(solidPng(255, 0, 0));
  try {
    assert.equal(await handlePrefixMessage(message, config.store), true);
  } finally {
    restoreFetch();
  }

  assert.match(sentTextOf(sent[0]), /Created FG role Sam FG for Sam/i);
  assert.equal(
    config.getSettings().fgRoleOwners["100000000000000001"],
    OTHER_ID,
  );
  const target = await (
    message.guild as unknown as {
      members: {
        fetch: (id: string) => Promise<{
          roles: { cache: { has: (id: string) => boolean } };
        }>;
      };
    }
  ).members.fetch(OTHER_ID);
  assert.equal(target.roles.cache.has("100000000000000001"), true);
});

test(",fg add registers an existing role through the shared handler", async () => {
  const config = createStore(
    makeSettings({
      allowedUserIds: [USER_ID],
      fgBaseRoleId: ROLE_ID,
    }),
  );
  const { message, sent } = createMessage({
    content: ",fg add <@&666666666666666666> <@333333333333333333>",
    roles: [{ id: ROLE_ID }, { id: FG_ROLE_ID }],
  });

  assert.equal(await handlePrefixMessage(message, config.store), true);

  assert.match(sentTextOf(sent[0]), /is now Sam's FG role/i);
  assert.equal(config.getSettings().fgRoleOwners[FG_ROLE_ID], OTHER_ID);
  assert.ok(config.getSettings().protectedRoleIds.includes(FG_ROLE_ID));
  const target = await (
    message.guild as unknown as {
      members: {
        fetch: (id: string) => Promise<{
          roles: { cache: { has: (id: string) => boolean } };
        }>;
      };
    }
  ).members.fetch(OTHER_ID);
  assert.equal(target.roles.cache.has(FG_ROLE_ID), true);
});

test(",fg add with only a role errors and never defaults the owner to the caller", async () => {
  const config = createStore(
    makeSettings({
      allowedUserIds: [USER_ID],
      fgBaseRoleId: ROLE_ID,
    }),
  );
  const { message, sent } = createMessage({
    content: ",fg add <@&666666666666666666>",
    roles: [{ id: ROLE_ID }, { id: FG_ROLE_ID }],
  });

  assert.equal(await handlePrefixMessage(message, config.store), true);

  assert.match(sentTextOf(sent[0]), /Say who the role belongs to: ,fg add @role @member/);
  assert.equal(config.getSettings().fgRoleOwners[FG_ROLE_ID], undefined);
  assert.equal(config.getSettings().fgRoles[FG_ROLE_ID], undefined);
});

test(",fg auth add and ,fg auth list route to the shared FG handler", async () => {
  const config = createStore(
    makeSettings({
      fgRoleOwners: { [FG_ROLE_ID]: USER_ID },
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
  const add = createMessage({
    content: ",fg auth add <@333333333333333333>",
    roles: [{ id: FG_ROLE_ID }],
  });
  await handlePrefixMessage(add.message, config.store);
  assert.deepEqual(config.getSettings().fgRoleSharers, {
    [FG_ROLE_ID]: [OTHER_ID],
  });
  assert.match(sentTextOf(add.sent[0]), /can now share/i);

  const list = createMessage({
    content: ",fg auth list",
    roles: [{ id: FG_ROLE_ID }],
  });
  await handlePrefixMessage(list.message, config.store);
  const embed = list.sent[0].embeds?.[0].toJSON();
  const fields = (embed?.fields ?? []) as { name: string; value: string }[];
  assert.equal(embed?.title, "Who can share Role");
  assert.match(fields[0]?.value ?? "", /Owner: Alex/);
  assert.match(fields[0]?.value ?? "", /Sam/);
});

test(",blacklist add/remove/list parse and route to the same handlers", async () => {
  const config = createStore(makeSettings({ protectedRoleIds: [ROLE_ID] }));

  const add = createMessage({
    content: ",blacklist add <@222222222222222222> <@&444444444444444444>",
  });
  await handlePrefixMessage(add.message, config.store);
  assert.deepEqual(config.getSettings().blacklist, { [USER_ID]: [ROLE_ID] });
  assert.match(sentTextOf(add.sent[0]), /now blacklisted from/i);

  const list = createMessage({
    content: ",blacklist list",
    roles: [{ id: ROLE_ID }],
  });
  await handlePrefixMessage(list.message, config.store);
  const listEmbed = list.sent[0].embeds?.[0].toJSON();
  const listFields = (listEmbed?.fields ?? []) as {
    name: string;
    value: string;
  }[];
  assert.equal(listEmbed?.title, "Blacklist");
  assert.equal(listFields.length, 1);
  assert.equal(listFields[0].name, "1. Alex");
  assert.equal(listFields[0].value, "Blacklisted from Role");

  const remove = createMessage({
    content: ",blacklist remove <@222222222222222222> <@&444444444444444444>",
  });
  await handlePrefixMessage(remove.message, config.store);
  assert.deepEqual(config.getSettings().blacklist, {});
});

test(",blacklist add for an unprotected role errors", async () => {
  const config = createStore();
  const { message, sent } = createMessage({
    content: ",blacklist add <@222222222222222222> <@&444444444444444444>",
  });

  await handlePrefixMessage(message, config.store);

  assert.deepEqual(config.getSettings().blacklist, {});
  assert.match(sentTextOf(sent[0]), /Protect that role first/i);
});

test("an unknown ',' command gets no reply and the message is left alone", async () => {
  const config = createStore();
  for (const content of [",boosterrole", ",br", ",autorole", ",role", ",protect", ",setup", ",nope"]) {
    const { message, sent } = createMessage({ content });
    assert.equal(await handlePrefixMessage(message, config.store), false);
    assert.equal(sent.length, 0);
  }
});

test("non-prefix messages, bot messages, and DMs are ignored", async () => {
  const config = createStore();
  const plain = createMessage({ content: "hello there" });
  assert.equal(await handlePrefixMessage(plain.message, config.store), false);
  assert.equal(plain.sent.length, 0);

  const bot = createMessage({ content: ",status", authorIsBot: true });
  assert.equal(await handlePrefixMessage(bot.message, config.store), false);
  assert.equal(bot.sent.length, 0);

  const dm = createMessage({ content: ",status", guild: null });
  assert.equal(await handlePrefixMessage(dm.message, config.store), false);
  assert.equal(dm.sent.length, 0);
});

test("a usage error replies with usage and the command message is deleted", async () => {
  const config = createStore();
  const { message, sent } = createMessage({ content: ",guard" });

  assert.equal(await handlePrefixMessage(message, config.store), true);

  assert.equal(sent.length, 1);
  assert.match(sentTextOf(sent[0]), /Usage: ,guard @role/);
});

test("bare ,fg and ,blacklist point at help instead of a usage wall", async () => {
  const config = createStore();
  for (const content of [",fg", ",fg nonsense", ",blacklist", ",blacklist nope"]) {
    const { message, sent } = createMessage({ content });
    assert.equal(await handlePrefixMessage(message, config.store), true);
    assert.equal(sent.length, 1);
    assert.doesNotMatch(sentTextOf(sent[0]), /\|/);
    assert.match(sentTextOf(sent[0]), /Use ,help (fg|blacklist) to see/);
  }
});

test(",whitelist on the prefix path says the name, never [object Object]", async () => {
  const config = createStore();
  const addUser = createMessage({ content: ",whitelist <@222222222222222222>" });
  await handlePrefixMessage(addUser.message, config.store);
  assert.match(sentTextOf(addUser.sent[0]), /Alex is now whitelisted/i);
  assert.doesNotMatch(sentTextOf(addUser.sent[0]), /\[object Object\]/);

  const addRole = createMessage({ content: ",whitelist <@&444444444444444444>" });
  await handlePrefixMessage(addRole.message, config.store);
  assert.match(sentTextOf(addRole.sent[0]), /Role is now whitelisted/i);
  assert.doesNotMatch(sentTextOf(addRole.sent[0]), /\[object Object\]/);
});

test(",fg create creates an FG role for a named member through the prefix", async () => {
  const config = createStore(
    makeSettings({ allowedUserIds: [USER_ID], fgBaseRoleId: ROLE_ID }),
  );
  const { message, sent } = createMessage({
    content: ",fg create Sam FG <@333333333333333333>",
    roles: [{ id: ROLE_ID }],
  });

  // Sam's avatar is solid red, so the role takes that color.
  const restoreFetch = stubAvatarFetch(solidPng(255, 0, 0));
  try {
    assert.equal(await handlePrefixMessage(message, config.store), true);
  } finally {
    restoreFetch();
  }

  const settings = config.getSettings();
  assert.deepEqual(settings.fgRoleOwners, { "100000000000000001": OTHER_ID });
  assert.match(sentTextOf(sent[0]), /Created FG role Sam FG for Sam/i);
  assert.match(sentTextOf(sent[0]), /matches their profile picture/i);
  assert.doesNotMatch(sentTextOf(sent[0]), /\[object Object\]/);
});

test(",fg create by a non-whitelisted member is silently ignored", async () => {
  const config = createStore(makeSettings({ fgBaseRoleId: ROLE_ID }));
  const created = createMessage({
    content: ",fg create Nope",
    roles: [{ id: ROLE_ID }],
    canManageServer: false,
  });

  await handlePrefixMessage(created.message, config.store);

  assert.deepEqual(config.getSettings().fgRoleOwners, {});
  // No reply at all — not even an error embed. The user's command
  // message is still deleted, as with every other prefix command.
  assert.deepEqual(created.sent, []);
  assert.equal(created.commandDeleted, true);
});

test(",help for a Manage Server member shows what everyone sees, with prefix syntax", async () => {
  // Manage Server alone grants nothing in help: a member with it (but
  // no staff admin role and not whitelisted) sees exactly what a plain
  // member sees — the FG category with the no-FG-role note, no Guard,
  // no Blacklist, and no fg base / fg cleanup / fg list. (The mock
  // member has Manage Server by default.)
  const config = createStore();

  const main = createMessage({ content: ",help" });
  await handlePrefixMessage(main.message, config.store);
  assert.equal(main.sent.length, 1);
  assert.equal(main.sent[0].embeds?.[0].toJSON().color, undefined); // No color set.
  const mainEmbed = main.sent[0].embeds?.[0].toJSON();
  const mainFields = (mainEmbed?.fields ?? []) as {
    name: string;
    value: string;
  }[];
  assert.deepEqual(
    mainFields.map((field) => field.name),
    ["FG"],
  );
  const mainText = mainFields
    .map((field) => `${field.name}\n${field.value}`)
    .join("\n");
  assert.match(mainText, /don't have an FG role yet/i);
  assert.doesNotMatch(mainText, /commands/);
  assert.doesNotMatch(mainText, /\|/);
  assert.doesNotMatch(mainText, /Guard|Blacklist/);
  assert.doesNotMatch(mainText, /fg base|fg cleanup|fg list/i);

  const fg = createMessage({ content: ",help fg" });
  await handlePrefixMessage(fg.message, config.store);
  const fgEmbed = fg.sent[0].embeds?.[0].toJSON();
  assert.equal(fgEmbed?.title, "Help - FG");
  assert.match(
    (fgEmbed?.description as string | undefined) ?? "",
    /don't have an FG role yet/i,
  );
  const fgFields = (fgEmbed?.fields ?? []) as {
    name: string;
    value: string;
  }[];
  assert.equal(fgFields.length, 0);
  const fgText = fgFields
    .map((field) => `${field.name}\n${field.value}`)
    .join("\n");
  assert.doesNotMatch(fgText, /fg base|fg cleanup|fg list/i);

  // fg create is owner-or-whitelisted only, so this member gets the
  // short error, never the syntax.
  const create = createMessage({ content: ",help fg create" });
  await handlePrefixMessage(create.message, config.store);
  assert.equal(create.sent[0].embeds?.length, 1);
  assert.equal(sentTextOf(create.sent[0]), "You can't use that command.");

  // fg base is owner-or-staff-admin only now, so a Manage Server
  // member gets the short error too — they can no longer see it.
  const guarded = createMessage({ content: ",help fg base" });
  await handlePrefixMessage(guarded.message, config.store);
  assert.equal(guarded.sent[0].embeds?.length, 1);
  assert.equal(sentTextOf(guarded.sent[0]), "You can't use that command.");

  const unknown = createMessage({ content: ",help nonsense" });
  await handlePrefixMessage(unknown.message, config.store);
  assert.equal(unknown.sent[0].embeds?.length, 1);
  assert.match(sentTextOf(unknown.sent[0]), /No help for "nonsense"/);
  assert.match(sentTextOf(unknown.sent[0]), /Use \/help to see all commands/);
});

test(",help for a whitelisted user shows all categories, prefix syntax", async () => {
  const config = createStore(makeSettings({ allowedUserIds: [USER_ID] }));

  const main = createMessage({ content: ",help" });
  await handlePrefixMessage(main.message, config.store);
  const mainEmbed = main.sent[0].embeds?.[0].toJSON();
  const mainFields = (mainEmbed?.fields ?? []) as {
    name: string;
    value: string;
  }[];
  assert.deepEqual(
    mainFields.map((field) => field.name),
    ["Guard", "FG", "Blacklist"],
  );

  const fg = createMessage({ content: ",help fg" });
  await handlePrefixMessage(fg.message, config.store);
  const fgEmbed = fg.sent[0].embeds?.[0].toJSON();
  assert.equal(fgEmbed?.title, "Help - FG (1/2)");
  const fgFields = (fgEmbed?.fields ?? []) as {
    name: string;
    value: string;
  }[];
  const fgText = fgFields
    .map((field) => `${field.name}\n${field.value}`)
    .join("\n");
  // fg base and fg cleanup are owner-or-staff-admin only in help now:
  // Manage Server alone (which this member has) grants nothing there,
  // so a whitelisted member sees the other 9 FG commands, not these.
  assert.doesNotMatch(fgText, /,fg base @role/);
  assert.doesNotMatch(fgText, /,fg cleanup/);
  assert.match(fgText, /,fg list/);
  assert.match(fgText, /,fg create/);
  assert.doesNotMatch(fgText, /\/fg base/);
});

test("an error reply auto-deletes after 10 seconds", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  try {
    const config = createStore();
    const { message, sent } = createMessage({ content: ",guard" });

    await handlePrefixMessage(message, config.store);

    assert.equal(sent.length, 1);
    assert.equal(sent[0].deleted, false);
    t.mock.timers.tick(10_000);
    assert.equal(sent[0].deleted, true);
  } finally {
    t.mock.timers.reset();
  }
});

test("a public success reply auto-deletes after 90 seconds", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  try {
    const config = createStore(
      makeSettings({
        fgRoleOwners: { [FG_ROLE_ID]: "333333333333333333" },
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
    const { message, sent } = createMessage({
      content: ",fg drop",
      roles: [{ id: FG_ROLE_ID }],
      memberRoleIds: { [USER_ID]: [FG_ROLE_ID] },
    });

    await handlePrefixMessage(message, config.store);

    assert.equal(sent.length, 1);
    assert.match(sentTextOf(sent[0]), /Dropped/);
    assert.equal(sent[0].deleted, false);
    t.mock.timers.tick(89_999);
    assert.equal(sent[0].deleted, false);
    t.mock.timers.tick(1);
    assert.equal(sent[0].deleted, true);
  } finally {
    t.mock.timers.reset();
  }
});

test("a share offer does not auto-delete", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  try {
    const config = createStore(
      makeSettings({
        allowedUserIds: [USER_ID],
        fgRoleOwners: { [FG_ROLE_ID]: USER_ID },
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
    const share = createMessage({
      content: ",fg share <@333333333333333333>",
      roles: [{ id: FG_ROLE_ID }],
      memberRoleIds: { [USER_ID]: [FG_ROLE_ID] },
    });

    assert.equal(await handlePrefixMessage(share.message, config.store), true);
    assert.equal(share.sent.length, 1);
    assert.equal(share.sent[0].deleted, false);
    // Past the 90-second window and past the offer's 5-minute life.
    t.mock.timers.tick(300_000);
    assert.equal(share.sent[0].deleted, false);
  } finally {
    t.mock.timers.reset();
  }
});

test("a help pager does not auto-delete", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  try {
    const config = createStore(makeSettings({ allowedUserIds: [USER_ID] }));
    const help = createMessage({ content: ",help fg" });

    assert.equal(await handlePrefixMessage(help.message, config.store), true);
    assert.equal(help.sent.length, 1);
    assert.equal(help.sent[0].deleted, false);
    t.mock.timers.tick(300_000);
    assert.equal(help.sent[0].deleted, false);
  } finally {
    t.mock.timers.reset();
  }
});
