import { EmbedBuilder } from "discord.js";

export const BOT_BLACK = 0x000000;

/** Backwards-compatible alias. Wild embeds are black (colour 0). */
export const BOT_WHITE = BOT_BLACK;

export interface WildField {
  name: string;
  value: string;
  inline?: boolean;
}

/**
 * The one shared embed style for every Wild embed (help pages, /status,
 * /fg list, the guard log embed, the share offer).
 *
 * - Black (colour 0), plain title, no footer, no timestamp, no emojis.
 * - Description is one short intro line only, when present at all.
 * - One field per item: field name is the command syntax (slash form
 *   first, prefix form on a second line), field value is at most two
 *   short lines — purpose, then "Who: ...".
 * - Any page indicator goes in the TITLE ("Wild help - FG (1/2)"),
 *   never in a footer.
 */
export function wildFieldEmbed(
  title: string,
  fields: WildField[],
  description?: string,
): EmbedBuilder {
  const embed = new EmbedBuilder().setColor(BOT_BLACK).setTitle(title);
  if (description) embed.setDescription(description);
  for (const field of fields) {
    embed.addFields({
      name: field.name,
      value: field.value,
      inline: field.inline ?? false,
    });
  }
  return embed;
}

/** Backwards-compatible helper: a black embed with a title + description. */
export function wildEmbed(title: string, description: string): EmbedBuilder {
  return wildFieldEmbed(title, [], description);
}
