import { EmbedBuilder } from "discord.js";

export const WILD_PURPLE = 0x8b5cf6;

export function wildEmbed(title: string, description: string): EmbedBuilder {
  return new EmbedBuilder()
    .setColor(WILD_PURPLE)
    .setTitle(title)
    .setDescription(description)
    .setFooter({ text: "WILD • ROLE GUARD" })
    .setTimestamp();
}
