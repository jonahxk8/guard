import { EmbedBuilder } from "discord.js";

export interface WildField {
  name: string;
  value: string;
  inline?: boolean;
}

/**
 * The one shared embed style for every Wild embed (help pages, /status,
 * /fg list, the guard log embed, the share offer, guard DMs).
 *
 * - No colour set at all: no setColor call, so Discord renders the embed
 *   with no accent bar and it blends into the chat background, looking
 *   invisible. Do not add a colour back (not black, not dark grey).
 * - Plain title, no footer, no timestamp, no emojis.
 * - Description is one short intro line only, when present at all.
 * - One field per item: field name is the command syntax (in the form
 *   help was invoked with), field value is at most two short lines —
 *   purpose, then "Who: ...".
 * - Any page indicator goes in the TITLE ("Wild help - FG (1/2)"),
 *   never in a footer.
 */
export function wildFieldEmbed(
  title: string,
  fields: WildField[],
  description?: string,
): EmbedBuilder {
  const embed = new EmbedBuilder().setTitle(title);
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

/** Backwards-compatible helper: an embed with a title + description. */
export function wildEmbed(title: string, description: string): EmbedBuilder {
  return wildFieldEmbed(title, [], description);
}
