import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonInteraction,
  ButtonStyle,
  ComponentType,
  EmbedBuilder,
  Guild,
  GuildMember,
  Message,
  MessageCreateOptions,
  Role,
  StringSelectMenuBuilder,
  TextChannel,
} from "discord.js";
import { canShareFgRole } from "./authorization.js";
import { ConfigStore, FgRoleAccess } from "./config-store.js";
import { BOT_BLACK } from "./embeds.js";

const SHARE_TIMEOUT_MS = 5 * 60 * 1_000;
const SHARE_SELECT_PREFIX = "fg-share-select";

function buildShareEmbed(
  title: string,
  requesterId: string,
  targetId: string,
  role: Role | null,
  status?: string,
): EmbedBuilder {
  const roleMention = role ? `${role}` : "FG role";
  return new EmbedBuilder()
    .setColor(BOT_BLACK)
    .setTitle(title)
    .setDescription(
      status ??
        `<@${requesterId}> wants to share ${roleMention} with <@${targetId}>.\n\nDo you want to accept this FG role?`,
    );
}

function buildDecisionButtons(disabled = false): ActionRowBuilder<ButtonBuilder> {
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId("fg-share:yes")
      .setLabel("Yes")
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(disabled),
    new ButtonBuilder()
      .setCustomId("fg-share:no")
      .setLabel("No")
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(disabled),
  );
}

async function mayShareRole(
  guild: Guild,
  requesterId: string,
  roleId: string,
  access: FgRoleAccess,
): Promise<boolean> {
  const requester = await guild.members.fetch(requesterId).catch(() => null);
  return Boolean(requester && canShareFgRole(requester, roleId, access));
}

async function finishOffer(
  button: ButtonInteraction,
  guild: Guild,
  requesterId: string,
  targetId: string,
  roleId: string,
  store: ConfigStore,
): Promise<boolean> {
  if (button.user.id !== targetId) {
    await button.reply({
      content: "This FG role offer is for the mentioned member.",
      ephemeral: true,
    });
    return false;
  }

  const role = guild.roles.cache.get(roleId);
  const settings = store.get(guild.id);
  const access = settings.fgRoles[roleId];
  if (!role || !access) {
    await button.update({
      embeds: [
        buildShareEmbed(
          "FG role offer ended",
          requesterId,
          targetId,
          role ?? null,
          "This FG role is no longer available.",
        ),
      ],
      components: [],
      allowedMentions: { parse: [] },
    });
    return true;
  }

  if (button.customId === "fg-share:no") {
    await button.update({
      embeds: [
        buildShareEmbed(
          "FG role declined",
          requesterId,
          targetId,
          role,
          `<@${targetId}> declined ${role}.`,
        ),
      ],
      components: [],
      allowedMentions: { parse: [] },
    });
    return true;
  }

  if (!(await mayShareRole(guild, requesterId, roleId, access))) {
    await button.update({
      embeds: [
        buildShareEmbed(
          "FG role offer ended",
          requesterId,
          targetId,
          role,
          "The person who shared this role no longer has share access.",
        ),
      ],
      components: [],
      allowedMentions: { parse: [] },
    });
    return true;
  }

  const target = await guild.members.fetch(targetId).catch(() => null);
  const botMember = guild.members.me ?? (await guild.members.fetchMe().catch(() => null));
  if (!target || !botMember?.permissions.has("ManageRoles") ||
      botMember.roles.highest.comparePositionTo(role) <= 0) {
    await button.update({
      embeds: [
        buildShareEmbed(
          "FG role could not be applied",
          requesterId,
          targetId,
          role,
          "The bot can't manage this role right now. Ask server staff to check its role order and permissions.",
        ),
      ],
      components: [],
      allowedMentions: { parse: [] },
    });
    return true;
  }

  if (target.roles.cache.has(role.id)) {
    await button.update({
      embeds: [
        buildShareEmbed(
          "FG role already assigned",
          requesterId,
          targetId,
          role,
          `<@${targetId}> already has ${role}.`,
        ),
      ],
      components: [],
      allowedMentions: { parse: [] },
    });
    return true;
  }

  try {
    await target.roles.add(role, `FG role accepted by ${targetId}`);
    await button.update({
      embeds: [
        buildShareEmbed(
          "FG role accepted",
          requesterId,
          targetId,
          role,
          `<@${targetId}> accepted ${role}.`,
        ),
      ],
      components: [],
      allowedMentions: { parse: [] },
    });
  } catch {
    await button.update({
      embeds: [
        buildShareEmbed(
          "FG role could not be applied",
          requesterId,
          targetId,
          role,
          "The bot couldn't assign this role. Ask server staff to check its permissions.",
        ),
      ],
      components: [],
      allowedMentions: { parse: [] },
    });
  }
  return true;
}

async function sendShareOffer(
  channel: TextChannel,
  guild: Guild,
  requesterId: string,
  targetId: string,
  role: Role,
  store: ConfigStore,
): Promise<void> {
  const settings = store.get(guild.id);
  const access = settings.fgRoles[role.id];
  const requester = await guild.members.fetch(requesterId).catch(() => null);
  const target = await guild.members.fetch(targetId).catch(() => null);
  if (!target) {
    await channel.send("The mentioned member is no longer in this server.");
    return;
  }
  if (!requester || !access || !canShareFgRole(requester, role.id, access)) {
    await channel.send("The person who ran the command no longer has share access.");
    return;
  }
  if (target.roles.cache.has(role.id)) {
    await channel.send("That member already has this FG role.");
    return;
  }

  const payload: MessageCreateOptions = {
    embeds: [buildShareEmbed("FG role share", requesterId, targetId, role)],
    components: [buildDecisionButtons()],
    allowedMentions: { parse: [], users: [targetId] },
  };
  const offer = await channel.send(payload);
  const collector = offer.createMessageComponentCollector({
    componentType: ComponentType.Button,
    time: SHARE_TIMEOUT_MS,
  });

  let finishing = false;
  collector.on("collect", async (button) => {
    if (button.customId !== "fg-share:yes" && button.customId !== "fg-share:no") {
      await button.deferUpdate();
      return;
    }
    if (button.user.id !== targetId) {
      await finishOffer(button, guild, requesterId, targetId, role.id, store);
      return;
    }
    if (finishing) {
      await button.deferUpdate();
      return;
    }
    finishing = true;
    let answered = false;
    try {
      answered = await finishOffer(
        button,
        guild,
        requesterId,
        targetId,
        role.id,
        store,
      );
    } catch {
      if (!button.replied && !button.deferred) {
        await button
          .reply({
            content: "The bot couldn't complete this FG role offer.",
            ephemeral: true,
          })
          .catch(() => undefined);
      }
      answered = true;
    }
    if (answered) {
      collector.stop("answered");
    } else {
      finishing = false;
    }
  });

  collector.on("end", async (_collected, reason) => {
    if (reason !== "time") return;
    await offer
      .edit({
        embeds: [
          buildShareEmbed(
            "FG role offer expired",
            requesterId,
            targetId,
            role,
            "This offer expired without a response.",
          ),
        ],
        components: [buildDecisionButtons(true)],
        allowedMentions: { parse: [] },
      })
      .catch(() => undefined);
  });
}

async function selectRoleThenShare(
  message: Message,
  targetId: string,
  eligibleRoles: Role[],
  store: ConfigStore,
): Promise<void> {
  const select = new StringSelectMenuBuilder()
    .setCustomId(`${SHARE_SELECT_PREFIX}:${message.id}`)
    .setPlaceholder("Choose which FG role to share")
    .addOptions(
      eligibleRoles.slice(0, 25).map((role) => ({
        label: role.name.slice(0, 100),
        value: role.id,
      })),
    );
  const prompt = await message.reply({
    content: "Choose the FG role to share with the mentioned member.",
    components: [new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(select)],
    allowedMentions: { parse: [] },
  });
  const collector = prompt.createMessageComponentCollector({
    componentType: ComponentType.StringSelect,
    time: SHARE_TIMEOUT_MS,
  });

  collector.on("collect", async (selection) => {
    if (selection.user.id !== message.author.id) {
      await selection.reply({
        content: "Only the person who ran `,fg share` can choose the role.",
        ephemeral: true,
      });
      return;
    }

    const role = message.guild?.roles.cache.get(selection.values[0]);
    const settings = message.guild ? store.get(message.guild.id) : null;
    const access = role && settings ? settings.fgRoles[role.id] : undefined;
    if (!role || !access || !message.guild) {
      await selection.update({
        content: "That FG role is no longer available.",
        components: [],
      });
      collector.stop("missing-role");
      return;
    }

    await selection.update({
      content: "FG role selected. The share offer has been sent.",
      components: [],
    });
    await sendShareOffer(
      message.channel as TextChannel,
      message.guild,
      message.author.id,
      targetId,
      role,
      store,
    );
    collector.stop("selected");
  });

  collector.on("end", async (_collected, reason) => {
    if (reason !== "time") return;
    await prompt.edit({
      content: "FG role selection expired.",
      components: [],
    }).catch(() => undefined);
  });
}

export async function handleFgShareMessage(
  message: Message,
  store: ConfigStore,
): Promise<void> {
  if (message.author.bot || !message.guild || !message.channel.isTextBased()) return;
  const content = message.content.trim();
  if (!/^,fg\s+share\b/i.test(content)) return;

  const match = content.match(/^,fg\s+share\s+<@!?(\d+)>\s*$/i);
  if (!match) {
    await message.reply({
      embeds: [{
        color: BOT_BLACK,
        title: "FG role share",
        description: "Usage: `,fg share @member`",
      }],
      allowedMentions: { parse: [] },
    });
    return;
  }

  const targetId = match[1];
  if (targetId === message.author.id) {
    await message.reply("You already have your own FG role.");
    return;
  }

  const target = await message.guild.members.fetch(targetId).catch(() => null);
  const requester = await message.guild.members.fetch(message.author.id).catch(() => null);
  if (!target || !requester) {
    await message.reply("Both people need to be members of this server.");
    return;
  }

  const settings = store.get(message.guild.id);
  const eligibleRoles = Object.entries(settings.fgRoles)
    .filter(([roleId, access]) => canShareFgRole(requester, roleId, access))
    .map(([roleId]) => message.guild!.roles.cache.get(roleId))
    .filter((role): role is Role => Boolean(role));

  if (eligibleRoles.length === 0) {
    await message.reply(
      "You need to hold an FG role and be individually whitelisted to share it.",
    );
    return;
  }

  if (!("send" in message.channel)) return;
  const channel = message.channel as TextChannel;
  if (eligibleRoles.length === 1) {
    const role = eligibleRoles[0];
    await sendShareOffer(
      channel,
      message.guild,
      requester.id,
      target.id,
      role,
      store,
    );
    return;
  }

  await selectRoleThenShare(message, target.id, eligibleRoles, store);
}
