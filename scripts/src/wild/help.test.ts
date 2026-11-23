import assert from "node:assert/strict";
import test from "node:test";
import {
  ButtonInteraction,
  ChatInputCommandInteraction,
  EmbedBuilder,
  PermissionFlagsBits,
  PermissionsBitField,
} from "discord.js";
import {
  ALL_CAPS,
  CANNOT_USE_COMMAND_ERROR,
  HELP_CATEGORIES,
  NO_FG_ROLE_NOTE,
  buildHelpComponents,
  computeHelpCapabilities,
  deriveCaps,
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
import { ADMIN_ROLE_IDS } from "./authorization.js";

// Personas: FULL sees everything; OWNER is the server owner; ADMIN holds
// a staff admin role; WHITELISTED is whitelisted staff; FG_OWNER owns an FG
// role; HOLDER was assigned an FG role (and can share it); SHARER was
// authed to share a role they do not hold; NORMAL is a plain member.
const FULL: HelpContext = { caps: ALL_CAPS, mode: "slash" };
const FULL_PREFIX: HelpContext = { caps: ALL_CAPS, mode: "prefix" };
const NORMAL: HelpContext = { caps: deriveCaps({}), mode: "slash" };
const NORMAL_PREFIX: HelpContext = { caps: deriveCaps({}), mode: "prefix" };
const OWNER: HelpContext = {
  caps: deriveCaps({ owner: true, admin: true, manageServer: true }),
  mode: "slash",
};
const ADMIN: HelpContext = {
  caps: deriveCaps({ admin: true, manageServer: true }),
  mode: "slash",
};
const WHITELISTED: HelpContext = {
  caps: deriveCaps({ whitelisted: true }),
  mode: "slash",
};
const FG_OWNER: HelpContext = {
  caps: deriveCaps({ ownsFgRole: true, holdsFgRole: true }),
  mode: "slash",
};
const HOLDER: HelpContext = {
  caps: deriveCaps({ holdsFgRole: true, listedSharer: true }),
  mode: "slash",
};
const SHARER: HelpContext = {
  caps: deriveCaps({ listedSharer: true }),
  mode: "slash",
};

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
    fgRoleSharers: {},
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
  // No color set at all: the embed blends into the chat background.
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
  assert.equal(result.page.title, "Help");
  assert.equal(result.page.kind, "main");
  assert.deepEqual(
    result.page.fields.map((field) => field.name),
    ["Guard", "FG", "Blacklist"],
  );
  assert.match(result.page.fields[0].value, /Protect roles/);
  assert.match(result.page.fields[1].value, /15 commands/);
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

test("/help fg page 1 has 7 commands and a Next button", () => {
  const result = resolveHelpTopic("fg");
  assert.equal(result.kind, "embed");
  if (result.kind !== "embed") return;
  assert.equal(result.page.title, "Help - FG (1/3)");
  assert.equal(result.page.fields.length, 7);
  assert.equal(result.page.fields[0].name, "`/fg base @role`");
  assert.equal(result.page.fields[0].value, "Set the FG base role");
  assert.equal(result.page.fields[1].name, "`/fg color <color> [second_color]`");
  assert.equal(
    result.page.fields[2].name,
    "`/fg create <name> [@member]`",
  );
  assert.equal(result.page.fields[3].name, "`/fg add @role @member`");
  assert.equal(result.page.fields[6].name, "`/fg remove`");
  assert.deepEqual(
    result.page.buttons.map((button) => button.label),
    ["Next", "Back"],
  );
  assert.doesNotMatch(fieldTextFromPage(result.page), /\|/);
  assert.doesNotMatch(fieldTextFromPage(result.page), /,fg /);
});

test("/help fg page 2 has drop, members, list, cleanup, share, and auth, and Prev/Next buttons", () => {
  const result = resolveHelpTarget("category:fg:2");
  assert.equal(result.kind, "embed");
  if (result.kind !== "embed") return;
  assert.equal(result.page.title, "Help - FG (2/3)");
  assert.equal(result.page.fields.length, 7);
  assert.equal(result.page.fields[0].name, "`/fg drop`");
  assert.equal(result.page.fields[1].name, "`/fg members`");
  assert.equal(result.page.fields[2].name, "`/fg list`");
  assert.equal(result.page.fields[3].name, "`/fg cleanup`");
  assert.equal(result.page.fields[4].name, "`/fg share @member`");
  assert.equal(result.page.fields[5].name, "`/fg auth add @member`");
  assert.equal(result.page.fields[6].name, "`/fg auth remove @member`");
  assert.deepEqual(
    result.page.buttons.map((button) => button.label),
    ["Prev", "Next", "Back"],
  );
});

test("/help fg page 3 has auth list only, and a Prev button", () => {
  const result = resolveHelpTarget("category:fg:3");
  assert.equal(result.kind, "embed");
  if (result.kind !== "embed") return;
  assert.equal(result.page.title, "Help - FG (3/3)");
  assert.equal(result.page.fields.length, 1);
  assert.equal(result.page.fields[0].name, "`/fg auth list [@role]`");
  assert.deepEqual(
    result.page.buttons.map((button) => button.label),
    ["Prev", "Back"],
  );
});

test("/help guard is one page with a Back button only", () => {
  const result = resolveHelpTopic("guard");
  assert.equal(result.kind, "embed");
  if (result.kind !== "embed") return;
  assert.equal(result.page.title, "Help - Guard");
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
  assert.equal(result.page.title, "Help - Blacklist");
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
    ["Syntax", "What it does", "Example"],
  );
  assert.match(fields[0].value, /\/fg create <name> \[@member\]/);
  assert.doesNotMatch(fields[0].value, /,fg create/);
  assert.match(fields[2].value, /\/fg create My Role @Alex/);
  assert.doesNotMatch(embedText(replies[0]), /Who:/);
});

test("/help blacklist add shows one command with its syntax and gate", async () => {
  const { interaction, replies } = createInteraction("blacklist add");
  await handleHelpCommand(interaction);

  assertUniformEmbed(replies[0]);
  const text = embedText(replies[0]);
  assert.match(text, /\/blacklist add @user @role/);
  assert.doesNotMatch(text, /,blacklist add/);
  assert.doesNotMatch(text, /Who:/);
  assert.doesNotMatch(text, /\/blacklist remove/);
});

test("/help with an unknown topic errors with a pointer to /help", async () => {
  const { interaction, replies } = createInteraction("nonsense");
  await handleHelpCommand(interaction);

  assert.equal(replies[0].embeds?.length, 1);
  assert.equal(replies[0].ephemeral, true);
  assert.match(embedText(replies[0]), /No help for "nonsense"/);
  assert.match(embedText(replies[0]), /Use \/help to see all commands/);
  assert.doesNotMatch(embedText(replies[0]), /\|/);
});

test("normal user main help shows FG only, with the no-FG-role note", () => {
  const result = resolveHelpTopic(null, NORMAL);
  assert.equal(result.kind, "embed");
  if (result.kind !== "embed") return;
  assert.deepEqual(
    result.page.fields.map((field) => field.name),
    ["FG"],
  );
  assert.equal(result.page.fields[0].value, NO_FG_ROLE_NOTE);
  assert.match(result.page.description ?? "", /\/help <command>/);
  assert.deepEqual(
    result.page.buttons.map((button) => button.label),
    ["FG"],
  );
  assert.doesNotMatch(fieldTextFromPage(result.page), /Guard|Blacklist/);
  assert.doesNotMatch(fieldTextFromPage(result.page), /Who:/);
});

test("normal user FG page shows the note and no commands", () => {
  const result = resolveHelpTopic("fg", NORMAL);
  assert.equal(result.kind, "embed");
  if (result.kind !== "embed") return;
  assert.equal(result.page.title, "Help - FG");
  assert.equal(result.page.fields.length, 0);
  assert.equal(result.page.description, NO_FG_ROLE_NOTE);
  assert.deepEqual(
    result.page.buttons.map((button) => button.label),
    ["Back"],
  );
  assert.doesNotMatch(fieldTextFromPage(result.page), /base|auth|cleanup|share/);
});

test("normal user asking for a command they can't use gets an error, never its syntax", () => {
  for (const topic of ["fg base", "fg add", "fg list", "fg cleanup", "fg color", "fg create", "fg rename", "fg share", "fg auth add", "protect", "blacklist add", "status"]) {
    const result = resolveHelpTopic(topic, NORMAL);
    assert.equal(result.kind, "error", topic);
    if (result.kind !== "error") continue;
    assert.equal(result.message, CANNOT_USE_COMMAND_ERROR);
  }
  const category = resolveHelpTopic("guard", NORMAL);
  assert.equal(category.kind, "error");
  if (category.kind === "error") {
    assert.equal(category.message, CANNOT_USE_COMMAND_ERROR);
  }
  const blacklist = resolveHelpTopic("blacklist", NORMAL);
  assert.equal(blacklist.kind, "error");
});

test("personas see exactly the FG commands they can use", () => {
  const seen = (ctx: HelpContext): string[] => {
    const fields: string[] = [];
    const first = resolveHelpTarget("category:fg:1", ctx);
    if (first.kind !== "embed") return fields;
    fields.push(...first.page.fields.map((field) => field.name));
    // Only fetch later pages when the filtered list actually spans
    // more than one page (FG can span 3 now).
    const pageCount = Number(first.page.title.match(/\((\d+)\/(\d+)\)/)?.[2] ?? "1");
    for (let page = 2; page <= pageCount; page += 1) {
      const next = resolveHelpTarget(`category:fg:${page}`, ctx);
      if (next.kind === "embed") {
        fields.push(...next.page.fields.map((field) => field.name));
      }
    }
    return fields;
  };
  // Server owner: everything except rename/icon/remove/drop (needs to
  // hold a role). Holders is visible: owners can share.
  assert.deepEqual(seen(OWNER), [
    "`/fg base @role`",
    "`/fg color <color> [second_color]`",
    "`/fg create <name> [@member]`",
    "`/fg add @role @member`",
    "`/fg members`",
    "`/fg list`",
    "`/fg cleanup`",
    "`/fg share @member`",
    "`/fg auth add @member`",
    "`/fg auth remove @member`",
    "`/fg auth list [@role]`",
  ]);
  // Staff admin (not whitelisted, owns no FG role): like the owner for
  // FG — creation, sharing, and auth included — except rename/icon/remove
  // (needs to own a role).
  assert.deepEqual(seen(ADMIN), [
    "`/fg base @role`",
    "`/fg color <color> [second_color]`",
    "`/fg create <name> [@member]`",
    "`/fg add @role @member`",
    "`/fg members`",
    "`/fg list`",
    "`/fg cleanup`",
    "`/fg share @member`",
    "`/fg auth add @member`",
    "`/fg auth remove @member`",
    "`/fg auth list [@role]`",
  ]);
  // Whitelisted staff: creation, listing, sharing, and auth.
  assert.deepEqual(seen(WHITELISTED), [
    "`/fg color <color> [second_color]`",
    "`/fg create <name> [@member]`",
    "`/fg add @role @member`",
    "`/fg members`",
    "`/fg list`",
    "`/fg share @member`",
    "`/fg auth add @member`",
    "`/fg auth remove @member`",
    "`/fg auth list [@role]`",
  ]);
  // FG owner: their own role, sharing, and auth — nothing admin-only.
  assert.deepEqual(seen(FG_OWNER), [
    "`/fg color <color> [second_color]`",
    "`/fg rename <name>`",
    "`/fg icon <url>`",
    "`/fg remove`",
    "`/fg drop`",
    "`/fg members`",
    "`/fg share @member`",
    "`/fg auth add @member`",
    "`/fg auth remove @member`",
    "`/fg auth list [@role]`",
  ]);
  // Assigned holder and authed sharer (no role of their own): the
  // holder can also drop the role they hold; both can view members,
  // since members is visible to anyone who can share.
  assert.deepEqual(seen(HOLDER), [
    "`/fg drop`",
    "`/fg members`",
    "`/fg share @member`",
  ]);
  assert.deepEqual(seen(SHARER), ["`/fg members`", "`/fg share @member`"]);
  // Plain member: nothing.
  assert.deepEqual(seen(NORMAL), []);
});

test("personas see the right categories on the main page", () => {
  const categories = (ctx: HelpContext): string[] => {
    const result = resolveHelpTopic(null, ctx);
    return result.kind === "embed"
      ? result.page.fields.map((field) => field.name)
      : [];
  };
  assert.deepEqual(categories(FULL), ["Guard", "FG", "Blacklist"]);
  assert.deepEqual(categories(OWNER), ["Guard", "FG", "Blacklist"]);
  assert.deepEqual(categories(WHITELISTED), ["Guard", "FG", "Blacklist"]);
  assert.deepEqual(categories(ADMIN), ["Guard", "FG", "Blacklist"]);
  assert.deepEqual(categories(FG_OWNER), ["FG"]);
  assert.deepEqual(categories(HOLDER), ["FG"]);
  assert.deepEqual(categories(SHARER), ["FG"]);
  assert.deepEqual(categories(NORMAL), ["FG"]);
  // Command counts are per-user, not totals.
  const fgOwnerMain = resolveHelpTopic(null, FG_OWNER);
  assert.equal(fgOwnerMain.kind, "embed");
  if (fgOwnerMain.kind === "embed") {
    assert.match(fgOwnerMain.page.fields[0]?.value ?? "", /10 commands/);
  }
  const holderMain = resolveHelpTopic(null, HOLDER);
  assert.equal(holderMain.kind, "embed");
  if (holderMain.kind === "embed") {
    assert.match(holderMain.page.fields[0]?.value ?? "", /3 commands/);
  }
});

test("prefix-invoked help shows prefix syntax only", () => {
  const result = resolveHelpTopic("fg", FULL_PREFIX);
  assert.equal(result.kind, "embed");
  if (result.kind !== "embed") return;
  assert.equal(result.page.fields[0].name, "`,fg base @role`");
  assert.doesNotMatch(fieldTextFromPage(result.page), /\/fg /);
  assert.match(result.page.description ?? "", /Personal FG roles/);

  const single = resolveHelpTopic("fg create", FULL_PREFIX);
  assert.equal(single.kind, "embed");
  if (single.kind !== "embed") return;
  const fields = single.page.fields;
  assert.match(fields[0].value, /,fg create <name> \[@member\]/);
  assert.doesNotMatch(fields[0].value, /\/fg create/);
  assert.match(fields[2].value, /,fg create My Role @Alex/);
  assert.doesNotMatch(fieldTextFromPage(single.page), /Who:/);

  const main = resolveHelpTopic(null, FULL_PREFIX);
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
    assert.equal(fg.page.fields.length, 0);
    assert.equal(fg.page.description, NO_FG_ROLE_NOTE);
  }
});

test("single-word help topics resolve for fg add, fg list, fg drop, and fg members", () => {
  // /help add and /help list used to fall through to "No help for ..."
  // because FG_SINGLE_WORDS had no entries for them.
  for (const topic of ["add", "list", "drop", "members"]) {
    const result = resolveHelpTopic(topic);
    assert.equal(result.kind, "embed", topic);
    if (result.kind !== "embed") continue;
    assert.match(result.page.title, new RegExp(`fg ${topic}`, "i"));
  }
  for (const topic of ["fg add", "fg list", "fg drop", "fg members"]) {
    const result = resolveHelpTopic(topic);
    assert.equal(result.kind, "embed", topic);
  }
});

test("isHelpPrivileged: owner, staff admin, and whitelisted pass; Discord Administrator and normal fail", () => {
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
      {
        id: "222222222222222222",
        permissions: { has: () => false },
        roles: {
          cache: {
            some: (predicate: (role: { id: string }) => boolean) =>
              predicate({ id: ADMIN_ROLE_IDS[0] }),
          },
        },
      },
      "999999999999999999",
      empty,
    ),
    true,
    "staff admin",
  );
  assert.equal(
    isHelpPrivileged(
      { id: "222222222222222222", permissions: { has: () => true }, roles: { cache: { some: () => false } } },
      "999999999999999999",
      empty,
    ),
    false,
    "Discord Administrator alone",
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
  assert.equal(normalTopic.replies[0].embeds?.length, 1);
  assert.equal(embedText(normalTopic.replies[0]), CANNOT_USE_COMMAND_ERROR);
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
  assert.equal(page?.title, "Help - FG (2/3)");
  assert.equal(owner.calls[0]?.kind, "update");
  const update = owner.calls[0]?.data as { embeds?: EmbedBuilder[] };
  assert.equal(update.embeds?.[0].toJSON().title, "Help - FG (2/3)");

  const stranger = createButton(
    "wild-help:111111111111111111:category:fg:2",
    "222222222222222222",
  );
  const rejected = await handleHelpButton(stranger.button);
  assert.equal(rejected, null);
  assert.equal(stranger.calls[0]?.kind, "reply");
  const reply = stranger.calls[0]?.data as Reply;
  assert.equal(reply.ephemeral, true);
  assert.match(embedText(reply), /isn't yours/);
});

test("help buttons: a normal user pressing a Guard button is rejected", async () => {
  const { button, calls } = createButton(
    "wild-help:111111111111111111:category:guard:1",
    "111111111111111111",
  );
  const page = await handleHelpButton(button, { caps: deriveCaps({}), mode: "slash" });
  assert.equal(page, null);
  assert.equal(calls[0]?.kind, "reply");
  const reply = calls[0]?.data as Reply;
  assert.equal(reply.ephemeral, true);
  assert.equal(embedText(reply as Reply), CANNOT_USE_COMMAND_ERROR);
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
  assert.equal(page?.title, "Help - FG (2/3)");
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

// Admin help is the server owner or a holder of one of the six staff
// admin roles. The Discord Administrator permission alone grants
// nothing — including through the Manage Server bit, which discord.js
// would otherwise imply from Administrator.

function helpMember(roleIds: string[]): unknown {
  return {
    id: "222222222222222222",
    roles: {
      cache: {
        has: (roleId: string) => roleIds.includes(roleId),
        some: (predicate: (role: { id: string }) => boolean) =>
          roleIds.some((roleId) => predicate({ id: roleId })),
      },
    },
  };
}

test("computeHelpCapabilities: each of the six staff admin roles grants admin help", () => {
  for (const roleId of ADMIN_ROLE_IDS) {
    const caps = computeHelpCapabilities(
      helpMember([roleId]),
      new PermissionsBitField(),
      "999999999999999999",
      null,
    );
    assert.equal(caps.admin, true, `role ${roleId} should grant admin`);
    assert.equal(caps.privileged, true);
  }
});

test("computeHelpCapabilities: the Discord Administrator permission alone grants no admin help", () => {
  const caps = computeHelpCapabilities(
    helpMember([]),
    new PermissionsBitField(PermissionFlagsBits.Administrator),
    "999999999999999999",
    null,
  );
  assert.equal(caps.admin, false);
  assert.equal(caps.privileged, false);
  // And the Administrator bit must not leak into Manage Server either.
  assert.equal(caps.manageServer, false);
});

test("computeHelpCapabilities: the server owner is an admin, and real Manage Server still counts", () => {
  const ownerCaps = computeHelpCapabilities(
    { id: "999999999999999999", roles: { cache: { has: () => false, some: () => false } } },
    new PermissionsBitField(),
    "999999999999999999",
    null,
  );
  assert.equal(ownerCaps.admin, true);
  assert.equal(ownerCaps.privileged, true);

  const managerCaps = computeHelpCapabilities(
    helpMember([]),
    new PermissionsBitField(PermissionFlagsBits.ManageGuild),
    "999999999999999999",
    null,
  );
  assert.equal(managerCaps.admin, false);
  assert.equal(managerCaps.manageServer, true);
});
