import assert from "node:assert/strict";
import test from "node:test";
import { wildEmbed, wildFieldEmbed } from "./embeds.js";

/** No emoji anywhere in Wild output: pictographs, dingbats, arrows, etc. */
const EMOJI_PATTERN =
  /[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{2B00}-\u{2BFF}\u{25A0}-\u{25FF}\u{2190}-\u{21FF}\u{2300}-\u{23FF}\u{FE0F}\u{200D}]/u;

test("wildFieldEmbed: no colour, no footer, no timestamp, one field per item", () => {
  const embed = wildFieldEmbed(
    "Help - FG (1/2)",
    [
      { name: "`/fg base @role`", value: "Set the FG base role\nWho: Manage Server" },
      { name: "`/fg color <color> <name>`", value: "Make your own FG role\nWho: Owner / whitelisted" },
    ],
    "Personal FG roles.",
  ).toJSON();

  // No colour set at all: the embed renders with no accent bar and
  // blends into the chat background (looks invisible).
  assert.equal(embed.color, undefined);
  assert.equal(embed.footer, undefined);
  assert.equal(embed.timestamp, undefined);
  assert.equal(embed.title, "Help - FG (1/2)");
  assert.equal(embed.fields?.length, 2);
  assert.equal(embed.fields?.[0]?.name, "`/fg base @role`");
  assert.doesNotMatch(JSON.stringify(embed), EMOJI_PATTERN);
});

test("wildEmbed has no colour, no footer, and no timestamp", () => {
  const embed = wildEmbed("Wild", "No FG roles yet.").toJSON();
  assert.equal(embed.color, undefined);
  assert.equal(embed.footer, undefined);
  assert.equal(embed.timestamp, undefined);
  assert.doesNotMatch(JSON.stringify(embed), EMOJI_PATTERN);
});

test("no embed builder in non-test source sets a colour", async () => {
  const { readdir, readFile } = await import("node:fs/promises");
  const { fileURLToPath } = await import("node:url");
  const dir = fileURLToPath(new URL(".", import.meta.url));
  for (const name of await readdir(dir)) {
    if (!name.endsWith(".ts") || name.endsWith(".test.ts")) continue;
    const source = await readFile(`${dir}${name}`, "utf-8");
    assert.doesNotMatch(source, /setColor\s*\(/, `${name} must not set an embed colour`);
    assert.doesNotMatch(source, /BOT_BLACK|BOT_WHITE/, `${name} must not use a colour constant`);
  }
});
