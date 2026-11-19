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
