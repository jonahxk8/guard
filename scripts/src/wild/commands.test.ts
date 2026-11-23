import assert from "node:assert/strict";
import test from "node:test";
import {
  ChatInputCommandInteraction,
  EmbedBuilder,
  PermissionFlagsBits,
} from "discord.js";
import { ConfigStore, GuildSettings } from "./config-store.js";
import {
  commandsHelpCommand,
  handleCommandsHelp,
  handleGuardCommand,
  handleWildCommand,
} from "./commands.js";

const GUILD_ID = "111111111111111111";
const WHITELIST_USER_ID = "222222222222222222";
const WHITELIST_ROLE_ID = "333333333333333333";

interface Reply {
  content?: string;
  embeds?: EmbedBuilder[];
  ephemeral?: boolean;
}

function createStore(
  initialSettings: GuildSettings = {
    protectedRoleIds: [],
    allowedUserIds: [],
    allowedRoleIds: [],
    fgStaffUserIds: [],
    fgStaffRoleIds: [],
    fgRoles: {},
    logChannelId: null,
    enforcementEnabled: true,
  },
) {
  let settings = initialSettings;
  let saveCount = 0;
  const store = {
    get: () => ({
      ...settings,
      protectedRoleIds: [...settings.protectedRoleIds],
      allowedUserIds: [...settings.allowedUserIds],
      allowedRoleIds: [...settings.allowedRoleIds],
    }),
    set: async (guildId: string, nextSettings: GuildSettings) => {
      assert.equal(guildId, GUILD_ID);
      settings = nextSettings;
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
  commandName?: string;
  action: string;
  canManageServer?: boolean;
  botAboveRole?: boolean;
  roleIds?: string[];
  userId?: string;
  roleId?: string;
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
  const interaction = {
    commandName: options.commandName ?? "wild",
    guildId: GUILD_ID,
    guild: {
      id: GUILD_ID,
      members: {
        me: botMember,
        fetch: async (memberId: string) => ({ id: memberId }),
        fetchMe: async () => botMember,
      },
      roles: {
        cache: new Map(
          (options.roleIds ?? []).map((id) => [id, { id }]),
        ),
      },
    },
    memberPermissions: {
      has: (permission: bigint) =>
        permission === PermissionFlagsBits.ManageGuild &&
        (options.canManageServer ?? true),
    },
    options: {
      getSubcommandGroup: () => null,
      getSubcommand: () => options.action,
      getUser: (_name: string) =>
        options.userId ? { id: options.userId } : null,
      getRole: (_name: string, _required?: boolean) =>
        options.roleId ? { id: options.roleId } : null,
      getChannel: (_name: string) => null,
    },
    reply: async (reply: Reply) => {
      replies.push(reply);
    },
  } as unknown as ChatInputCommandInteraction;

  return { interaction, replies };
}

test("Manage Server members can pause and resume enforcement", async () => {
  const config = createStore();
  const pause = createInteraction({ commandName: "enforcement", action: "pause" });

  await handleGuardCommand(pause.interaction, config.store);

  assert.equal(config.getSettings().enforcementEnabled, false);
  assert.equal(config.getSaveCount(), 1);
  assert.match(
    pause.replies[0].embeds?.[0].toJSON().description ?? "",
    /role removal is paused/i,
  );

  const resume = createInteraction({ commandName: "enforcement", action: "resume" });
  await handleGuardCommand(resume.interaction, config.store);

  assert.equal(config.getSettings().enforcementEnabled, true);
  assert.equal(config.getSaveCount(), 2);
  assert.match(
    resume.replies[0].embeds?.[0].toJSON().description ?? "",
    /role removal is active again/i,
  );
});

test("members without Manage Server cannot change enforcement", async () => {
  const config = createStore();
  const interaction = createInteraction({
    commandName: "enforcement",
    action: "pause",
    canManageServer: false,
  });

  await handleGuardCommand(interaction.interaction, config.store);

  assert.equal(config.getSettings().enforcementEnabled, true);
  assert.equal(config.getSaveCount(), 0);
  assert.match(interaction.replies[0].content ?? "", /Manage Server/i);
});

test("/status shows when enforcement is paused", async () => {
  const config = createStore({
    protectedRoleIds: [],
    allowedUserIds: [],
    allowedRoleIds: [],
    fgStaffUserIds: [],
    fgStaffRoleIds: [],
    fgRoles: {},
    logChannelId: null,
    enforcementEnabled: false,
  });
  const interaction = createInteraction({ commandName: "status", action: "" });

  await handleGuardCommand(interaction.interaction, config.store);

  assert.match(
    interaction.replies[0].embeds?.[0].toJSON().description ?? "",
    /\*\*Enforcement\*\*  Paused/,
  );
});

test("/commands lists command names in a black embed", async () => {
  const replies: Reply[] = [];
  await handleCommandsHelp({
    reply: async (reply: Reply) => replies.push(reply),
  } as unknown as ChatInputCommandInteraction);

  const embed = replies[0].embeds?.[0].toJSON();
  assert.equal(commandsHelpCommand.toJSON().name, "commands");
  assert.match(embed?.description ?? "", /\/whitelist add\|remove\|list/);
  assert.match(embed?.description ?? "", /\/roles/);
  assert.match(embed?.description ?? "", /\/fg roles create\|assign\|list/);
  assert.match(embed?.description ?? "", /`,fg share @member`/);
  assert.doesNotMatch(embed?.description ?? "", /\/wild /);
  assert.doesNotMatch(embed?.description ?? "", /Wild JS|role guard/i);
  assert.equal(embed?.color, 0);
  assert.equal(embed?.footer, undefined);
  assert.equal(embed?.timestamp, undefined);
});

test("/roles without Manage Server is rejected", async () => {
  const config = createStore();
  const interaction = createInteraction({
    commandName: "roles",
    action: "",
    canManageServer: false,
  });

  await handleGuardCommand(interaction.interaction, config.store);

  assert.equal(config.getSaveCount(), 0);
  assert.match(interaction.replies[0].content ?? "", /Manage Server/i);
});

test("/status lists a protected role the bot cannot manage", async () => {
  const config = createStore({
    protectedRoleIds: ["333333333333333333"],
    allowedUserIds: [],
    allowedRoleIds: [],
    fgStaffUserIds: [],
    fgStaffRoleIds: [],
    fgRoles: {},
    logChannelId: null,
    enforcementEnabled: true,
  });
  const interaction = createInteraction({
    commandName: "status",
    action: "",
    botAboveRole: false,
    roleIds: ["333333333333333333"],
  });

  await handleGuardCommand(interaction.interaction, config.store);

  const description = interaction.replies[0].embeds?.[0].toJSON().description ?? "";
  assert.match(description, /\*\*Guard\*\*  Needs setup/);
  assert.match(description, /Bot can't manage: <@&333333333333333333>/);
});

test("/whitelist add works for a Manage Server member", async () => {
  const config = createStore();
  const interaction = createInteraction({
    commandName: "whitelist",
    action: "add",
    userId: WHITELIST_USER_ID,
  });

  await handleGuardCommand(interaction.interaction, config.store);

  assert.equal(config.getSaveCount(), 1);
  assert.deepEqual(config.getSettings().allowedUserIds, [WHITELIST_USER_ID]);
  assert.match(
    interaction.replies[0].embeds?.[0].toJSON().description ?? "",
    /can now assign protected roles/i,
  );
});

test("/whitelist list shows 'Whitelisted assigners'", async () => {
  const config = createStore({
    protectedRoleIds: [],
    allowedUserIds: [WHITELIST_USER_ID],
    allowedRoleIds: [WHITELIST_ROLE_ID],
    fgStaffUserIds: [],
    fgStaffRoleIds: [],
    fgRoles: {},
    logChannelId: null,
    enforcementEnabled: true,
  });
  const interaction = createInteraction({
    commandName: "whitelist",
    action: "list",
    roleIds: [WHITELIST_ROLE_ID],
  });

  await handleGuardCommand(interaction.interaction, config.store);

  const embed = interaction.replies[0].embeds?.[0].toJSON();
  assert.equal(embed?.title, "Whitelisted assigners");
  assert.match(embed?.fields?.[0].value ?? "", new RegExp(`<@${WHITELIST_USER_ID}>`));
  assert.match(embed?.fields?.[1].value ?? "", new RegExp(`<@&${WHITELIST_ROLE_ID}>`));
});

test("/status shows 'Whitelisted members'", async () => {
  const config = createStore({
    protectedRoleIds: [],
    allowedUserIds: [WHITELIST_USER_ID],
    allowedRoleIds: [WHITELIST_ROLE_ID],
    fgStaffUserIds: [],
    fgStaffRoleIds: [],
    fgRoles: {},
    logChannelId: null,
    enforcementEnabled: true,
  });
  const interaction = createInteraction({ commandName: "status", action: "" });

  await handleGuardCommand(interaction.interaction, config.store);

  const description = interaction.replies[0].embeds?.[0].toJSON().description ?? "";
  assert.match(description, /\*\*Whitelisted members\*\*  1/);
  assert.match(description, /\*\*Whitelisted roles\*\*  1/);
  assert.doesNotMatch(description, /Allowed members|Allowed roles/);
});

test("handleWildCommand is still exported as an alias of handleGuardCommand", () => {
  assert.equal(handleWildCommand, handleGuardCommand);
});
