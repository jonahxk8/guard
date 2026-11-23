import assert from "node:assert/strict";
import test from "node:test";
import {
  ChannelType,
  ChatInputCommandInteraction,
  EmbedBuilder,
  PermissionFlagsBits,
} from "discord.js";
import { ConfigStore, GuildSettings } from "./config-store.js";
import { handleGuardCommand } from "./commands.js";

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

  return {
    store,
    getSettings: () => settings,
    getSaveCount: () => saveCount,
  };
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
}) {
  const replies: Reply[] = [];
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
        type: ChannelType.GuildText,
        permissionsFor: () => ({ has: () => true }),
      }
    : null;
  const interaction = {
    commandName: options.commandName,
    guildId: GUILD_ID,
    user: { id: options.userId ?? "999999999999999999" },
    guild: {
      id: GUILD_ID,
      ownerId: "999999999999999999",
      members: {
        me: botMember,
        fetch: async (memberId: string) => ({
          id: memberId,
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
    memberPermissions: {
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
  } as unknown as ChatInputCommandInteraction;

  return { interaction, replies };
}

test("/protect adds a role with an ephemeral plain-text reply", async () => {
  const config = createStore();
  const interaction = createInteraction({ commandName: "protect", roleId: ROLE_ID });

  await handleGuardCommand(interaction.interaction, config.store);

  assert.deepEqual(config.getSettings().protectedRoleIds, [ROLE_ID]);
  assert.equal(config.getSaveCount(), 1);
  assert.equal(interaction.replies[0].ephemeral, true);
  assert.equal(interaction.replies[0].embeds, undefined);
  assert.match(interaction.replies[0].content ?? "", /now protected/i);
});

test("/protect removes a role that is already protected", async () => {
  const config = createStore(makeSettings({ protectedRoleIds: [ROLE_ID] }));
  const interaction = createInteraction({ commandName: "protect", roleId: ROLE_ID });

  await handleGuardCommand(interaction.interaction, config.store);

  assert.deepEqual(config.getSettings().protectedRoleIds, []);
  assert.match(interaction.replies[0].content ?? "", /no longer protected/i);
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
  assert.match(interaction.replies[0].content ?? "", /Administrator/i);
});

test("/protect without Manage Server is rejected", async () => {
  const config = createStore();
  const interaction = createInteraction({
    commandName: "protect",
    roleId: ROLE_ID,
    canManageServer: false,
  });

  await handleGuardCommand(interaction.interaction, config.store);

  assert.equal(config.getSaveCount(), 0);
  assert.match(interaction.replies[0].content ?? "", /Manage Server/i);
});

test("/whitelist toggles a user on and then off", async () => {
  const config = createStore();
  const add = createInteraction({
    commandName: "whitelist",
    userId: USER_ID,
  });

  await handleGuardCommand(add.interaction, config.store);

  assert.deepEqual(config.getSettings().allowedUserIds, [USER_ID]);
  assert.match(add.replies[0].content ?? "", /now whitelisted/i);
  assert.equal(add.replies[0].ephemeral, true);

  const remove = createInteraction({
    commandName: "whitelist",
    userId: USER_ID,
  });
  await handleGuardCommand(remove.interaction, config.store);

  assert.deepEqual(config.getSettings().allowedUserIds, []);
  assert.match(remove.replies[0].content ?? "", /no longer whitelisted/i);
});

test("/whitelist toggles a role", async () => {
  const config = createStore();
  const interaction = createInteraction({
    commandName: "whitelist",
    roleId: ROLE_ID,
  });

  await handleGuardCommand(interaction.interaction, config.store);

  assert.deepEqual(config.getSettings().allowedRoleIds, [ROLE_ID]);
  assert.match(interaction.replies[0].content ?? "", /now whitelisted/i);
});

test("/whitelist with no target asks for one person or role", async () => {
  const config = createStore();
  const interaction = createInteraction({ commandName: "whitelist" });

  await handleGuardCommand(interaction.interaction, config.store);

  assert.equal(config.getSaveCount(), 0);
  assert.match(interaction.replies[0].content ?? "", /Pick one person or one role/i);
});

test("/setup sets the alert channel", async () => {
  const config = createStore();
  const interaction = createInteraction({
    commandName: "setup",
    channelId: CHANNEL_ID,
  });

  await handleGuardCommand(interaction.interaction, config.store);

  assert.equal(config.getSettings().logChannelId, CHANNEL_ID);
  assert.match(interaction.replies[0].content ?? "", /Alerts will go to/i);
});

test("/setup with no channel turns alerts off", async () => {
  const config = createStore(makeSettings({ logChannelId: CHANNEL_ID }));
  const interaction = createInteraction({ commandName: "setup" });

  await handleGuardCommand(interaction.interaction, config.store);

  assert.equal(config.getSettings().logChannelId, null);
  assert.match(interaction.replies[0].content ?? "", /Alerts are turned off/i);
});

test("/status shows protected, FG, whitelisted, and the command list", async () => {
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
  assert.equal(embed?.color, 0);
  assert.equal(embed?.footer, undefined);
  assert.equal(embed?.timestamp, undefined);
  assert.match(embed?.description ?? "", /Protected roles \(1\)/);
  assert.match(embed?.description ?? "", /FG roles: 1/);
  assert.match(embed?.description ?? "", /Whitelisted: 1 members, 0 roles/);
  assert.match(embed?.description ?? "", /\/protect \/whitelist \/status \/setup \/fg/);
  assert.doesNotMatch(embed?.description ?? "", /\/wild |\/roles|\/watch/);
});

test("/status lists a protected role the bot cannot manage", async () => {
  const config = createStore(makeSettings({ protectedRoleIds: [ROLE_ID] }));
  const interaction = createInteraction({
    commandName: "status",
    botAboveRole: false,
    roleId: ROLE_ID,
  });

  await handleGuardCommand(interaction.interaction, config.store);

  const description = interaction.replies[0].embeds?.[0].toJSON().description ?? "";
  assert.match(description, /Bot: Needs setup/);
  assert.match(description, /Bot can't manage: <@&333333333333333333>/);
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
  assert.match(interaction.replies[0].content ?? "", /Protect that role first/i);
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
  assert.match(add.replies[0].content ?? "", /now blacklisted from/i);

  const duplicate = createInteraction({
    commandName: "blacklist",
    subcommand: "add",
    userId: USER_ID,
    roleId: ROLE_ID,
  });
  await handleGuardCommand(duplicate.interaction, config.store);
  assert.deepEqual(config.getSettings().blacklist, { [USER_ID]: [ROLE_ID] });
  assert.match(duplicate.replies[0].content ?? "", /already blacklisted/i);

  const list = createInteraction({
    commandName: "blacklist",
    subcommand: "list",
  });
  await handleGuardCommand(list.interaction, config.store);
  assert.match(list.replies[0].content ?? "", new RegExp(`<@${USER_ID}>`));
  assert.match(list.replies[0].content ?? "", new RegExp(`<@&${ROLE_ID}>`));

  const remove = createInteraction({
    commandName: "blacklist",
    subcommand: "remove",
    userId: USER_ID,
    roleId: ROLE_ID,
  });
  await handleGuardCommand(remove.interaction, config.store);
  assert.deepEqual(config.getSettings().blacklist, {});
  assert.match(remove.replies[0].content ?? "", /no longer blacklisted/i);

  const removeAgain = createInteraction({
    commandName: "blacklist",
    subcommand: "remove",
    userId: USER_ID,
    roleId: ROLE_ID,
  });
  await handleGuardCommand(removeAgain.interaction, config.store);
  assert.match(removeAgain.replies[0].content ?? "", /isn't blacklisted/i);
});

test("/blacklist list works for a whitelisted member without Manage Server", async () => {
  const config = createStore(
    makeSettings({
      allowedUserIds: [USER_ID],
      blacklist: { [USER_ID]: [ROLE_ID] },
    }),
  );
  const interaction = createInteraction({
    commandName: "blacklist",
    subcommand: "list",
    userId: USER_ID,
    canManageServer: false,
  });

  await handleGuardCommand(interaction.interaction, config.store);

  assert.match(interaction.replies[0].content ?? "", new RegExp(`<@${USER_ID}>`));
});

test("/blacklist list rejects a non-whitelisted member without Manage Server", async () => {
  const config = createStore();
  const interaction = createInteraction({
    commandName: "blacklist",
    subcommand: "list",
    userId: USER_ID,
    canManageServer: false,
  });

  await handleGuardCommand(interaction.interaction, config.store);

  assert.match(interaction.replies[0].content ?? "", /Only Manage Server members or whitelisted/i);
});

test("/blacklist add without Manage Server is rejected", async () => {
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
  assert.match(interaction.replies[0].content ?? "", /Manage Server/i);
});

test("/status shows the blacklist count", async () => {
  const config = createStore(
    makeSettings({ blacklist: { [USER_ID]: [ROLE_ID] } }),
  );
  const interaction = createInteraction({ commandName: "status" });

  await handleGuardCommand(interaction.interaction, config.store);

  const description = interaction.replies[0].embeds?.[0].toJSON().description ?? "";
  assert.match(description, /Blacklisted: 1/);
  assert.match(description, /\/blacklist/);
});
