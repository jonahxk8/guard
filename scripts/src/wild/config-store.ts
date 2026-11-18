import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

export interface GuildSettings {
  protectedRoleIds: string[];
  allowedUserIds: string[];
  logChannelId: string | null;
}

interface PersistedConfig {
  version: 1;
  guilds: Record<string, GuildSettings>;
}

const emptySettings = (): GuildSettings => ({
  protectedRoleIds: [],
  allowedUserIds: [],
  logChannelId: null,
});

function isSnowflake(value: unknown): value is string {
  return typeof value === "string" && /^\d{5,25}$/.test(value);
}

function parseSettings(value: unknown, guildId: string): GuildSettings {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`Wild settings for server ${guildId} are invalid.`);
  }

  const candidate = value as Record<string, unknown>;
  if (
    !Array.isArray(candidate.protectedRoleIds) ||
    !candidate.protectedRoleIds.every(isSnowflake) ||
    !Array.isArray(candidate.allowedUserIds) ||
    !candidate.allowedUserIds.every(isSnowflake) ||
    !(
      candidate.logChannelId === null ||
      isSnowflake(candidate.logChannelId)
    )
  ) {
    throw new Error(`Wild settings for server ${guildId} are invalid.`);
  }

  return {
    protectedRoleIds: [...candidate.protectedRoleIds],
    allowedUserIds: [...candidate.allowedUserIds],
    logChannelId: candidate.logChannelId,
  };
}

export class ConfigStore {
  private readonly settings = new Map<string, GuildSettings>();
  private writeQueue: Promise<void> = Promise.resolve();
  private readonly filePath = path.resolve(
    process.env.WILD_CONFIG_PATH ?? "data/wild-config.json",
  );

  async load(): Promise<void> {
    let source: string;
    try {
      source = await readFile(this.filePath, "utf8");
    } catch (error) {
      if (
        typeof error === "object" &&
        error !== null &&
        "code" in error &&
        error.code === "ENOENT"
      ) {
        return;
      }
      throw error;
    }

    const parsed: unknown = JSON.parse(source);
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      Array.isArray(parsed) ||
      !("version" in parsed) ||
      parsed.version !== 1 ||
      !("guilds" in parsed) ||
      typeof parsed.guilds !== "object" ||
      parsed.guilds === null ||
      Array.isArray(parsed.guilds)
    ) {
      throw new Error("Wild's saved settings file has an unsupported format.");
    }

    for (const [guildId, settings] of Object.entries(parsed.guilds)) {
      if (!isSnowflake(guildId)) {
        throw new Error("Wild's saved settings contain an invalid server ID.");
      }
      this.settings.set(guildId, parseSettings(settings, guildId));
    }
  }

  get(guildId: string): GuildSettings {
    const current = this.settings.get(guildId);
    return current
      ? {
          protectedRoleIds: [...current.protectedRoleIds],
          allowedUserIds: [...current.allowedUserIds],
          logChannelId: current.logChannelId,
        }
      : emptySettings();
  }

  async set(guildId: string, next: GuildSettings): Promise<void> {
    const previous = this.settings.get(guildId);
    this.settings.set(guildId, {
      protectedRoleIds: [...next.protectedRoleIds],
      allowedUserIds: [...next.allowedUserIds],
      logChannelId: next.logChannelId,
    });

    const snapshot: PersistedConfig = {
      version: 1,
      guilds: Object.fromEntries(this.settings),
    };
    const serialized = `${JSON.stringify(snapshot, null, 2)}\n`;

    this.writeQueue = this.writeQueue
      .catch(() => undefined)
      .then(async () => {
        await mkdir(path.dirname(this.filePath), { recursive: true });
        const temporaryPath = `${this.filePath}.${process.pid}.tmp`;
        await writeFile(temporaryPath, serialized, { mode: 0o600 });
        await rename(temporaryPath, this.filePath);
      });

    try {
      await this.writeQueue;
    } catch (error) {
      if (previous) {
        this.settings.set(guildId, previous);
      } else {
        this.settings.delete(guildId);
      }
      throw error;
    }
  }
}
