import assert from "node:assert/strict";
import test from "node:test";
import {
  ChannelType,
  ChatInputCommandInteraction,
  EmbedBuilder,
  PermissionFlagsBits,
  PermissionsBitField,
} from "discord.js";
import { ConfigStore, GuildSettings } from "./config-store.js";
import {
  buildBlacklistListPage,
  handleBlacklistListButton,
  handleGuardCommand,
  parseBlacklistButton,
} from "./commands.js";

const GUILD_ID = "111111111111111111";
const ROLE_ID = "333333333333333333";
const USER_ID = "222222222222222222";
const CHANNEL_ID = "444444444444444444";

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

  return {
    store,
    getSettings: () => settings,
    getSaveCount: () => saveCount,
  };
}

/** Text of a small reply: now always an embed description, never plain content. */
function replyTextOf(reply: Reply): string {
  const embed = reply.embeds?.[0]?.toJSON() as { description?: string } | undefined;
  return embed?.description ?? reply.content ?? "";
}

function createInteraction(options: {
  commandName: string;
  canManageServer?: boolean;
  botAboveRole?: boolean;
  isDangerousRole?: boolean;
  userId?: string;
  roleId?: string;
  channelId?: string;
  subcommand?: string;
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
  const botMember = {
    permissions: {
      has: (permission: bigint) =>
        permission === PermissionFlagsBits.ManageRoles ||
        permission === PermissionFlagsBits.ViewAuditLog,
    },
    roles: {
      highest: {
        comparePositionTo: () => (options.botAboveRole === false ? -1 : 1),
      },
    },
  };
  const role = options.roleId
    ? {
        id: options.roleId,
        name: "Pic",
        managed: false,
        permissions: {
          has: (permission: bigint) =>
            permission === PermissionFlagsBits.Administrator &&
            (options.isDangerousRole ?? false),
        },
      }
    : null;
  const channel = options.channelId
    ? {
        id: options.channelId,
        name: "logs-demo",
        type: ChannelType.GuildText,
        permissionsFor: () => ({ has: () => true }),
      }
    : null;
  const interaction = {
    commandName: options.commandName,
    guildId: GUILD_ID,
    user: { id: options.userId ?? "999999999999999999", username: "Alex" },
    guild: {
      id: GUILD_ID,
      ownerId: "999999999999999999",
      members: {
        me: botMember,
        fetch: async (arg: string | { user?: string }) => ({
          id: typeof arg === "string" ? arg : (arg.user ?? ""),
          displayName: "Alex",
          roles: { cache: { has: () => false, some: () => false } },
        }),
        fetchMe: async () => botMember,
      },
      roles: {
        cache: new Map(
          role ? [[role.id, role]] : [],
        ),
      },
      channels: {
        cache: new Map(
          channel ? [[channel.id, channel]] : [],
        ),
      },
    },
    memberPermissions:
      options.memberPermissionsOverride ?? {
        has: (permission: bigint) =>
          permission === PermissionFlagsBits.ManageGuild &&
          (options.canManageServer ?? true),
      },
    options: {
      getUser: (_name: string) =>
        options.userId ? { id: options.userId } : null,
      getRole: (_name: string, _required?: boolean) => role,
      getChannel: (_name: string) => channel,
      getSubcommand: () => options.subcommand ?? "add",
    },
    reply: async (reply: Reply) => {
      replies.push(reply);
    },
    deferReply: async (deferOptions: { ephemeral?: boolean }) => {
      defers.push(deferOptions);
    },
    deleteReply: async () => {
      deletes.push(1);
    },
  } as unknown as ChatInputCommandInteraction;

  return { interaction, replies, defers, deletes };
}

test("/protect adds a role with an ephemeral plain-text reply", async () => {
  const config = createStore();
  const interaction = createInteraction({ commandName: "protect", roleId: ROLE_ID });

  await handleGuardCommand(interaction.interaction, config.store);

  assert.deepEqual(config.getSettings().protectedRoleIds, [ROLE_ID]);
  assert.equal(config.getSaveCount(), 1);
  assert.equal(interaction.replies[0].ephemeral, true);
  assert.equal(interaction.replies[0].embeds?.length, 1);
  assert.match(replyTextOf(interaction.replies[0]), /Pic is now protected/i);
  assert.doesNotMatch(replyTextOf(interaction.replies[0]), /\[object Object\]/);
});

test("/protect removes a role that is already protected", async () => {
  const config = createStore(makeSettings({ protectedRoleIds: [ROLE_ID] }));
  const interaction = createInteraction({ commandName: "protect", roleId: ROLE_ID });

  await handleGuardCommand(interaction.interaction, config.store);

  assert.deepEqual(config.getSettings().protectedRoleIds, []);
  assert.match(replyTextOf(interaction.replies[0]), /no longer protected/i);
});

test("/protect refuses to unprotect an FG role", async () => {
  const config = createStore(
    makeSettings({
      protectedRoleIds: [ROLE_ID],
      fgRoles: {
        [ROLE_ID]: {
          assignUserIds: [],
          assignRoleIds: [],
          shareUserIds: [],
          shareRoleIds: [],
        },
      },
      fgRoleOwners: { [ROLE_ID]: USER_ID },
    }),
  );
  const interaction = createInteraction({ commandName: "protect", roleId: ROLE_ID });

  await handleGuardCommand(interaction.interaction, config.store);

  assert.equal(config.getSaveCount(), 0);
  assert.deepEqual(config.getSettings().protectedRoleIds, [ROLE_ID]);
  // A functional error still replies — only authorisation failures
  // are silently ignored.
  assert.deepEqual(interaction.defers, []);
  assert.match(replyTextOf(interaction.replies[0]), /always protected/i);
});

test("/protect refuses an FG role that drifted out of the protected list", async () => {
  const config = createStore(
    makeSettings({
      protectedRoleIds: [],
      fgRoles: {
        [ROLE_ID]: {
          assignUserIds: [],
          assignRoleIds: [],
          shareUserIds: [],
          shareRoleIds: [],
        },
      },
      fgRoleOwners: { [ROLE_ID]: USER_ID },
    }),
  );
  const interaction = createInteraction({ commandName: "protect", roleId: ROLE_ID });

  await handleGuardCommand(interaction.interaction, config.store);

  assert.equal(config.getSaveCount(), 0);
  assert.deepEqual(config.getSettings().protectedRoleIds, []);
  assert.match(replyTextOf(interaction.replies[0]), /always protected/i);
});

test("/protect rejects an Administrator role", async () => {
  const config = createStore();
  const interaction = createInteraction({
    commandName: "protect",
    roleId: ROLE_ID,
    isDangerousRole: true,
  });

  await handleGuardCommand(interaction.interaction, config.store);

  assert.deepEqual(config.getSettings().protectedRoleIds, []);
  assert.equal(config.getSaveCount(), 0);
  assert.match(replyTextOf(interaction.replies[0]), /Administrator/i);
});

test("/protect without Manage Server is silently ignored", async () => {
  // An authorisation failure sends NO reply at all — not even an
  // ephemeral error. Slash interactions are deferred ephemerally and
  // the deferred reply deleted, so the user briefly sees "thinking"
  // and then nothing.
  const config = createStore();
  const interaction = createInteraction({
    commandName: "protect",
    roleId: ROLE_ID,
    userId: USER_ID,
    canManageServer: false,
  });

  await handleGuardCommand(interaction.interaction, config.store);

  assert.equal(config.getSaveCount(), 0);
  assert.deepEqual(interaction.replies, []);
  assert.deepEqual(interaction.defers, [{ ephemeral: true }]);
  assert.equal(interaction.deletes.length, 1);
});

test("/protect by a Discord Administrator is silently ignored (real expanded payload)", async () => {
  // The key regression test for the payload-expansion leak: Discord
  // sends the member's *effective* permissions in the interaction
  // payload, and ADMINISTRATOR expands to ALL permissions there — so
  // a literal-bit mock would not catch a has(ManageGuild) leak. A
  // real PermissionsBitField.All models the production payload.
  const config = createStore();
  const interaction = createInteraction({
    commandName: "protect",
    roleId: ROLE_ID,
    userId: USER_ID,
    memberPermissionsOverride: new PermissionsBitField(
      PermissionsBitField.All,
    ),
  });

  await handleGuardCommand(interaction.interaction, config.store);

  assert.equal(config.getSaveCount(), 0);
  assert.deepEqual(interaction.replies, []);
  assert.deepEqual(interaction.defers, [{ ephemeral: true }]);
  assert.equal(interaction.deletes.length, 1);
});

test("/protect by a whitelisted user without Manage Server works", async () => {
  // Help shows guard commands to whitelisted members ("privileged"),
  // so the handler admits them too — they do not also need Manage
  // Server.
  const config = createStore(makeSettings({ allowedUserIds: [USER_ID] }));
  const interaction = createInteraction({
    commandName: "protect",
    roleId: ROLE_ID,
    userId: USER_ID,
    canManageServer: false,
  });

  await handleGuardCommand(interaction.interaction, config.store);

  assert.deepEqual(config.getSettings().protectedRoleIds, [ROLE_ID]);
  assert.equal(config.getSaveCount(), 1);
  assert.deepEqual(interaction.defers, []);
  assert.match(replyTextOf(interaction.replies[0]), /Pic is now protected/i);
});

test("/whitelist toggles a user on and then off", async () => {
  const config = createStore();
  const add = createInteraction({
    commandName: "whitelist",
    userId: USER_ID,
  });

  await handleGuardCommand(add.interaction, config.store);

  assert.deepEqual(config.getSettings().allowedUserIds, [USER_ID]);
  assert.match(replyTextOf(add.replies[0]), /Alex is now whitelisted/i);
  assert.doesNotMatch(replyTextOf(add.replies[0]), /\[object Object\]/);
  assert.equal(add.replies[0].ephemeral, true);

  const remove = createInteraction({
    commandName: "whitelist",
    userId: USER_ID,
  });
  await handleGuardCommand(remove.interaction, config.store);

  assert.deepEqual(config.getSettings().allowedUserIds, []);
  assert.match(replyTextOf(remove.replies[0]), /Alex is no longer whitelisted/i);
  assert.doesNotMatch(replyTextOf(remove.replies[0]), /\[object Object\]/);
});

test("/whitelist toggles a role", async () => {
  const config = createStore();
  const interaction = createInteraction({
    commandName: "whitelist",
    roleId: ROLE_ID,
  });

  await handleGuardCommand(interaction.interaction, config.store);

  assert.deepEqual(config.getSettings().allowedRoleIds, [ROLE_ID]);
  assert.match(replyTextOf(interaction.replies[0]), /Pic is now whitelisted/i);
  assert.doesNotMatch(replyTextOf(interaction.replies[0]), /\[object Object\]/);
});

test("/whitelist with no target asks for one person or role", async () => {
  const config = createStore();
  const interaction = createInteraction({ commandName: "whitelist" });

  await handleGuardCommand(interaction.interaction, config.store);

  assert.equal(config.getSaveCount(), 0);
  assert.match(replyTextOf(interaction.replies[0]), /Pick one person or one role/i);
});

test("/setup sets the alert channel", async () => {
  const config = createStore();
  const interaction = createInteraction({
    commandName: "setup",
    channelId: CHANNEL_ID,
  });

  await handleGuardCommand(interaction.interaction, config.store);

  assert.equal(config.getSettings().logChannelId, CHANNEL_ID);
  assert.match(replyTextOf(interaction.replies[0]), /Alerts will go to #logs-demo/i);
  assert.doesNotMatch(replyTextOf(interaction.replies[0]), /\[object Object\]/);
});

test("/setup with no channel turns alerts off", async () => {
  const config = createStore(makeSettings({ logChannelId: CHANNEL_ID }));
  const interaction = createInteraction({ commandName: "setup" });

  await handleGuardCommand(interaction.interaction, config.store);

  assert.equal(config.getSettings().logChannelId, null);
  assert.match(replyTextOf(interaction.replies[0]), /Alerts are turned off/i);
});

test("/status shows protected, FG, whitelisted — and no command list", async () => {
  const config = createStore(
    makeSettings({
      protectedRoleIds: [ROLE_ID],
      allowedUserIds: [USER_ID],
      fgRoles: {
        "555555555555555555": {
          assignUserIds: [],
          assignRoleIds: [],
          shareUserIds: [],
          shareRoleIds: [],
        },
      },
    }),
  );
  const interaction = createInteraction({
    commandName: "status",
    roleId: ROLE_ID,
  });

  await handleGuardCommand(interaction.interaction, config.store);

  const embed = interaction.replies[0].embeds?.[0].toJSON();
  assert.equal(embed?.color, undefined); // No color set: the embed blends in.
  assert.equal(embed?.footer, undefined);
  assert.equal(embed?.timestamp, undefined);
  const fields = Object.fromEntries(
    (embed?.fields ?? []).map((field) => [field.name, field.value]),
  );
  assert.equal(fields["Protected roles (1)"], `<@&${ROLE_ID}>`);
  assert.equal(fields["FG roles"], "1");
  assert.equal(fields["Whitelisted"], "1 members, 0 roles");
  assert.equal(fields["Blacklisted"], "0");
  assert.equal(fields["Bot"], "Ready");
  assert.equal(embed?.description, undefined);
  // Plain text only: no emoji anywhere in the status embed.
  assert.doesNotMatch(
    JSON.stringify(embed),
    /[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{2B00}-\u{2BFF}\u{25A0}-\u{25FF}\u{2190}-\u{21FF}\u{2300}-\u{23FF}\u{FE0F}\u{200D}]/u,
  );
  assert.doesNotMatch(JSON.stringify(embed?.fields ?? []), /Commands:/);
  assert.doesNotMatch(JSON.stringify(embed?.fields ?? []), /\/wild |\/roles|\/watch/);
});

test("/status lists a protected role the bot cannot manage", async () => {
  const config = createStore(makeSettings({ protectedRoleIds: [ROLE_ID] }));
  const interaction = createInteraction({
    commandName: "status",
    botAboveRole: false,
    roleId: ROLE_ID,
  });

  await handleGuardCommand(interaction.interaction, config.store);

  const embed = interaction.replies[0].embeds?.[0].toJSON();
  const fields = Object.fromEntries(
    (embed?.fields ?? []).map((field) => [field.name, field.value]),
  );
  assert.equal(fields["Bot"], "Needs setup");
  assert.match(fields["Bot can't manage"] ?? "", /<@&333333333333333333>/);
});

test("/blacklist add requires the role to be protected first", async () => {
  const config = createStore();
  const interaction = createInteraction({
    commandName: "blacklist",
    subcommand: "add",
    userId: USER_ID,
    roleId: ROLE_ID,
  });

  await handleGuardCommand(interaction.interaction, config.store);

  assert.deepEqual(config.getSettings().blacklist, {});
  assert.equal(config.getSaveCount(), 0);
  assert.match(replyTextOf(interaction.replies[0]), /Protect that role first/i);
});

test("/blacklist add works for an FG role without /protect", async () => {
  // FG roles are always protected — /protect refuses them — so the
  // blacklist must accept them directly, or nobody could ever be
  // blocked from an FG role.
  const config = createStore(
    makeSettings({
      fgRoles: {
        [ROLE_ID]: {
          assignUserIds: [],
          assignRoleIds: [],
          shareUserIds: [],
          shareRoleIds: [],
        },
      },
    }),
  );
  const interaction = createInteraction({
    commandName: "blacklist",
    subcommand: "add",
    userId: USER_ID,
    roleId: ROLE_ID,
  });

  await handleGuardCommand(interaction.interaction, config.store);

  assert.deepEqual(config.getSettings().blacklist, { [USER_ID]: [ROLE_ID] });
  assert.match(replyTextOf(interaction.replies[0]), /is now blacklisted from/);
});

test("/blacklist add, duplicate add, remove, and list round-trip", async () => {
  const config = createStore(makeSettings({ protectedRoleIds: [ROLE_ID] }));

  const add = createInteraction({
    commandName: "blacklist",
    subcommand: "add",
    userId: USER_ID,
    roleId: ROLE_ID,
  });
  await handleGuardCommand(add.interaction, config.store);
  assert.deepEqual(config.getSettings().blacklist, { [USER_ID]: [ROLE_ID] });
  assert.match(replyTextOf(add.replies[0]), /Alex is now blacklisted from <@&333333333333333333>/);
  assert.doesNotMatch(replyTextOf(add.replies[0]), /\[object Object\]/);

  const duplicate = createInteraction({
    commandName: "blacklist",
    subcommand: "add",
    userId: USER_ID,
    roleId: ROLE_ID,
  });
  await handleGuardCommand(duplicate.interaction, config.store);
  assert.deepEqual(config.getSettings().blacklist, { [USER_ID]: [ROLE_ID] });
  assert.match(replyTextOf(duplicate.replies[0]), /Alex is already blacklisted/i);
  assert.doesNotMatch(replyTextOf(duplicate.replies[0]), /\[object Object\]/);

  const list = createInteraction({
    commandName: "blacklist",
    subcommand: "list",
    roleId: ROLE_ID,
  });
  await handleGuardCommand(list.interaction, config.store);
  const listEmbed = list.replies[0].embeds?.[0].toJSON();
  assert.equal(listEmbed?.title, "Blacklist");
  assert.equal(listEmbed?.fields?.length, 1);
  assert.equal(listEmbed?.fields?.[0].name, "1. Alex");
  assert.equal(listEmbed?.fields?.[0].value, "Blacklisted from Pic");

  const remove = createInteraction({
    commandName: "blacklist",
    subcommand: "remove",
    userId: USER_ID,
    roleId: ROLE_ID,
  });
  await handleGuardCommand(remove.interaction, config.store);
  assert.deepEqual(config.getSettings().blacklist, {});
  assert.match(replyTextOf(remove.replies[0]), /Alex is no longer blacklisted/i);
  assert.doesNotMatch(replyTextOf(remove.replies[0]), /\[object Object\]/);

  const removeAgain = createInteraction({
    commandName: "blacklist",
    subcommand: "remove",
    userId: USER_ID,
    roleId: ROLE_ID,
  });
  await handleGuardCommand(removeAgain.interaction, config.store);
  assert.match(replyTextOf(removeAgain.replies[0]), /isn't blacklisted/i);
});

test("/blacklist list works for a whitelisted member without Manage Server", async () => {
  const config = createStore(
    makeSettings({
      allowedUserIds: [USER_ID],
      protectedRoleIds: [ROLE_ID],
      blacklist: { [USER_ID]: [ROLE_ID] },
    }),
  );
  const interaction = createInteraction({
    commandName: "blacklist",
    subcommand: "list",
    userId: USER_ID,
    roleId: ROLE_ID,
    canManageServer: false,
  });

  await handleGuardCommand(interaction.interaction, config.store);

  const embed = interaction.replies[0].embeds?.[0].toJSON();
  assert.equal(embed?.title, "Blacklist");
  assert.equal(embed?.fields?.length, 1);
  assert.equal(embed?.fields?.[0].name, "1. Alex");
  assert.equal(embed?.fields?.[0].value, "Blacklisted from Pic");
});

test("/blacklist list by a non-whitelisted member without Manage Server is silently ignored", async () => {
  const config = createStore();
  const interaction = createInteraction({
    commandName: "blacklist",
    subcommand: "list",
    userId: USER_ID,
    canManageServer: false,
  });

  await handleGuardCommand(interaction.interaction, config.store);

  assert.deepEqual(interaction.replies, []);
  assert.deepEqual(interaction.defers, [{ ephemeral: true }]);
  assert.equal(interaction.deletes.length, 1);
});

test("/blacklist add without Manage Server is silently ignored", async () => {
  const config = createStore(makeSettings({ protectedRoleIds: [ROLE_ID] }));
  const interaction = createInteraction({
    commandName: "blacklist",
    subcommand: "add",
    userId: USER_ID,
    roleId: ROLE_ID,
    canManageServer: false,
  });

  await handleGuardCommand(interaction.interaction, config.store);

  assert.equal(config.getSaveCount(), 0);
  assert.deepEqual(interaction.replies, []);
  assert.deepEqual(interaction.defers, [{ ephemeral: true }]);
  assert.equal(interaction.deletes.length, 1);
});

test("/status shows the blacklist count", async () => {
  const config = createStore(
    makeSettings({ blacklist: { [USER_ID]: [ROLE_ID] } }),
  );
  const interaction = createInteraction({ commandName: "status" });

  await handleGuardCommand(interaction.interaction, config.store);

  const embed = interaction.replies[0].embeds?.[0].toJSON();
  const fields = Object.fromEntries(
    (embed?.fields ?? []).map((field) => [field.name, field.value]),
  );
  assert.equal(fields["Blacklisted"], "1");
  assert.doesNotMatch(JSON.stringify(embed?.fields ?? []), /Commands:/);
});

test("/status shows Blacklisted: 1 after a blacklist add (count is live)", async () => {
  const config = createStore(makeSettings({ protectedRoleIds: [ROLE_ID] }));
  const add = createInteraction({
    commandName: "blacklist",
    subcommand: "add",
    userId: USER_ID,
    roleId: ROLE_ID,
  });
  await handleGuardCommand(add.interaction, config.store);
  assert.deepEqual(config.getSettings().blacklist, { [USER_ID]: [ROLE_ID] });

  const status = createInteraction({ commandName: "status", roleId: ROLE_ID });
  await handleGuardCommand(status.interaction, config.store);
  const embed = status.replies[0].embeds?.[0].toJSON();
  const fields = Object.fromEntries(
    (embed?.fields ?? []).map((field) => [field.name, field.value]),
  );
  assert.equal(fields["Blacklisted"], "1");
});

/** /blacklist list is a paginated embed, 10 users per page. */

function blacklistSettings(count: number): GuildSettings {
  const blacklist: Record<string, string[]> = {};
  for (let i = 0; i < count; i += 1) {
    blacklist[`2000000000000000${String(i).padStart(2, "0")}`] = [ROLE_ID];
  }
  return makeSettings({ protectedRoleIds: [ROLE_ID], blacklist });
}

async function listBlacklist(count: number) {
  const config = createStore(blacklistSettings(count));
  const { interaction, replies } = createInteraction({
    commandName: "blacklist",
    subcommand: "list",
    roleId: ROLE_ID,
  });
  await handleGuardCommand(interaction, config.store);
  return { replies };
}

test("/blacklist list with an empty blacklist is one short embed, no buttons", async () => {
  const { replies } = await listBlacklist(0);
  assert.equal(replies.length, 1);
  assert.equal(replies[0].ephemeral, true);
  const embed = replies[0].embeds?.[0].toJSON();
  assert.equal(embed?.title, "Blacklist");
  assert.match(embed?.description ?? "", /blacklist is empty/i);
  assert.equal(embed?.color, undefined);
});

test("/blacklist list with 1 entry is one page with one field", async () => {
  const { replies } = await listBlacklist(1);
  const embed = replies[0].embeds?.[0].toJSON();
  assert.equal(embed?.title, "Blacklist");
  assert.equal(embed?.fields?.length, 1);
  assert.equal(embed?.fields?.[0].name, "1. Alex");
  assert.equal(embed?.fields?.[0].value, "Blacklisted from Pic");
});

test("/blacklist list paginates at 10 per page: 10, 11, and 25 entries", async () => {
  const ten = await listBlacklist(10);
  const tenEmbed = ten.replies[0].embeds?.[0].toJSON();
  assert.equal(tenEmbed?.title, "Blacklist");
  assert.equal(tenEmbed?.fields?.length, 10);
  assert.equal(tenEmbed?.fields?.[0].name, "1. Alex");
  assert.equal(tenEmbed?.fields?.[9].name, "10. Alex");

  const eleven = await listBlacklist(11);
  const elevenEmbed = eleven.replies[0].embeds?.[0].toJSON();
  assert.equal(elevenEmbed?.title, "Blacklist (1/2)");
  assert.equal(elevenEmbed?.fields?.length, 10);

  const page2 = buildBlacklistListPage(
    Array.from({ length: 11 }, (_, i) => ({
      userId: `user-${i}`,
      roleId: ROLE_ID,
      userName: `User ${i}`,
      roleName: "Pic",
    })),
    2,
  );
  assert.equal(page2.page, 2);
  assert.equal(page2.totalPages, 2);
  assert.equal(page2.fields.length, 1);

  const twentyFive = await listBlacklist(25);
  const twentyFiveEmbed = twentyFive.replies[0].embeds?.[0].toJSON();
  assert.equal(twentyFiveEmbed?.title, "Blacklist (1/3)");
  assert.equal(twentyFiveEmbed?.fields?.length, 10);
  const lastPage = buildBlacklistListPage(
    Array.from({ length: 25 }, (_, i) => ({
      userId: `user-${i}`,
      roleId: ROLE_ID,
      userName: `User ${i}`,
      roleName: "Pic",
    })),
    3,
  );
  assert.equal(lastPage.fields.length, 5);
  // Page numbers clamp.
  assert.equal(
    buildBlacklistListPage(
      Array.from({ length: 25 }, (_, i) => ({
        userId: `user-${i}`,
        roleId: ROLE_ID,
        userName: `User ${i}`,
        roleName: "Pic",
      })),
      99,
    ).page,
    3,
  );
});

test("blacklist list buttons round-trip and reject a different user", async () => {
  const rows = Array.from({ length: 11 }, (_, i) => ({
    userId: `user-${i}`,
    roleId: ROLE_ID,
    userName: `User ${i}`,
    roleName: "Pic",
  }));
  const ownerId = "999999999999999999";
  assert.deepEqual(parseBlacklistButton(`wild-blacklist:${ownerId}:2`), {
    ownerId,
    page: 2,
  });
  assert.equal(parseBlacklistButton("wild-help:1:2"), null);
  assert.equal(parseBlacklistButton("wild-blacklist:bad"), null);

  const calls: { kind: string; data?: unknown }[] = [];
  const makeButton = (userId: string) =>
    ({
      customId: `wild-blacklist:${ownerId}:2`,
      user: { id: userId },
      update: async (data: unknown) => {
        calls.push({ kind: "update", data });
      },
      reply: async (data: unknown) => {
        calls.push({ kind: "reply", data });
      },
    }) as unknown as Parameters<typeof handleBlacklistListButton>[0];

  const ownerPage = await handleBlacklistListButton(
    makeButton(ownerId),
    rows,
    ownerId,
  );
  assert.equal(ownerPage, 2);
  const update = calls[0]?.data as { embeds?: EmbedBuilder[] };
  assert.equal(update.embeds?.[0].toJSON().title, "Blacklist (2/2)");

  const strangerPage = await handleBlacklistListButton(
    makeButton("222222222222222222"),
    rows,
    ownerId,
  );
  assert.equal(strangerPage, null);
  assert.equal(calls[1]?.kind, "reply");
  const reply = calls[1]?.data as { embeds?: EmbedBuilder[] };
  assert.match(
    (reply.embeds?.[0].toJSON().description ?? "") as string,
    /isn't yours/,
  );
});
