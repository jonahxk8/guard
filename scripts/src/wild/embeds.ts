import { EmbedBuilder } from "discord.js";

export const BOT_BLACK = 0x000000;

/** Backwards-compatible alias. Wild embeds are black (colour 0). */
export const BOT_WHITE = BOT_BLACK;

export function wildEmbed(title: string, description: string): EmbedBuilder {
  return new EmbedBuilder()
    .setColor(BOT_BLACK)
    .setTitle(title)
    .setDescription(description);
}
