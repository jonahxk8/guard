import assert from "node:assert/strict";
import test from "node:test";
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

interface SentMessage {
  content?: string;
  embeds?: Array<{ toJSON: () => Record<string, unknown> }>;
  deleted: boolean;
}

function createMessage(options: {
  content: string;
  settings?: GuildSettings;
  canManageServer?: boolean;
  botAboveRole?: boolean;
  authorId?: string;
  authorIsBot?: boolean;
  guild?: Record<string, unknown> | null;
  roles?: Array<{ id: string; managed?: boolean; isAdmin?: boolean }>;
  memberRoleIds?: Record<string, string[]>;
}) {
  const sent: SentMessage[] = [];
  let commandDeleted = false;
  const rolesCache = new Map(
    (options.roles ?? [{ id: ROLE_ID }]).map((role) => {
      const entry = {
        id: role.id,
        name: "Role",
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
      members.set(memberId, {
        id: memberId,
        permissions: {
          has: (permission: bigint) =>
            permission === PermissionFlagsBits.ManageGuild &&
            (options.canManageServer ?? true),
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
      const sentMessage: SentMessage = {
        content: messageOptions.content as string | undefined,
        embeds: messageOptions.embeds as SentMessage["embeds"],
        deleted: false,
      };
      (sentMessage as unknown as Record<string, unknown>).delete = async () => {
        sentMessage.deleted = true;
      };
      (
        sentMessage as unknown as Record<string, unknown>
      ).createMessageComponentCollector = () => ({ on: () => {} });
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
            fetch: async (memberId: string) => getMember(memberId),
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
    author: { id: options.authorId ?? USER_ID, bot: options.authorIsBot ?? false },
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
    get commandDeleted() {
      return commandDeleted;
    },
  };
}

test("parsePrefixMessage parses mentions, raw ids, and fg colour args", () => {
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
  const fg = parsePrefixMessage(",fg color #ff0000 My Cool Role #00ff00");
  assert.equal(fg && "args" in fg && fg.args.strings.color, "#ff0000");
  assert.equal(fg && "args" in fg && fg.args.strings.name, "My Cool Role");
  assert.equal(fg && "args" in fg && fg.args.strings.second_color, "#00ff00");
  const singleWord = parsePrefixMessage(",fg color red blue");
  assert.equal(
    singleWord && "args" in singleWord && singleWord.args.strings.name,
    "blue",
  );
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
  assert.match(sent[0].content ?? "", /now protected/i);
  assert.equal(sent[0].deleted, false, "success replies stay");
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

test(",status sends the black embed and ,logchannel off turns alerts off", async () => {
  const config = createStore(
    makeSettings({ protectedRoleIds: [ROLE_ID], logChannelId: CHANNEL_ID }),
  );
  const status = createMessage({ content: ",status" });
  await handlePrefixMessage(status.message, config.store);
  assert.equal(status.sent.length, 1);
  assert.equal(status.sent[0].embeds?.[0].toJSON().color, 0);
  assert.match(
    (status.sent[0].embeds?.[0].toJSON().description as string) ?? "",
    /Protected roles \(1\)/,
  );

  const setup = createMessage({ content: ",logchannel off" });
  await handlePrefixMessage(setup.message, config.store);
  assert.equal(config.getSettings().logChannelId, null);
  assert.match(setup.sent[0].content ?? "", /Alerts are turned off/i);
});

test(",fg color creates an FG role through the shared handler", async () => {
  const config = createStore(makeSettings({ allowedUserIds: [USER_ID] }));
  const { message, sent } = createMessage({
    content: ",fg color #ff0000 My FG",
  });

  assert.equal(await handlePrefixMessage(message, config.store), true);

  const settings = config.getSettings();
  assert.deepEqual(settings.fgRoleOwners, { "100000000000000001": USER_ID });
  assert.ok(settings.protectedRoleIds.includes("100000000000000001"));
  assert.match(sent[0].content ?? "", /is your FG role now/i);
});

test(",fg rename and ,fg award view route to the shared FG handler", async () => {
  const config = createStore(
    makeSettings({ fgRoleOwners: { [FG_ROLE_ID]: USER_ID } }),
  );
  const rename = createMessage({
    content: ",fg rename New Name",
    roles: [{ id: FG_ROLE_ID }],
  });
  await handlePrefixMessage(rename.message, config.store);
  assert.match(rename.sent[0].content ?? "", /now called/i);

  const award = createMessage({ content: ",fg award view" });
  await handlePrefixMessage(award.message, config.store);
  assert.match(award.sent[0].content ?? "", /No FG award role is set/i);
});

test(",blacklist add/remove/list parse and route to the same handlers", async () => {
  const config = createStore(makeSettings({ protectedRoleIds: [ROLE_ID] }));

  const add = createMessage({
    content: ",blacklist add <@222222222222222222> <@&444444444444444444>",
  });
  await handlePrefixMessage(add.message, config.store);
  assert.deepEqual(config.getSettings().blacklist, { [USER_ID]: [ROLE_ID] });
  assert.match(add.sent[0].content ?? "", /now blacklisted from/i);

  const list = createMessage({ content: ",blacklist list" });
  await handlePrefixMessage(list.message, config.store);
  assert.match(list.sent[0].content ?? "", new RegExp(`<@${USER_ID}>`));

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
  assert.match(sent[0].content ?? "", /Protect that role first/i);
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
  assert.match(sent[0].content ?? "", /Usage: ,guard @role/);
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
