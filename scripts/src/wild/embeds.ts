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
 * - No color set at all: no setColor call, so Discord renders the embed
 *   with no accent bar and it blends into the chat background, looking
 *   invisible. Do not add a color back (not black, not dark grey).
 * - Plain title, no footer, no timestamp, no emojis.
 * - Description is one short intro line only, when present at all.
 * - One field per item: field name is the command syntax (in the form
 *   help was invoked with), field value is one short purpose line —
 *   there are no "Who:" lines; help is filtered per user instead.
 * - Any page indicator goes in the TITLE ("Help - FG (1/2)"),
 *   never in a footer.
 * - Small replies (confirmations, errors, one-line hints) are embeds
 *   too: wildMessageEmbed puts the short text in the description of a
 *   colorless embed with no title. No plain-text replies anywhere.
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

/**
 * The one format for every small reply: the short text as the
 * description of a colorless embed with no title, no footer, no
 * timestamp, no emojis. Used for confirmations, errors, and one-line
 * hints — never send a small reply as plain text.
 */
export function wildMessageEmbed(text: string): EmbedBuilder {
  return new EmbedBuilder().setDescription(text);
}
