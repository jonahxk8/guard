import assert from "node:assert/strict";
import test from "node:test";
import { wildEmbed, wildFieldEmbed } from "./embeds.js";

/** No emoji anywhere in Wild output: pictographs, dingbats, arrows, etc. */
const EMOJI_PATTERN =
  /[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{2B00}-\u{2BFF}\u{25A0}-\u{25FF}\u{2190}-\u{21FF}\u{2300}-\u{23FF}\u{FE0F}\u{200D}]/u;

test("wildFieldEmbed: black, no footer, no timestamp, one field per item", () => {
  const embed = wildFieldEmbed(
    "Wild help - FG (1/2)",
    [
      { name: "`/fg base @role`\n`,fg base @role`", value: "Set the base role\nWho: Manage Server" },
      { name: "`/fg color <color> <name>`", value: "Make your own FG role\nWho: Server owner or whitelisted members" },
    ],
    "Personal FG roles.",
  ).toJSON();

  assert.equal(embed.color, 0);
  assert.equal(embed.footer, undefined);
  assert.equal(embed.timestamp, undefined);
  assert.equal(embed.title, "Wild help - FG (1/2)");
  assert.equal(embed.fields?.length, 2);
  assert.equal(embed.fields?.[0]?.name, "`/fg base @role`\n`,fg base @role`");
  assert.doesNotMatch(JSON.stringify(embed), EMOJI_PATTERN);
});

test("wildEmbed stays black with no footer or timestamp", () => {
  const embed = wildEmbed("Wild", "No FG roles yet.").toJSON();
  assert.equal(embed.color, 0);
  assert.equal(embed.footer, undefined);
  assert.equal(embed.timestamp, undefined);
  assert.doesNotMatch(JSON.stringify(embed), EMOJI_PATTERN);
});
