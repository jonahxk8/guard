import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { ConfigStore } from "./config-store.js";

const GUILD_ID = "111111111111111111";

test("defaults enforcement to active and persists pause and resume", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "wild-config-test-"));
  const configPath = path.join(directory, "wild-config.json");
  const previousConfigPath = process.env.WILD_CONFIG_PATH;
  process.env.WILD_CONFIG_PATH = configPath;

  try {
    const initialStore = new ConfigStore();
    await initialStore.load();
    assert.equal(initialStore.get(GUILD_ID).enforcementEnabled, true);

    await initialStore.set(GUILD_ID, {
      ...initialStore.get(GUILD_ID),
      allowedRoleIds: ["222222222222222222"],
      fgStaffUserIds: ["333333333333333333"],
      fgStaffRoleIds: ["444444444444444444"],
      fgRoles: {
        "555555555555555555": {
          assignUserIds: ["666666666666666666"],
          assignRoleIds: ["777777777777777777"],
          shareUserIds: ["888888888888888888"],
          shareRoleIds: ["999999999999999999"],
        },
      },
      enforcementEnabled: false,
    });

    const pausedStore = new ConfigStore();
    await pausedStore.load();
    assert.equal(pausedStore.get(GUILD_ID).enforcementEnabled, false);
    assert.deepEqual(pausedStore.get(GUILD_ID).allowedRoleIds, ["222222222222222222"]);
    assert.deepEqual(pausedStore.get(GUILD_ID).fgStaffUserIds, ["333333333333333333"]);
    assert.deepEqual(pausedStore.get(GUILD_ID).fgStaffRoleIds, ["444444444444444444"]);
    assert.deepEqual(pausedStore.get(GUILD_ID).fgRoles["555555555555555555"], {
      assignUserIds: ["666666666666666666"],
      assignRoleIds: ["777777777777777777"],
      shareUserIds: ["888888888888888888"],
      shareRoleIds: ["999999999999999999"],
    });
    assert.equal(
      JSON.parse(await readFile(configPath, "utf8")).guilds[GUILD_ID]
        .enforcementEnabled,
      false,
    );

    await pausedStore.set(GUILD_ID, {
      ...pausedStore.get(GUILD_ID),
      enforcementEnabled: true,
    });

    const resumedStore = new ConfigStore();
    await resumedStore.load();
    assert.equal(resumedStore.get(GUILD_ID).enforcementEnabled, true);
  } finally {
    if (previousConfigPath === undefined) {
      delete process.env.WILD_CONFIG_PATH;
    } else {
      process.env.WILD_CONFIG_PATH = previousConfigPath;
    }
    await rm(directory, { recursive: true, force: true });
  }
});

test("treats saved settings without enforcement state as active", async () => {
  const directory = await mkdtemp(
    path.join(os.tmpdir(), "wild-config-legacy-test-"),
  );
  const configPath = path.join(directory, "wild-config.json");
  const previousConfigPath = process.env.WILD_CONFIG_PATH;
  process.env.WILD_CONFIG_PATH = configPath;

  try {
    await writeFile(
      configPath,
      JSON.stringify({
        version: 1,
        guilds: {
          [GUILD_ID]: {
            protectedRoleIds: [],
            allowedUserIds: [],
            logChannelId: null,
          },
        },
      }),
    );

    const store = new ConfigStore();
    await store.load();
    assert.equal(store.get(GUILD_ID).enforcementEnabled, true);
    assert.deepEqual(store.get(GUILD_ID).allowedRoleIds, []);
    assert.deepEqual(store.get(GUILD_ID).fgRoles, {});
  } finally {
    if (previousConfigPath === undefined) {
      delete process.env.WILD_CONFIG_PATH;
    } else {
      process.env.WILD_CONFIG_PATH = previousConfigPath;
    }
    await rm(directory, { recursive: true, force: true });
  }
});

test("persists FG base, sharers, and owner settings", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "wild-config-fg-test-"));
  const configPath = path.join(directory, "wild-config.json");
  const previousConfigPath = process.env.WILD_CONFIG_PATH;
  process.env.WILD_CONFIG_PATH = configPath;

  try {
    const store = new ConfigStore();
    await store.load();
    await store.set(GUILD_ID, {
      ...store.get(GUILD_ID),
      fgBaseRoleId: "222222222222222222",
      fgRoleOwners: { "444444444444444444": "555555555555555555" },
      fgRoleSharers: { "444444444444444444": ["666666666666666666"] },
    });

    const reloaded = new ConfigStore();
    await reloaded.load();
    assert.equal(reloaded.get(GUILD_ID).fgBaseRoleId, "222222222222222222");
    assert.deepEqual(reloaded.get(GUILD_ID).fgRoleOwners, {
      "444444444444444444": "555555555555555555",
    });
    assert.deepEqual(reloaded.get(GUILD_ID).fgRoleSharers, {
      "444444444444444444": ["666666666666666666"],
    });

    // Old configs without the FG fields load as null / empty.
    const legacy = new ConfigStore();
    await writeFile(
      configPath,
      JSON.stringify({
        version: 1,
        guilds: { [GUILD_ID]: { protectedRoleIds: [], allowedUserIds: [], logChannelId: null } },
      }),
    );
    await legacy.load();
    assert.equal(legacy.get(GUILD_ID).fgBaseRoleId, null);
    assert.deepEqual(legacy.get(GUILD_ID).fgRoleOwners, {});
    assert.deepEqual(legacy.get(GUILD_ID).fgRoleSharers, {});

    // Old configs that still store fgAwardRoleId load without error,
    // and the award role is never granted or written back.
    await writeFile(
      configPath,
      JSON.stringify({
        version: 1,
        guilds: {
          [GUILD_ID]: {
            protectedRoleIds: [],
            allowedUserIds: [],
            logChannelId: null,
            fgAwardRoleId: "333333333333333333",
          },
        },
      }),
    );
    const withAward = new ConfigStore();
    await withAward.load();
    assert.equal("fgAwardRoleId" in withAward.get(GUILD_ID), false);
    assert.deepEqual(withAward.get(GUILD_ID).fgRoleSharers, {});
  } finally {
    if (previousConfigPath === undefined) {
      delete process.env.WILD_CONFIG_PATH;
    } else {
      process.env.WILD_CONFIG_PATH = previousConfigPath;
    }
    await rm(directory, { recursive: true, force: true });
  }
});

test("creates a .bak backup of the previous settings on save", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "wild-config-bak-test-"));
  const configPath = path.join(directory, "wild-config.json");
  const previousConfigPath = process.env.WILD_CONFIG_PATH;
  process.env.WILD_CONFIG_PATH = configPath;

  try {
    const store = new ConfigStore();
    await store.load();

    await store.set(GUILD_ID, {
      ...store.get(GUILD_ID),
      enforcementEnabled: false,
    });
    // No previous file existed, so no backup yet.
    await assert.rejects(readFile(`${configPath}.bak`, "utf8"));

    await store.set(GUILD_ID, {
      ...store.get(GUILD_ID),
      enforcementEnabled: true,
    });
    const backup = JSON.parse(await readFile(`${configPath}.bak`, "utf8"));
    assert.equal(backup.guilds[GUILD_ID].enforcementEnabled, false);
    const current = JSON.parse(await readFile(configPath, "utf8"));
    assert.equal(current.guilds[GUILD_ID].enforcementEnabled, true);
  } finally {
    if (previousConfigPath === undefined) {
      delete process.env.WILD_CONFIG_PATH;
    } else {
      process.env.WILD_CONFIG_PATH = previousConfigPath;
    }
    await rm(directory, { recursive: true, force: true });
  }
});

test("persists the blacklist and loads legacy configs without one", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "wild-config-blacklist-test-"));
  const configPath = path.join(directory, "wild-config.json");
  const previousConfigPath = process.env.WILD_CONFIG_PATH;
  process.env.WILD_CONFIG_PATH = configPath;

  try {
    const store = new ConfigStore();
    await store.load();
    assert.deepEqual(store.get(GUILD_ID).blacklist, {});

    await store.set(GUILD_ID, {
      ...store.get(GUILD_ID),
      blacklist: {
        "222222222222222222": ["333333333333333333", "444444444444444444"],
        "555555555555555555": ["333333333333333333"],
      },
    });

    const reloaded = new ConfigStore();
    await reloaded.load();
    assert.deepEqual(reloaded.get(GUILD_ID).blacklist, {
      "222222222222222222": ["333333333333333333", "444444444444444444"],
      "555555555555555555": ["333333333333333333"],
    });

    // Old configs without the blacklist field load as empty.
    await writeFile(
      configPath,
      JSON.stringify({
        version: 1,
        guilds: { [GUILD_ID]: { protectedRoleIds: [], allowedUserIds: [], logChannelId: null } },
      }),
    );
    const legacy = new ConfigStore();
    await legacy.load();
    assert.deepEqual(legacy.get(GUILD_ID).blacklist, {});

    // Lenient: an array of { userId, roleId } pairs is accepted too.
    await writeFile(
      configPath,
      JSON.stringify({
        version: 1,
        guilds: {
          [GUILD_ID]: {
            protectedRoleIds: [],
            allowedUserIds: [],
            logChannelId: null,
            blacklist: [
              { userId: "222222222222222222", roleId: "333333333333333333" },
            ],
          },
        },
      }),
    );
    const pairs = new ConfigStore();
    await pairs.load();
    assert.deepEqual(pairs.get(GUILD_ID).blacklist, {
      "222222222222222222": ["333333333333333333"],
    });
  } finally {
    if (previousConfigPath === undefined) {
      delete process.env.WILD_CONFIG_PATH;
    } else {
      process.env.WILD_CONFIG_PATH = previousConfigPath;
    }
    await rm(directory, { recursive: true, force: true });
  }
});
