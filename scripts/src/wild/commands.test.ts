import assert from "node:assert/strict";
import test from "node:test";
import {
  ChatInputCommandInteraction,
  EmbedBuilder,
  PermissionFlagsBits,
} from "discord.js";
import { ConfigStore, GuildSettings } from "./config-store.js";
import { handleWildCommand } from "./commands.js";

const GUILD_ID = "111111111111111111";

interface Reply {
  content?: string;
  embeds?: EmbedBuilder[];
  ephemeral?: boolean;
}

function createStore(
  initialSettings: GuildSettings = {
    protectedRoleIds: [],
    allowedUserIds: [],
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
  group: string | null;
  action: string;
  canManageServer?: boolean;
}) {
  const replies: Reply[] = [];
  const botMember = {
    permissions: {
      has: (permission: bigint) =>
        permission === PermissionFlagsBits.ManageRoles ||
        permission === PermissionFlagsBits.ViewAuditLog,
    },
  };
  const interaction = {
    commandName: "wild",
    guildId: GUILD_ID,
    guild: { id: GUILD_ID, members: { me: botMember } },
    memberPermissions: {
      has: (permission: bigint) =>
        permission === PermissionFlagsBits.ManageGuild &&
        (options.canManageServer ?? true),
    },
    options: {
      getSubcommandGroup: () => options.group,
      getSubcommand: () => options.action,
    },
    reply: async (reply: Reply) => {
      replies.push(reply);
    },
  } as unknown as ChatInputCommandInteraction;

  return { interaction, replies };
}

test("Manage Server members can pause and resume enforcement", async () => {
  const config = createStore();
  const pause = createInteraction({ group: "enforcement", action: "pause" });

  await handleWildCommand(pause.interaction, config.store);

  assert.equal(config.getSettings().enforcementEnabled, false);
  assert.equal(config.getSaveCount(), 1);
  assert.match(
    pause.replies[0].embeds?.[0].toJSON().description ?? "",
    /enforcement is paused/i,
  );

  const resume = createInteraction({ group: "enforcement", action: "resume" });
  await handleWildCommand(resume.interaction, config.store);

  assert.equal(config.getSettings().enforcementEnabled, true);
  assert.equal(config.getSaveCount(), 2);
  assert.match(
    resume.replies[0].embeds?.[0].toJSON().description ?? "",
    /enforcement is active again/i,
  );
});

test("members without Manage Server cannot change enforcement", async () => {
  const config = createStore();
  const interaction = createInteraction({
    group: "enforcement",
    action: "pause",
    canManageServer: false,
  });

  await handleWildCommand(interaction.interaction, config.store);

  assert.equal(config.getSettings().enforcementEnabled, true);
  assert.equal(config.getSaveCount(), 0);
  assert.match(interaction.replies[0].content ?? "", /Manage Server/i);
});

test("/wild status shows when enforcement is paused", async () => {
  const config = createStore({
    protectedRoleIds: [],
    allowedUserIds: [],
    logChannelId: null,
    enforcementEnabled: false,
  });
  const interaction = createInteraction({ group: null, action: "status" });

  await handleWildCommand(interaction.interaction, config.store);

  assert.match(
    interaction.replies[0].embeds?.[0].toJSON().description ?? "",
    /\*\*Enforcement\*\*  Paused/,
  );
});
