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
  isHelpPrivileged,
  parseHelpButton,
  resolveHelpTarget,
  resolveHelpTopic,
  type HelpContext,
  type HelpPage,
} from "./help.js";
import type { ConfigStore, GuildSettings } from "./config-store.js";

const PRIVILEGED: HelpContext = { privileged: true, mode: "slash" };
const NORMAL: HelpContext = { privileged: false, mode: "slash" };
const PREFIX: HelpContext = { privileged: true, mode: "prefix" };
const NORMAL_PREFIX: HelpContext = { privileged: false, mode: "prefix" };

interface Reply {
  content?: string;
  embeds?: EmbedBuilder[];
  components?: unknown[];
  ephemeral?: boolean;
}

function createInteraction(
  topic?: string | null,
  options: {
    userId?: string;
    member?: unknown;
    guild?: { ownerId?: string } | null;
    guildId?: string | null;
    store?: ConfigStore;
  } = {},
) {
  const replies: Reply[] = [];
  const interaction = {
    commandName: "help",
    user: { id: options.userId ?? "111111111111111111" },
    guildId: options.guildId ?? null,
    guild: options.guild ?? null,
    member: options.member ?? null,
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
  return { interaction, replies, store: options.store };
}

function makeSettings(partial: Partial<GuildSettings> = {}): GuildSettings {
  return {
    protectedRoleIds: [],
    allowedUserIds: [],
    allowedRoleIds: [],
    fgStaffUserIds: [],
    fgStaffRoleIds: [],
    fgRoles: {},
    fgBaseRoleId: null,
    fgAwardRoleId: null,
    fgRoleOwners: {},
    blacklist: {},
    logChannelId: null,
    enforcementEnabled: true,
    ...partial,
  };
}

function makeStore(settings: GuildSettings): ConfigStore {
  return { get: () => settings } as unknown as ConfigStore;
}

function normalMember(id = "111111111111111111") {
  return {
    id,
    permissions: { has: () => false },
    roles: { cache: { some: () => false } },
  };
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
  // No colour set at all: the embed blends into the chat background.
  assert.equal(embed?.color, undefined);
  assert.equal(embed?.footer, undefined);
  assert.equal(embed?.timestamp, undefined);
  assertNoEmoji(embedText(reply));
}

function fieldTextFromPage(page: HelpPage): string {
  return page.fields.map((field) => `${field.name}\n${field.value}`).join("\n");
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
  assert.match(result.page.fields[1].value, /12 commands/);
  assert.match(result.page.description ?? "", /\/help <command>/);
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
  assert.equal(result.page.fields[0].name, "`/fg base @role`");
  assert.match(result.page.fields[0].value, /Set the FG base role/);
  assert.match(result.page.fields[0].value, /Who: Manage Server/);
  assert.equal(result.page.fields[1].name, "`/fg color <color> <name>`");
  assert.equal(
    result.page.fields[2].name,
    "`/fg create <name> <color> [second_color] [@member]`",
  );
  assert.deepEqual(
    result.page.buttons.map((button) => button.label),
    ["Next", "Back"],
  );
  assert.doesNotMatch(fieldTextFromPage(result.page), /\|/);
  assert.doesNotMatch(fieldTextFromPage(result.page), /,fg /);
});

test("/help fg page 2 has the award commands and a Prev button", () => {
  const result = resolveHelpTarget("category:fg:2");
  assert.equal(result.kind, "embed");
  if (result.kind !== "embed") return;
  assert.equal(result.page.title, "Wild help - FG (2/2)");
  assert.equal(result.page.fields.length, 6);
  assert.equal(result.page.fields[0].name, "`/fg list`");
  assert.equal(result.page.fields[3].name, "`/fg award set @role`");
  assert.equal(result.page.fields[5].name, "`/fg award remove`");
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
  assert.equal(result.page.fields[0].name, "`/protect @role`");
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
  assert.equal(result.page.fields[0].name, "`/blacklist add @user @role`");
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
  assert.doesNotMatch(fields[0].value, /,fg create/);
  assert.match(fields[2].value, /Owner \/ whitelisted/);
  assert.match(fields[3].value, /\/fg create My Role #ff0000 @Alex/);
});

test("/help blacklist add shows one command with its syntax and gate", async () => {
  const { interaction, replies } = createInteraction("blacklist add");
  await handleHelpCommand(interaction);

  assertUniformEmbed(replies[0]);
  const text = embedText(replies[0]);
  assert.match(text, /\/blacklist add @user @role/);
  assert.doesNotMatch(text, /,blacklist add/);
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

test("normal user main help shows FG only, no Guard or Blacklist", () => {
  const result = resolveHelpTopic(null, NORMAL);
  assert.equal(result.kind, "embed");
  if (result.kind !== "embed") return;
  assert.deepEqual(
    result.page.fields.map((field) => field.name),
    ["FG"],
  );
  assert.match(result.page.fields[0].value, /6 commands/);
  assert.match(result.page.description ?? "", /admins and whitelisted members/);
  assert.deepEqual(
    result.page.buttons.map((button) => button.label),
    ["FG"],
  );
  assert.doesNotMatch(fieldTextFromPage(result.page), /Guard|Blacklist/);
});

test("normal user FG page hides base, list, cleanup, and award", () => {
  const result = resolveHelpTopic("fg", NORMAL);
  assert.equal(result.kind, "embed");
  if (result.kind !== "embed") return;
  assert.equal(result.page.title, "Wild help - FG");
  assert.equal(result.page.fields.length, 6);
  assert.deepEqual(
    result.page.fields.map((field) => field.name),
    [
      "`/fg color <color> <name>`",
      "`/fg create <name> <color> [second_color] [@member]`",
      "`/fg rename <name>`",
      "`/fg icon <url>`",
      "`/fg remove`",
      "`/fg share @member @role`",
    ],
  );
  assert.deepEqual(
    result.page.buttons.map((button) => button.label),
    ["Back"],
  );
  assert.doesNotMatch(fieldTextFromPage(result.page), /base|award|cleanup/);
  assert.doesNotMatch(fieldTextFromPage(result.page), /\/fg list/);
});

test("normal user asking for an admin-only command gets an error, never its syntax", () => {
  for (const topic of ["fg base", "fg list", "fg cleanup", "fg award set", "protect", "blacklist add", "status"]) {
    const result = resolveHelpTopic(topic, NORMAL);
    assert.equal(result.kind, "error", topic);
    if (result.kind !== "error") continue;
    assert.equal(
      result.message,
      "That command is for admins and whitelisted members.",
    );
  }
  const category = resolveHelpTopic("guard", NORMAL);
  assert.equal(category.kind, "error");
  if (category.kind === "error") {
    assert.equal(
      category.message,
      "That help is for admins and whitelisted members.",
    );
  }
  const blacklist = resolveHelpTopic("blacklist", NORMAL);
  assert.equal(blacklist.kind, "error");
});

test("normal user can still see FG commands they may use", () => {
  for (const topic of ["fg color", "fg create", "fg rename", "fg share"]) {
    const result = resolveHelpTopic(topic, NORMAL);
    assert.equal(result.kind, "embed", topic);
  }
});

test("prefix-invoked help shows prefix syntax only", () => {
  const result = resolveHelpTopic("fg", PREFIX);
  assert.equal(result.kind, "embed");
  if (result.kind !== "embed") return;
  assert.equal(result.page.fields[0].name, "`,fg base @role`");
  assert.doesNotMatch(fieldTextFromPage(result.page), /\/fg /);
  assert.match(result.page.description ?? "", /Personal FG roles/);

  const single = resolveHelpTopic("fg create", PREFIX);
  assert.equal(single.kind, "embed");
  if (single.kind !== "embed") return;
  const fields = single.page.fields;
  assert.match(fields[0].value, /,fg create <name> <color>/);
  assert.doesNotMatch(fields[0].value, /\/fg create/);
  assert.match(fields[3].value, /,fg create My Role #ff0000 @Alex/);

  const main = resolveHelpTopic(null, PREFIX);
  assert.equal(main.kind, "embed");
  if (main.kind === "embed") {
    assert.match(main.page.description ?? "", /,help <command>/);
  }
});

test("normal prefix user sees FG only, with prefix syntax", () => {
  const result = resolveHelpTopic(null, NORMAL_PREFIX);
  assert.equal(result.kind, "embed");
  if (result.kind !== "embed") return;
  assert.deepEqual(
    result.page.fields.map((field) => field.name),
    ["FG"],
  );
  const fg = resolveHelpTopic("fg", NORMAL_PREFIX);
  assert.equal(fg.kind, "embed");
  if (fg.kind === "embed") {
    assert.equal(fg.page.fields[0].name, "`,fg color <color> <name> [second_color]`");
  }
});

test("isHelpPrivileged: owner, Administrator, and whitelisted pass; normal fails", () => {
  const settings = makeSettings({ allowedUserIds: ["111111111111111111"] });
  const settingsByRole = makeSettings({ allowedRoleIds: ["444444444444444444"] });
  const empty = makeSettings();

  assert.equal(
    isHelpPrivileged(normalMember(), "111111111111111111", empty),
    true,
    "owner",
  );
  assert.equal(
    isHelpPrivileged(
      { id: "222222222222222222", permissions: { has: () => true }, roles: { cache: { some: () => false } } },
      "999999999999999999",
      empty,
    ),
    true,
    "Administrator",
  );
  assert.equal(isHelpPrivileged(normalMember(), "999999999999999999", settings), true, "whitelisted user");
  assert.equal(
    isHelpPrivileged(
      { ...normalMember(), roles: { cache: { some: (predicate: (role: { id: string }) => boolean) => predicate({ id: "444444444444444444" }) } } },
      "999999999999999999",
      settingsByRole,
    ),
    true,
    "whitelisted role",
  );
  assert.equal(isHelpPrivileged(normalMember(), "999999999999999999", empty), false, "normal user");
  assert.equal(isHelpPrivileged(null, "999999999999999999", empty), true, "no member to check");
});

test("handleHelpCommand gates by member: normal sees FG only, whitelisted sees all", async () => {
  const guildId = "111111111111111111";
  const guild = { ownerId: "999999999999999999" };

  const normal = createInteraction(null, {
    guildId,
    guild,
    member: normalMember(),
    store: makeStore(makeSettings()),
  });
  await handleHelpCommand(normal.interaction, normal.store);
  assertUniformEmbed(normal.replies[0]);
  assert.deepEqual(
    (embedJson(normal.replies[0])?.fields ?? []).map(
      (field: { name: string }) => field.name,
    ),
    ["FG"],
  );

  const privileged = createInteraction(null, {
    guildId,
    guild,
    member: normalMember(),
    store: makeStore(makeSettings({ allowedUserIds: ["111111111111111111"] })),
  });
  await handleHelpCommand(privileged.interaction, privileged.store);
  assert.deepEqual(
    (embedJson(privileged.replies[0])?.fields ?? []).map(
      (field: { name: string }) => field.name,
    ),
    ["Guard", "FG", "Blacklist"],
  );

  const normalTopic = createInteraction("fg base", {
    guildId,
    guild,
    member: normalMember(),
    store: makeStore(makeSettings()),
  });
  await handleHelpCommand(normalTopic.interaction, normalTopic.store);
  assert.equal(normalTopic.replies[0].embeds, undefined);
  assert.equal(
    normalTopic.replies[0].content,
    "That command is for admins and whitelisted members.",
  );
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
    member: normalMember(userId),
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

test("help buttons: a normal user pressing a Guard button is rejected", async () => {
  const { button, calls } = createButton(
    "wild-help:111111111111111111:category:guard:1",
    "111111111111111111",
  );
  const page = await handleHelpButton(button, { privileged: false });
  assert.equal(page, null);
  assert.equal(calls[0]?.kind, "reply");
  const reply = calls[0]?.data as { content?: string; ephemeral?: boolean };
  assert.equal(reply.ephemeral, true);
  assert.equal(reply.content, "That help is for admins and whitelisted members.");
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
  // Normal-user pages too, in both modes.
  for (const ctx of [NORMAL, NORMAL_PREFIX]) {
    const normalMain = resolveHelpTopic(null, ctx);
    assert.equal(normalMain.kind, "embed");
    if (normalMain.kind === "embed") {
      assertNoEmoji(fieldTextFromPage(normalMain.page));
    }
    const normalFg = resolveHelpTopic("fg", ctx);
    assert.equal(normalFg.kind, "embed");
    if (normalFg.kind === "embed") {
      assertNoEmoji(fieldTextFromPage(normalFg.page));
    }
  }
});
