import assert from "node:assert/strict";
import test from "node:test";
import {
  ChannelType,
  Collection,
  PermissionFlagsBits,
  PermissionsBitField,
} from "discord.js";
import { ConfigStore, GuildSettings } from "./config-store.js";
import { handlePrefixMessage } from "./prefix.js";

// Reproduction harness for the ,fg share generic-error bug (reported
// 2026-11-23 08:58 and 10:27). Drives the REAL prefix adapter with the
// caller as server OWNER holding an FG role, using real discord.js
// classes wherever one can be built without a client:
//  - real Collection for roles.cache / members cache / roles.cache
//  - real PermissionsBitField for member + bot permissions; the owner
//    gets exactly what discord.js gives them (GuildMember.permissions
//    returns PermissionsBitField.All, frozen, for the guild owner)
//  - role objects with a faithful comparePositionTo
// The old prefix.test.ts doubles use plain objects and literal-bit
// permission stubs, which hid real-behaviour differences before.

const GUILD_ID = "111111111111111111";
const OWNER_ID = "999999999999999999";
const USER_ID = "222222222222222222";
const OTHER_ID = "333333333333333333";
const FG_ROLE_ID = "666666666666666666";
const FG_ROLE_2_ID = "666666666666666667";
const FG_ROLE_3_ID = "666666666666666668";
const BOT_ROLE_ID = "777777777777777777";
const CHANNEL_ID = "555555555555555555";

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

function createStore(initialSettings: GuildSettings = makeSettings()) {
  let settings = initialSettings;
  const store = {
    get: () => JSON.parse(JSON.stringify(settings)) as GuildSettings,
    set: async (_guildId: string, nextSettings: GuildSettings) => {
      settings = JSON.parse(JSON.stringify(nextSettings)) as GuildSettings;
    },
  } as unknown as ConfigStore;
  return { store, getSettings: () => settings };
}

interface RoleDouble {
  id: string;
  name: string;
  position: number;
  managed: boolean;
  permissions: PermissionsBitField;
  comparePositionTo: (other: { position: number }) => number;
}

function makeRole(id: string, position: number): RoleDouble {
  return {
    id,
    name: `Role-${id.slice(-4)}`,
    position,
    managed: false,
    permissions: new PermissionsBitField(),
    comparePositionTo(other: { position: number }) {
      return this.position - other.position;
    },
  };
}

interface MemberDouble {
  id: string;
  user: { id: string; username: string };
  permissions: PermissionsBitField;
  roles: {
    cache: Collection<string, RoleDouble>;
    highest: RoleDouble;
    add: (role: RoleDouble) => Promise<void>;
    remove: (role: RoleDouble) => Promise<void>;
  };
  send: (options: Record<string, unknown>) => Promise<void>;
}

function makeMember(
  id: string,
  heldRoles: Collection<string, RoleDouble>,
  permissions: PermissionsBitField,
  dms: Array<{ to: string; options: Record<string, unknown> }>,
): MemberDouble {
  const sorted = [...heldRoles.values()].sort((a, b) => b.position - a.position);
  const highest =
    sorted[0] ??
    makeRole(GUILD_ID, 0); // @everyone fallback
  return {
    id,
    user: { id, username: id === OWNER_ID ? "Owner" : "Member" },
    permissions,
    roles: {
      cache: heldRoles,
      highest,
      add: async (role: RoleDouble) => {
        heldRoles.set(role.id, role);
      },
      remove: async (role: RoleDouble) => {
        heldRoles.delete(role.id);
      },
    },
    send: async (options: Record<string, unknown>) => {
      dms.push({ to: id, options });
    },
  };
}

interface Harness {
  message: Record<string, unknown>;
  sent: Array<Record<string, unknown>>;
  dms: Array<{ to: string; options: Record<string, unknown> }>;
  collectors: Array<{
    on: (event: string, fn: (...args: unknown[]) => unknown) => void;
    stop: (reason?: string) => void;
    fireCollect: (button: unknown) => Promise<void>;
    fireEnd: (reason: string) => Promise<void>;
  }>;
  loggedErrors: string[];
  restoreConsole: () => void;
}

function createHarness(options: {
  content: string;
  authorId: string;
  /** FG roles that exist, by id. The owner holds the ones listed in ownerRoleIds. */
  fgRoleIds?: string[];
  ownerRoleIds?: string[];
  targetRoleIds?: string[];
  botAboveRole?: boolean;
  botCanManageRoles?: boolean;
  /** The offer send (the message with buttons) rejects, like a Discord API failure. */
  failOfferSend?: boolean;
  settings: GuildSettings;
}): Harness {
  const fgRoleIds = options.fgRoleIds ?? [FG_ROLE_ID];
  const rolesCache = new Collection<string, RoleDouble>();
  for (const roleId of fgRoleIds) {
    rolesCache.set(roleId, makeRole(roleId, 10));
  }
  const botRole = makeRole(BOT_ROLE_ID, options.botAboveRole === false ? 5 : 20);
  rolesCache.set(BOT_ROLE_ID, botRole);

  const sent: Array<Record<string, unknown>> = [];
  const dms: Array<{ to: string; options: Record<string, unknown> }> = [];
  const collectors: Harness["collectors"] = [];

  const ownerRoles = new Collection<string, RoleDouble>();
  for (const roleId of options.ownerRoleIds ?? [FG_ROLE_ID]) {
    const role = rolesCache.get(roleId);
    if (role) ownerRoles.set(roleId, role);
  }
  // discord.js: GuildMember.permissions returns PermissionsBitField.All
  // (frozen) for the guild owner.
  const owner = makeMember(
    OWNER_ID,
    ownerRoles,
    new PermissionsBitField(PermissionsBitField.All).freeze(),
    dms,
  );
  const userRoles = new Collection<string, RoleDouble>();
  const user = makeMember(USER_ID, userRoles, new PermissionsBitField(), dms);
  const targetRoles = new Collection<string, RoleDouble>();
  for (const roleId of options.targetRoleIds ?? []) {
    const role = rolesCache.get(roleId);
    if (role) targetRoles.set(roleId, role);
  }
  const target = makeMember(OTHER_ID, targetRoles, new PermissionsBitField(), dms);

  const botPermissions = new PermissionsBitField(
    options.botCanManageRoles === false ? [] : [PermissionFlagsBits.ManageRoles],
  );
  const botRoles = new Collection<string, RoleDouble>([[BOT_ROLE_ID, botRole]]);
  const botMember = makeMember(BOT_ROLE_ID, botRoles, botPermissions, dms);
  // The bot's own member id is the client user id; keep it distinct.
  (botMember as unknown as Record<string, unknown>).id = "888888888888888888";

  const members = new Collection<string, MemberDouble>([
    [OWNER_ID, owner],
    [USER_ID, user],
    [OTHER_ID, target],
  ]);

  const channel = {
    id: CHANNEL_ID,
    type: ChannelType.GuildText,
    send: async (messageOptions: Record<string, unknown>) => {
      // The offer is the only send with buttons; fail exactly that one
      // to model a Discord API failure on the offer send. The specific
      // error reply that follows has no buttons and goes through.
      if (options.failOfferSend && messageOptions.components !== undefined) {
        throw new Error("DiscordAPIError[50013]: Missing Permissions");
      }
      const handlers: Record<string, Array<(...args: unknown[]) => unknown>> = {};
      const collector = {
        on: (event: string, fn: (...args: unknown[]) => unknown) => {
          (handlers[event] ??= []).push(fn);
        },
        stop: (_reason?: string) => {},
        fireCollect: async (button: unknown) => {
          for (const fn of handlers.collect ?? []) await fn(button);
        },
        fireEnd: async (reason: string) => {
          for (const fn of handlers.end ?? []) await fn(undefined, reason);
        },
      };
      collectors.push(collector);
      const sentMessage: Record<string, unknown> = {
        content: messageOptions.content,
        embeds: messageOptions.embeds,
        components: messageOptions.components,
        deleted: false,
        delete: async () => {
          sentMessage.deleted = true;
        },
        edit: async () => sentMessage,
        createMessageComponentCollector: () => collector,
      };
      sent.push(sentMessage);
      return sentMessage;
    },
  };

  const guild = {
    id: GUILD_ID,
    ownerId: OWNER_ID,
    members: {
      me: botMember,
      fetch: async (arg?: string | { user?: string }) => {
        if (arg === undefined) return members;
        const id = typeof arg === "string" ? arg : (arg.user ?? "");
        const found = members.get(id);
        if (!found) throw new Error("Unknown Member");
        return found;
      },
      fetchMe: async () => botMember,
    },
    roles: { cache: rolesCache },
    channels: { cache: new Collection([[CHANNEL_ID, channel]]) },
  };

  const authorMember =
    options.authorId === OWNER_ID
      ? owner
      : options.authorId === OTHER_ID
        ? target
        : user;

  const message = {
    content: options.content,
    author: { id: options.authorId, username: "Alex", bot: false },
    guild,
    member: authorMember,
    channel,
    delete: async () => {},
  };

  // Capture what the prefix catch logs, so a reproduction names the throw.
  const loggedErrors: string[] = [];
  const originalError = console.error;
  console.error = (...args: unknown[]) => {
    loggedErrors.push(args.map((a) => String(a)).join(" "));
  };

  return {
    message,
    sent,
    dms,
    collectors,
    loggedErrors,
    restoreConsole: () => {
      console.error = originalError;
    },
  };
}

function sentText(sent: Array<Record<string, unknown>>): string {
  return sent
    .map((m) => {
      const embeds = m.embeds as Array<{ toJSON: () => { description?: string } }> | undefined;
      return embeds?.[0]?.toJSON().description ?? (m.content as string) ?? "";
    })
    .join("\n");
}

function assertNoGenericError(harness: Harness): void {
  assert.equal(
    /couldn't complete that command/i.test(sentText(harness.sent)),
    false,
    `generic error reply was sent; logged: ${harness.loggedErrors.join(" | ")}`,
  );
  assert.equal(harness.loggedErrors.length, 0, harness.loggedErrors.join("\n"));
}

function fgAccess() {
  return { assignUserIds: [], assignRoleIds: [], shareUserIds: [], shareRoleIds: [] };
}

test("repro: owner shares their own FG role via ,fg share (real Collection + real PermissionsBitField)", async () => {
  const { store } = createStore(
    makeSettings({
      fgRoleOwners: { [FG_ROLE_ID]: OWNER_ID },
      fgRoles: { [FG_ROLE_ID]: fgAccess() },
    }),
  );
  const harness = createHarness({
    content: `,fg share <@${OTHER_ID}>`,
    authorId: OWNER_ID,
    settings: makeSettings(),
  });
  try {
    assert.equal(await handlePrefixMessage(harness.message as never, store), true);
    assertNoGenericError(harness);
    assert.equal(harness.sent.length, 1);
    const embed = (
      harness.sent[0].embeds as Array<{ toJSON: () => { title?: string } }>
    )[0].toJSON();
    assert.equal(embed.title, "fg share");
    assert.equal(harness.collectors.length, 1);
  } finally {
    harness.restoreConsole();
  }
});

test("repro: owner with no FG role shares the one FG role that exists", async () => {
  const { store } = createStore(
    makeSettings({
      fgRoleOwners: { [FG_ROLE_ID]: USER_ID },
      fgRoles: { [FG_ROLE_ID]: fgAccess() },
    }),
  );
  const harness = createHarness({
    content: `,fg share <@${OTHER_ID}>`,
    authorId: OWNER_ID,
    ownerRoleIds: [],
    settings: makeSettings(),
  });
  try {
    assert.equal(await handlePrefixMessage(harness.message as never, store), true);
    assertNoGenericError(harness);
    assert.equal(harness.sent.length, 1);
  } finally {
    harness.restoreConsole();
  }
});

test("repro: owner with no FG role and several FG roles gets the specific error, not the generic one", async () => {
  const { store } = createStore(
    makeSettings({
      fgRoleOwners: { [FG_ROLE_ID]: USER_ID, [FG_ROLE_2_ID]: USER_ID },
      fgRoles: { [FG_ROLE_ID]: fgAccess(), [FG_ROLE_2_ID]: fgAccess() },
    }),
  );
  const harness = createHarness({
    content: `,fg share <@${OTHER_ID}>`,
    authorId: OWNER_ID,
    fgRoleIds: [FG_ROLE_ID, FG_ROLE_2_ID],
    ownerRoleIds: [],
    settings: makeSettings(),
  });
  try {
    assert.equal(await handlePrefixMessage(harness.message as never, store), true);
    assertNoGenericError(harness);
    assert.match(sentText(harness.sent), /more than one FG role/i);
  } finally {
    harness.restoreConsole();
  }
});

test("repro: owner with no FG role and zero FG roles gets the specific error, not the generic one", async () => {
  const { store } = createStore(makeSettings());
  const harness = createHarness({
    content: `,fg share <@${OTHER_ID}>`,
    authorId: OWNER_ID,
    fgRoleIds: [],
    ownerRoleIds: [],
    settings: makeSettings(),
  });
  try {
    assert.equal(await handlePrefixMessage(harness.message as never, store), true);
    assertNoGenericError(harness);
    assert.match(sentText(harness.sent), /aren't authorised to share/i);
  } finally {
    harness.restoreConsole();
  }
});

test("repro: target already holds an FG role gets the specific error", async () => {
  const { store } = createStore(
    makeSettings({
      fgRoleOwners: { [FG_ROLE_ID]: OWNER_ID },
      fgRoles: { [FG_ROLE_ID]: fgAccess() },
    }),
  );
  const harness = createHarness({
    content: `,fg share <@${OTHER_ID}>`,
    authorId: OWNER_ID,
    targetRoleIds: [FG_ROLE_ID],
    settings: makeSettings(),
  });
  try {
    assert.equal(await handlePrefixMessage(harness.message as never, store), true);
    assertNoGenericError(harness);
    assert.match(sentText(harness.sent), /already have an FG role/i);
  } finally {
    harness.restoreConsole();
  }
});

test("repro: bot role below the FG role gets the specific error", async () => {
  const { store } = createStore(
    makeSettings({
      fgRoleOwners: { [FG_ROLE_ID]: OWNER_ID },
      fgRoles: { [FG_ROLE_ID]: fgAccess() },
    }),
  );
  const harness = createHarness({
    content: `,fg share <@${OTHER_ID}>`,
    authorId: OWNER_ID,
    botAboveRole: false,
    settings: makeSettings(),
  });
  try {
    assert.equal(await handlePrefixMessage(harness.message as never, store), true);
    assertNoGenericError(harness);
    assert.match(sentText(harness.sent), /can't manage that FG role/i);
  } finally {
    harness.restoreConsole();
  }
});

test("repro: bot without Manage Roles gets the specific error", async () => {
  const { store } = createStore(
    makeSettings({
      fgRoleOwners: { [FG_ROLE_ID]: OWNER_ID },
      fgRoles: { [FG_ROLE_ID]: fgAccess() },
    }),
  );
  const harness = createHarness({
    content: `,fg share <@${OTHER_ID}>`,
    authorId: OWNER_ID,
    botCanManageRoles: false,
    settings: makeSettings(),
  });
  try {
    assert.equal(await handlePrefixMessage(harness.message as never, store), true);
    assertNoGenericError(harness);
    assert.match(sentText(harness.sent), /can't manage that FG role/i);
  } finally {
    harness.restoreConsole();
  }
});

test("regression: offer send fails → specific reply naming the step, no generic message, step logged", async () => {
  // This is the failure the user hit twice (2026-11-23 08:58 and 10:27):
  // the offer's channel.send is the one Discord API call in the share
  // path with no specific reply of its own, so it used to surface as
  // the generic "couldn't complete that command" reply — and the prefix
  // catch swallowed the error without logging it. Now the step is named
  // in the reply and in the Railway logs.
  const { store } = createStore(
    makeSettings({
      fgRoleOwners: { [FG_ROLE_ID]: OWNER_ID },
      fgRoles: { [FG_ROLE_ID]: fgAccess() },
    }),
  );
  const harness = createHarness({
    content: `,fg share <@${OTHER_ID}>`,
    authorId: OWNER_ID,
    failOfferSend: true,
    settings: makeSettings(),
  });
  try {
    assert.equal(await handlePrefixMessage(harness.message as never, store), true);
    assert.equal(
      /couldn't complete that command/i.test(sentText(harness.sent)),
      false,
      `generic error reply was sent; sent: ${sentText(harness.sent)}`,
    );
    assert.match(
      sentText(harness.sent),
      /Couldn't send the FG role offer\. Check the bot can send messages in this channel and try again\./,
    );
    // The offer never went out (its send threw before recording), and
    // the only message sent is the specific error reply — with no
    // buttons on it.
    assert.equal(harness.sent.length, 1);
    assert.equal(harness.sent[0].components, undefined);
    assert.match(
      harness.loggedErrors.join("\n"),
      /\[wild\] fg share: could not send the offer:/,
    );
    assert.match(harness.loggedErrors.join("\n"), /DiscordAPIError\[50013\]/);
  } finally {
    harness.restoreConsole();
  }
});

test("regression: the prefix catch logs the underlying error instead of swallowing it", async () => {
  // A throw anywhere in a prefix handler used to vanish: the catch sent
  // the generic reply and logged nothing, so the ,fg share failures
  // stayed undiagnosed. Now the error and its stack reach the logs.
  const throwingStore = {
    get: (): GuildSettings => {
      throw new Error("settings boom");
    },
    set: async () => {},
  } as unknown as ConfigStore;
  const harness = createHarness({
    content: `,fg share <@${OTHER_ID}>`,
    authorId: OWNER_ID,
    settings: makeSettings(),
  });
  try {
    assert.equal(
      await handlePrefixMessage(harness.message as never, throwingStore),
      true,
    );
    // Last-resort path: the step is unknown, so the generic reply is
    // correct here — but the cause must be in the logs.
    assert.match(sentText(harness.sent), /couldn't complete that command/i);
    assert.match(
      harness.loggedErrors.join("\n"),
      /\[wild\] prefix command failed:/,
    );
    assert.match(harness.loggedErrors.join("\n"), /settings boom/);
  } finally {
    harness.restoreConsole();
  }
});
