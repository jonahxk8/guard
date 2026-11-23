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
        user: { id: memberId, username: displayName },
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
    get commandDeleted() {
      return commandDeleted;
    },
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
  const fg = parsePrefixMessage(",fg color #ff0000 My Cool Role #00ff00");
  assert.equal(fg && "args" in fg && fg.args.strings.color, "#ff0000");
  assert.equal(fg && "args" in fg && fg.args.strings.name, "My Cool Role");
  assert.equal(fg && "args" in fg && fg.args.strings.second_color, "#00ff00");
  const singleWord = parsePrefixMessage(",fg color red blue");
  assert.ok(
    singleWord && "error" in singleWord,
    "two colors and no name is a usage error, not a role called 'blue'",
  );
  const twoFront = parsePrefixMessage(",fg color red blue My Role");
  assert.equal(twoFront && "args" in twoFront && twoFront.args.strings.color, "red blue");
  assert.equal(twoFront && "args" in twoFront && twoFront.args.strings.name, "My Role");
  assert.equal(twoFront && "args" in twoFront && twoFront.args.strings.second_color, undefined);
  const twoComma = parsePrefixMessage(",fg color #ff0000,#0000ff My Role");
  assert.equal(twoComma && "args" in twoComma && twoComma.args.strings.color, "#ff0000 #0000ff");
  assert.equal(twoComma && "args" in twoComma && twoComma.args.strings.name, "My Role");
  const multiWord = parsePrefixMessage(",fg color light blue My Role");
  assert.equal(multiWord && "args" in multiWord && multiWord.args.strings.color, "light blue");
  assert.equal(multiWord && "args" in multiWord && multiWord.args.strings.name, "My Role");
  const tooMany = parsePrefixMessage(",fg color red blue green");
  assert.equal(
    tooMany && "error" in tooMany && tooMany.error,
    "Too many colors — give one color, or two for a gradient.",
  );
  const random = parsePrefixMessage(",fg color random My Role");
  assert.equal(random && "args" in random && random.args.strings.color, "random");
  const holo = parsePrefixMessage(",fg color holo My Role");
  assert.equal(holo && "args" in holo && holo.args.strings.color, "holo");
  const createTooMany = parsePrefixMessage(",fg create My Role red blue green");
  assert.ok(createTooMany && "error" in createTooMany);
  const createMultiWord = parsePrefixMessage(",fg create My Role light blue");
  assert.equal(createMultiWord && "args" in createMultiWord && createMultiWord.args.strings.color, "light blue");
  assert.equal(createMultiWord && "args" in createMultiWord && createMultiWord.args.strings.name, "My Role");
  const create = parsePrefixMessage(",fg create My Cool Role #ff0000");
  assert.equal(create && "args" in create && create.args.subcommand, "create");
  assert.equal(create && "args" in create && create.args.strings.name, "My Cool Role");
  assert.equal(create && "args" in create && create.args.strings.color, "#ff0000");
  const createFor = parsePrefixMessage(",fg create Sam FG blue <@333333333333333333>");
  assert.equal(createFor && "args" in createFor && createFor.args.strings.name, "Sam FG");
  assert.equal(createFor && "args" in createFor && createFor.args.strings.color, "blue");
  assert.equal(createFor && "args" in createFor && createFor.args.users.member, "333333333333333333");
  const createGradient = parsePrefixMessage(",fg create My Role red blue");
  assert.equal(createGradient && "args" in createGradient && createGradient.args.strings.color, "red blue");
  assert.equal(createGradient && "args" in createGradient && createGradient.args.strings.second_color, undefined);
  assert.equal(createGradient && "args" in createGradient && createGradient.args.strings.name, "My Role");
  const assign = parsePrefixMessage(",fg assign <@333333333333333333> <@&666666666666666666>");
  assert.equal(assign && "args" in assign && assign.args.subcommand, "assign");
  assert.equal(assign && "args" in assign && assign.args.users.member, "333333333333333333");
  assert.equal(assign && "args" in assign && assign.args.roles.role, "666666666666666666");
  const authAdd = parsePrefixMessage(",fg auth add <@333333333333333333> <@&666666666666666666>");
  assert.equal(authAdd && "args" in authAdd && authAdd.args.subcommandGroup, "auth");
  assert.equal(authAdd && "args" in authAdd && authAdd.args.subcommand, "add");
  const authList = parsePrefixMessage(",fg auth list <@&666666666666666666>");
  assert.equal(authList && "args" in authList && authList.args.subcommand, "list");
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

test(",fg color creates an FG role through the shared handler", async () => {
  const config = createStore(makeSettings({ allowedUserIds: [USER_ID] }));
  const { message, sent } = createMessage({
    content: ",fg color #ff0000 My FG",
  });

  assert.equal(await handlePrefixMessage(message, config.store), true);

  const settings = config.getSettings();
  assert.deepEqual(settings.fgRoleOwners, { "100000000000000001": USER_ID });
  assert.ok(settings.protectedRoleIds.includes("100000000000000001"));
  assert.match(sentTextOf(sent[0]), /is your FG role now/i);
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

test(",fg rename and ,fg assign route to the shared FG handler", async () => {
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

  const assign = createMessage({
    content: ",fg assign <@333333333333333333> <@&666666666666666666>",
    roles: [{ id: FG_ROLE_ID }],
  });
  await handlePrefixMessage(assign.message, config.store);
  assert.deepEqual(config.getSettings().fgRoleSharers, {
    [FG_ROLE_ID]: [OTHER_ID],
  });
  assert.match(sentTextOf(assign.sent[0]), /can share it/i);
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
    content: ",fg auth add <@333333333333333333> <@&666666666666666666>",
    roles: [{ id: FG_ROLE_ID }],
  });
  await handlePrefixMessage(add.message, config.store);
  assert.deepEqual(config.getSettings().fgRoleSharers, {
    [FG_ROLE_ID]: [OTHER_ID],
  });
  assert.match(sentTextOf(add.sent[0]), /can now share/i);

  const list = createMessage({
    content: ",fg auth list <@&666666666666666666>",
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
    content: ",fg create Sam FG blue <@333333333333333333>",
    roles: [{ id: ROLE_ID }],
  });

  assert.equal(await handlePrefixMessage(message, config.store), true);

  const settings = config.getSettings();
  assert.deepEqual(settings.fgRoleOwners, { "100000000000000001": OTHER_ID });
  assert.match(sentTextOf(sent[0]), /Created FG role Sam FG for Sam/i);
  assert.doesNotMatch(sentTextOf(sent[0]), /\[object Object\]/);
});

test(",fg create by a non-whitelisted member is rejected", async () => {
  const config = createStore(makeSettings({ fgBaseRoleId: ROLE_ID }));
  const { message, sent } = createMessage({
    content: ",fg create Nope blue",
    roles: [{ id: ROLE_ID }],
  });

  await handlePrefixMessage(message, config.store);

  assert.deepEqual(config.getSettings().fgRoleOwners, {});
  assert.match(
    sentTextOf(sent[0]),
    /Only the server owner, administrators, or whitelisted members can create FG roles/i,
  );
});

test(",help for a Manage Server member shows FG only, with prefix syntax", async () => {
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
  // Manage Server alone sees base, list, and cleanup — nothing else.
  assert.match(mainText, /3 commands/);
  assert.doesNotMatch(mainText, /\|/);
  assert.doesNotMatch(mainText, /Guard|Blacklist/);

  const fg = createMessage({ content: ",help fg" });
  await handlePrefixMessage(fg.message, config.store);
  const fgEmbed = fg.sent[0].embeds?.[0].toJSON();
  assert.equal(fgEmbed?.title, "Help - FG");
  const fgFields = (fgEmbed?.fields ?? []) as {
    name: string;
    value: string;
  }[];
  const fgText = fgFields
    .map((field) => `${field.name}\n${field.value}`)
    .join("\n");
  assert.deepEqual(
    fgFields.map((field) => field.name),
    ["`,fg base @role`", "`,fg list`", "`,fg cleanup`"],
  );
  assert.doesNotMatch(fgText, /\/fg create/);
  assert.doesNotMatch(fgText, /\/blacklist/);

  // fg create is owner-or-whitelisted only, so this member gets the
  // short error, never the syntax.
  const create = createMessage({ content: ",help fg create" });
  await handlePrefixMessage(create.message, config.store);
  assert.equal(create.sent[0].embeds?.length, 1);
  assert.equal(sentTextOf(create.sent[0]), "You can't use that command.");

  // fg base is Manage Server, so this member CAN see it.
  const guarded = createMessage({ content: ",help fg base" });
  await handlePrefixMessage(guarded.message, config.store);
  assert.equal(guarded.sent[0].embeds?.[0].toJSON().title, "fg base");

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
  assert.match(fgText, /,fg base @role/);
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
