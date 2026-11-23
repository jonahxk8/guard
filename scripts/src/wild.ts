import {
  AuditLogEvent,
  Client,
  Events,
  GatewayIntentBits,
  GuildAuditLogsEntry,
  Guild,
  PermissionFlagsBits,
} from "discord.js";
import {
  handleGuardCommand,
  blacklistCommand,
  protectCommand,
  setupCommand,
  statusCommand,
  whitelistCommand,
} from "./wild/commands.js";
import { wildMessageEmbed } from "./wild/embeds.js";
import { fgCommand, handleFgCommand } from "./wild/fg-booster.js";
import { handleHelpCommand, helpCommand } from "./wild/help.js";
import { handlePrefixMessage } from "./wild/prefix.js";
import { ConfigStore } from "./wild/config-store.js";
import { describeDiscordError } from "./wild/reply.js";
import { getUnmanageableRoleIds, guardAuditLogEntry, sweepMissedGrants } from "./wild/role-guard.js";

function log(message: string): void {
  process.stdout.write(`[Bot] ${message}\n`);
}

async function main(): Promise<void> {
  const token = process.env.DISCORD_BOT_TOKEN;
  if (!token) {
    throw new Error("DISCORD_BOT_TOKEN is not set. Add it in Railway Variables.");
  }

  const store = new ConfigStore();
  await store.load();

  const client = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildModeration,
      // Needed for the "," prefix commands (reading message content).
      // Enable Message Content Intent in the Developer Portal too
      // (Bot > Privileged Gateway Intents), or prefix commands won't fire.
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.MessageContent,
    ],
  });

  client.once(Events.ClientReady, async (readyClient) => {
    try {
      // Full bulk overwrite of the global slash commands: this both
      // registers the current commands AND removes stale ones Discord
      // still lists from older versions (/logs, /wild, /roles, /watch,
      // /enforcement, /commands, /fg staff, /fg access). Discord can
      // still take up to an hour to show the new list, and nothing
      // updates until the bot is redeployed with this code.
      await readyClient.application.commands.set([
        protectCommand.toJSON(),
        whitelistCommand.toJSON(),
        statusCommand.toJSON(),
        setupCommand.toJSON(),
        fgCommand.toJSON(),
        blacklistCommand.toJSON(),
        helpCommand.toJSON(),
      ]);
    } catch (error) {
      log(`Could not register slash commands: ${describeDiscordError(error)}`);
      return;
    }

    const requiredPermissions =
      PermissionFlagsBits.ManageRoles |
      PermissionFlagsBits.ManageMessages |
      PermissionFlagsBits.ViewAuditLog |
      PermissionFlagsBits.ViewChannel |
      PermissionFlagsBits.SendMessages |
      PermissionFlagsBits.EmbedLinks;
    const installUrl = new URL("https://discord.com/oauth2/authorize");
    installUrl.searchParams.set("client_id", readyClient.application.id);
    installUrl.searchParams.set("scope", "bot applications.commands");
    installUrl.searchParams.set("permissions", requiredPermissions.toString());

    log(`Connected as ${readyClient.user.tag}.`);
    log(`Invite the bot to a server: ${installUrl.toString()}`);
    log("Global /protect, /whitelist, /status, /setup, /fg, /blacklist, and /help commands are registered.");
    log("Prefix commands also work: ,guard ,whitelist ,status ,logchannel ,fg ,blacklist ,help");

    // Grants made while the bot was down (e.g. during a Railway
    // redeploy) never fire GuildAuditLogEntryCreate — sweep the last
    // 10 minutes of role grants so they are still caught. Best-effort;
    // a failure here never blocks startup.
    for (const guild of readyClient.guilds.cache.values()) {
      await sweepMissedGrants(guild, store).catch(() => undefined);
    }

    // Best-effort hierarchy check: warn per server about protected/FG roles
    // the bot cannot manage. Never let this crash startup.
    for (const guild of readyClient.guilds.cache.values()) {
      try {
        const settings = store.get(guild.id);
        const roleIds = [
          ...settings.protectedRoleIds,
          ...Object.keys(settings.fgRoles),
        ];
        if (roleIds.length === 0) continue;
        const botMember =
          guild.members.me ??
          (await guild.members.fetchMe().catch(() => null));
        const unmanageable = getUnmanageableRoleIds(guild, botMember, roleIds);
        if (unmanageable.length > 0) {
          log(
            `Warning in server ${guild.id} (${guild.name}): bot cannot manage ` +
              `${unmanageable.map((id) => `<@&${id}>`).join(", ")} — ` +
              `move the bot's role above these roles.`,
          );
        }
      } catch (error) {
        log(
          `Could not check role hierarchy in server ${guild.id}: ${describeDiscordError(error)}`,
        );
      }
    }
  });

  client.on(Events.InteractionCreate, async (interaction) => {
    if (interaction.isButton()) {
      // Help and FG-share buttons are handled by the per-message
      // collectors attached when those messages were sent — never
      // answer them here, or the button would be handled twice.
      // Anything else is a button this bot no longer owns (e.g. from
      // an old message): answer it instead of leaving it to fail.
      if (
        interaction.customId.startsWith("wild-help:") ||
        interaction.customId.startsWith("fg-share:")
      ) {
        return;
      }
      await interaction
        .reply({
          embeds: [wildMessageEmbed("That button isn't available anymore.")],
          ephemeral: true,
        })
        .catch(() => undefined);
      return;
    }
    if (!interaction.isChatInputCommand()) return;
    // Slash registration is a full bulk overwrite (see ClientReady
    // above), so a command Discord still lists but this code no longer
    // knows — e.g. /logs from an older version — must never be left
    // unanswered. Answer it instead of timing out.
    const knownCommands = new Set([
      "protect",
      "whitelist",
      "status",
      "setup",
      "fg",
      "blacklist",
      "help",
    ]);
    if (!knownCommands.has(interaction.commandName)) {
      await interaction
        .reply({
          embeds: [
            wildMessageEmbed(
              "That command isn't available anymore. Use /help to see the current commands.",
            ),
          ],
          ephemeral: true,
        })
        .catch(() => undefined);
      return;
    }
    try {
      if (interaction.commandName === "fg") {
        await handleFgCommand(interaction, store);
      } else if (interaction.commandName === "help") {
        await handleHelpCommand(interaction, store);
      } else {
        await handleGuardCommand(interaction, store);
      }
    } catch (error) {
      log(`Command failed: ${describeDiscordError(error)}`);
      const response = {
        embeds: [
          wildMessageEmbed(
            "The bot couldn't complete that command. Check its permissions and try again.",
          ),
        ],
        ephemeral: true,
      };
      if (interaction.replied || interaction.deferred) {
        await interaction.followUp(response).catch(() => undefined);
      } else {
        await interaction.reply(response).catch(() => undefined);
      }
    }
  });

  client.on(Events.MessageCreate, async (message) => {
    // Prefix commands: only non-bot messages in guilds. Unknown ","
    // commands are ignored silently (they may belong to Bleed).
    if (message.author.bot || !message.guild) return;
    if (!message.content.startsWith(",")) return;
    try {
      await handlePrefixMessage(message, store);
    } catch (error) {
      log(`Prefix command failed: ${describeDiscordError(error)}`);
      await message.channel
        .send({
          embeds: [
            wildMessageEmbed(
              "The bot couldn't complete that command. Check its permissions and try again.",
            ),
          ],
          allowedMentions: { parse: [] },
        })
        .then((sent) => {
          const timer = setTimeout(() => {
            sent.delete().catch(() => undefined);
          }, 10_000);
          timer.unref?.();
        })
        .catch(() => undefined);
    }
  });

  client.on(
    Events.GuildAuditLogEntryCreate,
    (entry: GuildAuditLogsEntry, guild: Guild) => {
      if (entry.action !== AuditLogEvent.MemberRoleUpdate) return;
      void guardAuditLogEntry(entry, guild, store).catch((error: unknown) => {
        log(`Guard failed in server ${guild.id}: ${describeDiscordError(error)}`);
      });
    },
  );

  client.on(Events.Error, (error) => {
    log(`Discord connection error: ${describeDiscordError(error)}`);
  });

  await client.login(token);
}

main().catch((error: unknown) => {
  log(`Startup failed: ${describeDiscordError(error)}`);
  process.exitCode = 1;
});
