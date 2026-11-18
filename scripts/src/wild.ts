import {
  AuditLogEvent,
  Client,
  Events,
  GatewayIntentBits,
  GuildAuditLogsEntry,
  Guild,
  PermissionFlagsBits,
} from "discord.js";
import { wildCommand, handleWildCommand } from "./wild/commands.js";
import { ConfigStore } from "./wild/config-store.js";
import { guardAuditLogEntry } from "./wild/role-guard.js";

function log(message: string): void {
  process.stdout.write(`[Wild] ${message}\n`);
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
    intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildModeration],
  });

  client.once(Events.ClientReady, async (readyClient) => {
    try {
      await readyClient.application.commands.set([wildCommand.toJSON()]);
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
    log(`Invite Wild to a server: ${installUrl.toString()}`);
    log("Global /wild commands are registered; Discord may take a short time to show them.");
  });

  client.on(Events.InteractionCreate, async (interaction) => {
    if (!interaction.isChatInputCommand()) return;
    try {
      await handleWildCommand(interaction, store);
    } catch (error) {
      log(`Command failed: ${describeError(error)}`);
      const response = {
        content: "Wild couldn't complete that command. Check its permissions and try again.",
        ephemeral: true,
      };
      if (interaction.replied || interaction.deferred) {
        await interaction.followUp(response).catch(() => undefined);
      } else {
        await interaction.reply(response).catch(() => undefined);
      }
    }
  });

  client.on(
    Events.GuildAuditLogEntryCreate,
    (entry: GuildAuditLogsEntry, guild: Guild) => {
      if (entry.action !== AuditLogEvent.MemberRoleUpdate) return;
      void guardAuditLogEntry(entry, guild, store).catch((error: unknown) => {
        log(`Role guard failed in server ${guild.id}: ${describeError(error)}`);
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
