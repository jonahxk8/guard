import assert from "node:assert/strict";
import test from "node:test";
import {
  ButtonInteraction,
  ChatInputCommandInteraction,
  EmbedBuilder,
} from "discord.js";
import {
  HELP_CATEGORIES,
  buildHelpComponents,
  handleHelpButton,
  handleHelpCommand,
  parseHelpButton,
  resolveHelpTarget,
  resolveHelpTopic,
  type HelpPage,
} from "./help.js";

interface Reply {
  content?: string;
  embeds?: EmbedBuilder[];
  components?: unknown[];
  ephemeral?: boolean;
}

function createInteraction(topic?: string | null) {
  const replies: Reply[] = [];
  const interaction = {
    commandName: "help",
    user: { id: "111111111111111111" },
    options: {
      getString: (_name: string) => topic ?? null,
    },
    reply: async (reply: Reply) => {
      replies.push(reply);
    },
    // No fetchReply on the test double: the help collector is
    // best-effort and must skip it without throwing.
    fetchReply: async () => {
      throw new Error("no reply message in tests");
    },
  } as unknown as ChatInputCommandInteraction;
  return { interaction, replies };
}

function embedJson(reply: Reply) {
  return reply.embeds?.[0].toJSON();
}

function fieldText(reply: Reply): string {
  const embed = embedJson(reply);
  return (embed?.fields ?? [])
    .map((field) => `${field.name}\n${field.value}`)
    .join("\n");
}

function embedText(reply: Reply): string {
  const embed = embedJson(reply);
  return [embed?.title ?? "", embed?.description ?? "", fieldText(reply)]
    .filter(Boolean)
    .join("\n");
}

/** No emoji anywhere in help output: pictographs, dingbats, arrows, etc. */
const EMOJI_PATTERN =
  /[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{2B00}-\u{2BFF}\u{25A0}-\u{25FF}\u{2190}-\u{21FF}\u{2300}-\u{23FF}\u{FE0F}\u{200D}]/u;

function assertNoEmoji(text: string): void {
  assert.doesNotMatch(text, EMOJI_PATTERN);
}

function assertUniformEmbed(reply: Reply): void {
  const embed = embedJson(reply);
  assert.equal(embed?.color, 0);
  assert.equal(embed?.footer, undefined);
  assert.equal(embed?.timestamp, undefined);
  assertNoEmoji(embedText(reply));
}

test("main help page lists the 3 categories as fields, with category buttons", () => {
  const result = resolveHelpTopic(null);
  assert.equal(result.kind, "embed");
  if (result.kind !== "embed") return;
  assert.equal(result.page.title, "Wild help");
  assert.equal(result.page.kind, "main");
  assert.deepEqual(
    result.page.fields.map((field) => field.name),
    ["Guard", "FG", "Blacklist"],
  );
  assert.match(result.page.fields[0].value, /Protect roles/);
  assert.match(result.page.fields[1].value, /\/help fg/);
  assert.deepEqual(
    result.page.buttons.map((button) => button.label),
    ["Guard", "FG", "Blacklist"],
  );
  assert.doesNotMatch(
    result.page.fields.map((field) => field.value).join("\n"),
    /\|/,
  );
});

test("/help fg page 1 has 6 commands and a Next button", () => {
  const result = resolveHelpTopic("fg");
  assert.equal(result.kind, "embed");
  if (result.kind !== "embed") return;
  assert.equal(result.page.title, "Wild help - FG (1/2)");
  assert.equal(result.page.fields.length, 6);
  assert.match(result.page.fields[0].name, /\/fg base @role/);
  assert.match(result.page.fields[0].name, /,fg base @role/);
  assert.match(result.page.fields[0].value, /Set the base role/);
  assert.match(result.page.fields[0].value, /Who: Manage Server/);
  assert.match(result.page.fields[1].name, /\/fg color <color> <name>/);
  assert.match(result.page.fields[2].name, /\/fg create <name> <color>/);
  assert.deepEqual(
    result.page.buttons.map((button) => button.label),
    ["Next", "Back"],
  );
  assert.doesNotMatch(fieldTextFromPage(result.page), /\|/);
});

function fieldTextFromPage(page: HelpPage): string {
  return page.fields.map((field) => `${field.name}\n${field.value}`).join("\n");
}

test("/help fg page 2 has the award commands and a Prev button", () => {
  const result = resolveHelpTarget("category:fg:2");
  assert.equal(result.kind, "embed");
  if (result.kind !== "embed") return;
  assert.equal(result.page.title, "Wild help - FG (2/2)");
  assert.equal(result.page.fields.length, 6);
  assert.match(result.page.fields[0].name, /\/fg list/);
  assert.match(result.page.fields[3].name, /\/fg award set @role/);
  assert.match(result.page.fields[5].name, /\/fg award remove/);
  assert.deepEqual(
    result.page.buttons.map((button) => button.label),
    ["Prev", "Back"],
  );
});

test("/help guard is one page with a Back button only", () => {
  const result = resolveHelpTopic("guard");
  assert.equal(result.kind, "embed");
  if (result.kind !== "embed") return;
  assert.equal(result.page.title, "Wild help - Guard");
  assert.equal(result.page.fields.length, 4);
  assert.match(result.page.fields[0].name, /\/protect @role/);
  assert.match(result.page.fields[0].name, /,guard @role/);
  assert.deepEqual(
    result.page.buttons.map((button) => button.label),
    ["Back"],
  );
  assert.doesNotMatch(fieldTextFromPage(result.page), /\/fg /);
  assert.doesNotMatch(fieldTextFromPage(result.page), /\/blacklist/);
});

test("/help blacklist is one page with 3 commands", () => {
  const result = resolveHelpTopic("blacklist");
  assert.equal(result.kind, "embed");
  if (result.kind !== "embed") return;
  assert.equal(result.page.title, "Wild help - Blacklist");
  assert.equal(result.page.fields.length, 3);
  assert.match(result.page.fields[0].name, /\/blacklist add @user @role/);
  assert.deepEqual(
    result.page.buttons.map((button) => button.label),
    ["Back"],
  );
});

test("/help fg create shows syntax, purpose, gate, and example in fields", async () => {
  const { interaction, replies } = createInteraction("fg create");
  await handleHelpCommand(interaction);

  assert.equal(replies[0].ephemeral, true);
  assertUniformEmbed(replies[0]);
  const embed = embedJson(replies[0]);
  assert.equal(embed?.title, "fg create");
  const fields = embed?.fields ?? [];
  assert.deepEqual(
    fields.map((field) => field.name),
    ["Syntax", "What it does", "Who can use it", "Example"],
  );
  assert.match(fields[0].value, /\/fg create <name> <color>/);
  assert.match(fields[0].value, /,fg create <name> <color>/);
  assert.match(fields[2].value, /Server owner or whitelisted members/);
  assert.match(fields[3].value, /\/fg create My Role #ff0000 @Alex/);
});

test("/help blacklist add shows one command with its syntax and gate", async () => {
  const { interaction, replies } = createInteraction("blacklist add");
  await handleHelpCommand(interaction);

  assertUniformEmbed(replies[0]);
  const text = embedText(replies[0]);
  assert.match(text, /\/blacklist add @user @role/);
  assert.match(text, /,blacklist add @user @role/);
  assert.match(text, /Manage Server/);
  assert.doesNotMatch(text, /\/blacklist remove/);
});

test("/help with an unknown topic errors with a pointer to /help", async () => {
  const { interaction, replies } = createInteraction("nonsense");
  await handleHelpCommand(interaction);

  assert.equal(replies[0].embeds, undefined);
  assert.equal(replies[0].ephemeral, true);
  assert.match(replies[0].content ?? "", /No help for "nonsense"/);
  assert.match(replies[0].content ?? "", /Use \/help to see all commands/);
  assert.doesNotMatch(replies[0].content ?? "", /\|/);
});

test("help buttons: parse round-trips the owner and target", () => {
  const page = resolveHelpTopic("fg");
  assert.equal(page.kind, "embed");
  if (page.kind !== "embed") return;
  const rows = buildHelpComponents(page.page, "111111111111111111");
  assert.equal(rows.length, 1);
  const customIds = rows[0].components.map(
    (button) => (button.toJSON() as { custom_id?: string }).custom_id,
  );
  assert.deepEqual(customIds, [
    "wild-help:111111111111111111:category:fg:2",
    "wild-help:111111111111111111:main",
  ]);
  assert.deepEqual(parseHelpButton(customIds[0]!), {
    ownerId: "111111111111111111",
    target: "category:fg:2",
  });
  assert.equal(parseHelpButton("fg-share:yes"), null);
  assert.equal(parseHelpButton("wild-help:bad"), null);
});

function createButton(customId: string, userId: string) {
  const calls: { kind: string; data?: unknown }[] = [];
  const button = {
    customId,
    user: { id: userId },
    update: async (data: unknown) => {
      calls.push({ kind: "update", data });
    },
    reply: async (data: unknown) => {
      calls.push({ kind: "reply", data });
    },
    deferUpdate: async () => {
      calls.push({ kind: "deferUpdate" });
    },
  } as unknown as ButtonInteraction;
  return { button, calls };
}

test("help buttons: the owner navigates to FG page 2, a stranger is rejected", async () => {
  const owner = createButton(
    "wild-help:111111111111111111:category:fg:2",
    "111111111111111111",
  );
  const page = await handleHelpButton(owner.button);
  assert.equal(page?.title, "Wild help - FG (2/2)");
  assert.equal(owner.calls[0]?.kind, "update");
  const update = owner.calls[0]?.data as { embeds?: EmbedBuilder[] };
  assert.equal(update.embeds?.[0].toJSON().title, "Wild help - FG (2/2)");

  const stranger = createButton(
    "wild-help:111111111111111111:category:fg:2",
    "222222222222222222",
  );
  const rejected = await handleHelpButton(stranger.button);
  assert.equal(rejected, null);
  assert.equal(stranger.calls[0]?.kind, "reply");
  const reply = stranger.calls[0]?.data as { content?: string; ephemeral?: boolean };
  assert.equal(reply.ephemeral, true);
  assert.match(reply.content ?? "", /isn't yours/);
});

test("help buttons: Back from a command page returns to its category page", async () => {
  const resolved = resolveHelpTopic("fg share");
  assert.equal(resolved.kind, "embed");
  if (resolved.kind !== "embed") return;
  // fg share sits on FG page 2, so its Back button targets category:fg:2.
  assert.deepEqual(
    resolved.page.buttons.map((button) => button.id),
    ["category:fg:2"],
  );
  const { button, calls } = createButton(
    "wild-help:111111111111111111:category:fg:2",
    "111111111111111111",
  );
  const page = await handleHelpButton(button);
  assert.equal(page?.title, "Wild help - FG (2/2)");
  assert.equal(calls[0]?.kind, "update");
});

test("no help page, category, or entry contains an emoji or a usage wall", () => {
  for (const category of HELP_CATEGORIES) {
    for (const page of [1, 2]) {
      const result = resolveHelpTarget(`category:${category.key}:${page}`);
      if (result.kind !== "embed") continue;
      assertNoEmoji(
        [result.page.title, result.page.description ?? "", fieldTextFromPage(result.page)].join("\n"),
      );
      assert.doesNotMatch(fieldTextFromPage(result.page), / \| /);
    }
  }
  const main = resolveHelpTopic(null);
  assert.equal(main.kind, "embed");
  if (main.kind === "embed") {
    assertNoEmoji(
      [main.page.title, main.page.description ?? "", fieldTextFromPage(main.page)].join("\n"),
    );
  }
});
