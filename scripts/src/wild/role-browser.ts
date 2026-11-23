import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ComponentType,
  EmbedBuilder,
  Guild,
  Role,
  ChatInputCommandInteraction,
} from "discord.js";
import { BOT_BLACK } from "./embeds.js";

const PAGE_SIZE = 10;
const COMPONENT_PREFIX = "wild-roles";

type SortOrder = "position" | "name";

function sortRoles(roles: Role[], order: SortOrder): Role[] {
  return [...roles].sort((first, second) => {
    if (order === "name") {
      return first.name.localeCompare(second.name, undefined, {
        sensitivity: "base",
      });
    }
    return second.position - first.position || first.name.localeCompare(second.name);
  });
}

function createRoleEmbed(
  guild: Guild,
  roles: Role[],
  page: number,
  order: SortOrder,
): EmbedBuilder {
  const pageCount = Math.max(1, Math.ceil(roles.length / PAGE_SIZE));
  const start = page * PAGE_SIZE;
  const pageRoles = roles.slice(start, start + PAGE_SIZE);
  const lines = pageRoles.map(
    (role, index) => `\`${String(start + index + 1).padStart(2, "0")}\` <@&${role.id}>`,
  );

  return new EmbedBuilder()
    .setColor(BOT_BLACK)
    .setTitle("Roles")
    .setDescription(
      [
        lines.length > 0 ? lines.join("\n") : "No roles to show.",
        `Page ${page + 1}/${pageCount} · ${roles.length} roles · ${order === "position" ? "Role order" : "A–Z"}`,
      ].join("\n\n"),
    );
}

function createButtons(
  page: number,
  pageCount: number,
  order: SortOrder,
  disabled = false,
): ActionRowBuilder<ButtonBuilder> {
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(`${COMPONENT_PREFIX}:previous`)
      .setLabel("‹")
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(disabled || page <= 0),
    new ButtonBuilder()
      .setCustomId(`${COMPONENT_PREFIX}:next`)
      .setLabel("›")
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(disabled || page >= pageCount - 1),
    new ButtonBuilder()
      .setCustomId(`${COMPONENT_PREFIX}:sort`)
      .setLabel(order === "position" ? "Sort A–Z" : "Role order")
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(disabled),
    new ButtonBuilder()
      .setCustomId(`${COMPONENT_PREFIX}:close`)
      .setLabel("Close")
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(disabled),
  );
}

export async function showRoleBrowser(
  interaction: ChatInputCommandInteraction,
): Promise<void> {
  const guild = interaction.guild;
  if (!guild) {
    await interaction.reply({
      content: "Run `/roles` inside a server.",
      ephemeral: true,
    });
    return;
  }

  const roles = guild.roles.cache.filter((role) => role.id !== guild.id).map((role) => role);
  let order: SortOrder = "position";
  let page = 0;
  let closed = false;
  const orderedRoles = () => sortRoles(roles, order);
  const pageCount = () => Math.max(1, Math.ceil(roles.length / PAGE_SIZE));

  await interaction.reply({
    embeds: [createRoleEmbed(guild, orderedRoles(), page, order)],
    components: [createButtons(page, pageCount(), order)],
    allowedMentions: { parse: [] },
  });

  const message = await interaction.fetchReply();
  const collector = message.createMessageComponentCollector({
    componentType: ComponentType.Button,
    time: 120_000,
  });

  collector.on("collect", async (button) => {
    if (button.user.id !== interaction.user.id) {
      await button.reply({
        content: "Run `/roles` to open your own role browser.",
        ephemeral: true,
      });
      return;
    }

    if (button.customId === `${COMPONENT_PREFIX}:close`) {
      closed = true;
      await button.update({
        content: "Role browser closed.",
        embeds: [],
        components: [],
      });
      collector.stop("closed");
      return;
    }

    if (button.customId === `${COMPONENT_PREFIX}:sort`) {
      order = order === "position" ? "name" : "position";
      page = 0;
    } else if (button.customId === `${COMPONENT_PREFIX}:previous`) {
      page = Math.max(0, page - 1);
    } else if (button.customId === `${COMPONENT_PREFIX}:next`) {
      page = Math.min(pageCount() - 1, page + 1);
    }

    await button.update({
      embeds: [createRoleEmbed(guild, orderedRoles(), page, order)],
      components: [createButtons(page, pageCount(), order)],
      allowedMentions: { parse: [] },
    });
  });

  collector.on("end", async () => {
    if (closed) return;
    await interaction
      .editReply({
        components: [createButtons(page, pageCount(), order, true)],
      })
      .catch(() => undefined);
  });
}
