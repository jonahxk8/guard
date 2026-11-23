import assert from "node:assert/strict";
import test from "node:test";
import {
  blacklistCommand,
  protectCommand,
  setupCommand,
  statusCommand,
  whitelistCommand,
} from "./commands.js";
import { fgCommand } from "./fg-booster.js";
import { helpCommand } from "./help.js";

/**
 * The exact slash command set Wild registers on startup with a full
 * bulk overwrite (application.commands.set). This is the contract the
 * live bot shows in Discord: stale commands from older versions
 * (/logs, /wild, /roles, /watch, /enforcement, /commands, /fg staff,
 * /fg access, /fg award) must be gone, and every current command must
 * be present with its correct options. If this test fails, the bot
 * will show the wrong commands in Discord after redeploy.
 */

const STALE_NAMES = [
  "logs",
  "wild",
  "roles",
  "watch",
  "enforcement",
  "commands",
  "staff",
  "access",
  "award",
  "assign",
];

type CommandJsonOption = {
  name?: unknown;
  options?: CommandJsonOption[];
};

type CommandJson = {
  name?: unknown;
  options?: CommandJsonOption[];
};

function commandJson(command: { toJSON: () => unknown }): CommandJson {
  return command.toJSON() as CommandJson;
}

function subcommandNames(command: { toJSON: () => unknown }): string[] {
  const json = commandJson(command);
  return (json.options ?? []).map((option) => String(option.name));
}

function subcommandGroupNames(
  command: { toJSON: () => unknown },
  group: string,
): string[] {
  const json = commandJson(command);
  const found = (json.options ?? []).find(
    (option) => option.name === group,
  );
  if (!found) return [];
  return (found.options ?? []).map((option) => String(option.name));
}

function optionNames(
  command: { toJSON: () => unknown },
  subcommand: string,
): string[] {
  const json = commandJson(command);
  const found = (json.options ?? []).find(
    (option) => option.name === subcommand,
  );
  if (!found) return [];
  return (found.options ?? []).map((option) => String(option.name));
}

function groupOptionNames(
  command: { toJSON: () => unknown },
  group: string,
  subcommand: string,
): string[] {
  const json = commandJson(command);
  const foundGroup = (json.options ?? []).find(
    (option) => option.name === group,
  );
  const found = (foundGroup?.options ?? []).find(
    (option) => option.name === subcommand,
  );
  if (!found) return [];
  return (found.options ?? []).map((option) => String(option.name));
}

test("slash registration is exactly the current command set", () => {
  const commands = [
    protectCommand,
    whitelistCommand,
    statusCommand,
    setupCommand,
    fgCommand,
    blacklistCommand,
    helpCommand,
  ];
  const names = commands.map((command) => command.name);
  assert.deepEqual(
    [...names].sort(),
    [
      "blacklist",
      "fg",
      "help",
      "protect",
      "setup",
      "status",
      "whitelist",
    ],
  );
  for (const name of names) {
    assert.ok(!STALE_NAMES.includes(name), `${name} is a stale command name`);
  }
});

test("slash registration has no stale subcommands", () => {
  assert.deepEqual(subcommandNames(fgCommand).sort(), [
    "add",
    "auth",
    "base",
    "cleanup",
    "color",
    "create",
    "drop",
    "icon",
    "list",
    "members",
    "remove",
    "rename",
    "share",
  ]);
  assert.deepEqual(subcommandGroupNames(fgCommand, "auth"), [
    "add",
    "remove",
    "list",
  ]);
  assert.deepEqual(subcommandNames(blacklistCommand), [
    "add",
    "remove",
    "list",
  ]);
  const allSubcommands = [
    ...subcommandNames(fgCommand),
    ...subcommandGroupNames(fgCommand, "auth"),
    ...subcommandNames(blacklistCommand),
  ];
  for (const name of allSubcommands) {
    assert.ok(!STALE_NAMES.includes(name), `${name} is a stale subcommand`);
  }
});

test("slash registration has the expected options", () => {
  // /protect takes a single role option at the top level, not a subcommand.
  const protect = commandJson(protectCommand);
  assert.deepEqual(
    (protect.options ?? []).map((option) => String(option.name)),
    ["role"],
  );

  const help = commandJson(helpCommand);
  assert.deepEqual(
    (help.options ?? []).map((option) => String(option.name)),
    ["topic"],
  );

  // /fg color recolors only: color + optional second_color, no name.
  assert.deepEqual(optionNames(fgCommand, "color"), [
    "color",
    "second_color",
  ]);
  // /fg create is name + optional member only: the color comes from
  // the member's profile picture, so there are no color options.
  assert.deepEqual(optionNames(fgCommand, "create"), ["name", "member"]);
  // /fg add takes an existing role + a REQUIRED member: the role
  // belongs to whoever is named, never to the caller by default.
  assert.deepEqual(optionNames(fgCommand, "add"), ["role", "member"]);
  const addJson = commandJson(fgCommand).options?.find(
    (option) => option.name === "add",
  );
  const addMember = addJson?.options?.find((option) => option.name === "member");
  assert.equal(
    (addMember as { required?: boolean } | undefined)?.required,
    true,
    "/fg add member must be required",
  );
  // /fg share takes only @member: the bot works out which FG role
  // from the caller. /fg assign is gone entirely.
  assert.deepEqual(optionNames(fgCommand, "share"), ["member"]);
  assert.ok(!subcommandNames(fgCommand).includes("assign"));
  // /fg drop and /fg members take no arguments.
  assert.deepEqual(optionNames(fgCommand, "drop"), []);
  assert.deepEqual(optionNames(fgCommand, "members"), []);
  // /fg auth add/remove take only @member: the bot works out which FG
  // role from the caller, like /fg share. /fg auth list takes an
  // optional @role and auto-detects when it is omitted.
  assert.deepEqual(groupOptionNames(fgCommand, "auth", "add"), ["member"]);
  assert.deepEqual(groupOptionNames(fgCommand, "auth", "remove"), ["member"]);
  assert.deepEqual(groupOptionNames(fgCommand, "auth", "list"), ["role"]);
});
