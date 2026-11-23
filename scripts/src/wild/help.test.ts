import assert from "node:assert/strict";
import test from "node:test";
import { ChatInputCommandInteraction, EmbedBuilder } from "discord.js";
import { handleHelpCommand, resolveHelpTopic } from "./help.js";

interface Reply {
  content?: string;
  embeds?: EmbedBuilder[];
  ephemeral?: boolean;
}

function createInteraction(topic?: string | null) {
  const replies: Reply[] = [];
  const interaction = {
    commandName: "help",
    options: {
      getString: (_name: string) => topic ?? null,
    },
    reply: async (reply: Reply) => {
      replies.push(reply);
    },
  } as unknown as ChatInputCommandInteraction;
  return { interaction, replies };
}

function embedText(reply: Reply): string {
  return (reply.embeds?.[0].toJSON().description as string | undefined) ?? "";
}

test("resolveHelpTopic: main page lists all three categories", () => {
  const result = resolveHelpTopic(null);
  assert.equal(result.kind, "embed");
  if (result.kind !== "embed") return;
  assert.equal(result.title, "Wild help");
  assert.match(result.description, /\*\*Guard\*\*/);
  assert.match(result.description, /\*\*FG\*\*/);
  assert.match(result.description, /\*\*Blacklist\*\*/);
  assert.match(result.description, /\/protect @role/);
  assert.match(result.description, /\/fg create/);
  assert.match(result.description, /\/blacklist add/);
  assert.doesNotMatch(result.description, /\|/);
});

test("/help fg lists only FG commands, with /fg create", async () => {
  const { interaction, replies } = createInteraction("fg");
  await handleHelpCommand(interaction);

  assert.equal(replies[0].ephemeral, true);
  assert.equal(replies[0].embeds?.[0].toJSON().color, 0);
  assert.equal(replies[0].embeds?.[0].toJSON().footer, undefined);
  assert.equal(replies[0].embeds?.[0].toJSON().timestamp, undefined);
  const text = embedText(replies[0]);
  assert.match(text, /\/fg create <name> <color>/);
  assert.match(text, /\/fg color <color> <name>/);
  assert.match(text, /\/fg share @member @role/);
  assert.doesNotMatch(text, /\/blacklist/);
  assert.doesNotMatch(text, /\/protect/);
  assert.doesNotMatch(text, /\|/);
});

test("/help guard lists only Guard commands", async () => {
  const { interaction, replies } = createInteraction("guard");
  await handleHelpCommand(interaction);

  const text = embedText(replies[0]);
  assert.match(text, /\/protect @role/);
  assert.match(text, /,guard @role/);
  assert.match(text, /\/status/);
  assert.doesNotMatch(text, /\/fg /);
  assert.doesNotMatch(text, /\/blacklist/);
});

test("/help blacklist lists only blacklist commands", async () => {
  const { interaction, replies } = createInteraction("blacklist");
  await handleHelpCommand(interaction);

  const text = embedText(replies[0]);
  assert.match(text, /\/blacklist add @user @role/);
  assert.match(text, /\/blacklist remove @user @role/);
  assert.match(text, /\/blacklist list/);
  assert.doesNotMatch(text, /\/fg /);
  assert.doesNotMatch(text, /\/protect/);
});

test("/help fg create shows the create syntax and the owner-or-whitelisted gate", async () => {
  const { interaction, replies } = createInteraction("fg create");
  await handleHelpCommand(interaction);

  const text = embedText(replies[0]);
  assert.match(text, /\/fg create <name> <color> \[second_color\] \[@member\]/);
  assert.match(text, /,fg create <name> <color>/);
  assert.match(text, /Server owner or whitelisted members/);
});

test("/help blacklist add shows one command with its syntax and gate", async () => {
  const { interaction, replies } = createInteraction("blacklist add");
  await handleHelpCommand(interaction);

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
