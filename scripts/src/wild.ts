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
  commandsHelpCommand,
  handleCommandsHelp,
  handleWildCommand,
} from "./wild/commands.js";
import { fgCommand, handleFgCommand } from "./wild/fg-commands.js";
import { wildCommand } from "./wild/commands.js";
import { ConfigStore } from "./wild/config-store.js";
import { handleFgShareMessage } from "./wild/fg-share.js";
import { guardAuditLogEntry } from "./wild/role-guard.js";

function log(message: string): void {
  process.stdout.write(`[Bot] ${message}\n`);
}

function describeError(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}

async function main(): Promise<void> {
  const token = process.env.DISCORD_BOT_TOKEN;
  if (!token) {
    throw new Error("DISCORD_BOT_TOKEN is not set. Add it in Replit Secrets.");
  }

  const store = new ConfigStore();
  await store.load();

  const client = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildModeration,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.MessageContent,
    ],
  });

  client.once(Events.ClientReady, async (readyClient) => {
    try {
      await readyClient.application.commands.set([
        wildCommand.toJSON(),
        commandsHelpCommand.toJSON(),
        fgCommand.toJSON(),
      ]);
    } catch (error) {
      log(`Could not register slash commands: ${describeError(error)}`);
      return;
    }

    const requiredPermissions =
      PermissionFlagsBits.ManageRoles |
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
    log("Global /wild, /commands, and /fg commands are registered.");
  });

  client.on(Events.InteractionCreate, async (interaction) => {
    if (!interaction.isChatInputCommand()) return;
    try {
      if (interaction.commandName === "fg") {
        await handleFgCommand(interaction, store);
      } else if (interaction.commandName === "commands") {
        await handleCommandsHelp(interaction);
      } else {
        await handleWildCommand(interaction, store);
      }
    } catch (error) {
      log(`Command failed: ${describeError(error)}`);
      const response = {
        content: "The bot couldn't complete that command. Check its permissions and try again.",
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
    try {
      await handleFgShareMessage(message, store);
    } catch (error) {
      log(`FG share failed: ${describeError(error)}`);
      await message
        .reply("The bot couldn't complete that FG role share. Check its permissions and try again.")
        .catch(() => undefined);
    }
  });

  client.on(
    Events.GuildAuditLogEntryCreate,
    (entry: GuildAuditLogsEntry, guild: Guild) => {
      if (entry.action !== AuditLogEvent.MemberRoleUpdate) return;
      void guardAuditLogEntry(entry, guild, store).catch((error: unknown) => {
        log(`Guard failed in server ${guild.id}: ${describeError(error)}`);
      });
    },
  );

  client.on(Events.Error, (error) => {
    log(`Discord connection error: ${describeError(error)}`);
  });

  await client.login(token);
}

main().catch((error: unknown) => {
  log(`Startup failed: ${describeError(error)}`);
  process.exitCode = 1;
});
