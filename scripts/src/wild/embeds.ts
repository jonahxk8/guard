import { EmbedBuilder } from "discord.js";

export const BOT_WHITE = 0xffffff;

export function wildEmbed(title: string, description: string): EmbedBuilder {
  return new EmbedBuilder()
    .setColor(BOT_WHITE)
    .setTitle(title)
    .setDescription(description)
    .setFooter({ text: "GUARD" })
    .setTimestamp();
}
