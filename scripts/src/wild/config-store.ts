import { copyFile, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

export interface GuildSettings {
  protectedRoleIds: string[];
  allowedUserIds: string[];
  allowedRoleIds: string[];
  fgStaffUserIds: string[];
  fgStaffRoleIds: string[];
  fgRoles: Record<string, FgRoleAccess>;
  logChannelId: string | null;
  enforcementEnabled: boolean;
}

export interface FgRoleAccess {
  assignUserIds: string[];
  assignRoleIds: string[];
  shareUserIds: string[];
  shareRoleIds: string[];
}

interface PersistedConfig {
  version: 1;
  guilds: Record<string, GuildSettings>;
}

const emptySettings = (): GuildSettings => ({
  protectedRoleIds: [],
  allowedUserIds: [],
  allowedRoleIds: [],
  fgStaffUserIds: [],
  fgStaffRoleIds: [],
  fgRoles: {},
  logChannelId: null,
  enforcementEnabled: true,
});

function isSnowflake(value: unknown): value is string {
  return typeof value === "string" && /^\d{5,25}$/.test(value);
}

function isSnowflakeArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every(isSnowflake);
}

function parseOptionalSnowflakeArray(
  value: unknown,
  fieldName: string,
  guildId: string,
): string[] {
  if (value === undefined) return [];
  if (!isSnowflakeArray(value)) {
    throw new Error(`Wild settings field ${fieldName} for server ${guildId} is invalid.`);
  }
  return [...value];
}

function parseFgRoles(value: unknown, guildId: string): Record<string, FgRoleAccess> {
  if (value === undefined) return {};
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`FG role settings for server ${guildId} are invalid.`);
  }

  const roles: Record<string, FgRoleAccess> = {};
  for (const [roleId, rawAccess] of Object.entries(value)) {
    if (!isSnowflake(roleId) || typeof rawAccess !== "object" || rawAccess === null) {
      throw new Error(`FG role settings for server ${guildId} are invalid.`);
    }
    const access = rawAccess as Record<string, unknown>;
    roles[roleId] = {
      assignUserIds: parseOptionalSnowflakeArray(
        access.assignUserIds,
        "assignUserIds",
        guildId,
      ),
      assignRoleIds: parseOptionalSnowflakeArray(
        access.assignRoleIds,
        "assignRoleIds",
        guildId,
      ),
      shareUserIds: parseOptionalSnowflakeArray(
        access.shareUserIds,
        "shareUserIds",
        guildId,
      ),
      shareRoleIds: parseOptionalSnowflakeArray(
        access.shareRoleIds,
        "shareRoleIds",
        guildId,
      ),
    };
  }
  return roles;
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
    !(candidate.logChannelId === null || isSnowflake(candidate.logChannelId)) ||
    !(
      candidate.enforcementEnabled === undefined ||
      typeof candidate.enforcementEnabled === "boolean"
    )
  ) {
    throw new Error(`Wild settings for server ${guildId} are invalid.`);
  }

  return {
    protectedRoleIds: [...candidate.protectedRoleIds],
    allowedUserIds: [...candidate.allowedUserIds],
    allowedRoleIds: parseOptionalSnowflakeArray(
      candidate.allowedRoleIds,
      "allowedRoleIds",
      guildId,
    ),
    fgStaffUserIds: parseOptionalSnowflakeArray(
      candidate.fgStaffUserIds,
      "fgStaffUserIds",
      guildId,
    ),
    fgStaffRoleIds: parseOptionalSnowflakeArray(
      candidate.fgStaffRoleIds,
      "fgStaffRoleIds",
      guildId,
    ),
    fgRoles: parseFgRoles(candidate.fgRoles, guildId),
    logChannelId: candidate.logChannelId,
    enforcementEnabled: candidate.enforcementEnabled ?? true,
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
          allowedRoleIds: [...current.allowedRoleIds],
          fgStaffUserIds: [...current.fgStaffUserIds],
          fgStaffRoleIds: [...current.fgStaffRoleIds],
          fgRoles: Object.fromEntries(
            Object.entries(current.fgRoles).map(([roleId, access]) => [
              roleId,
              {
                assignUserIds: [...access.assignUserIds],
                assignRoleIds: [...access.assignRoleIds],
                shareUserIds: [...access.shareUserIds],
                shareRoleIds: [...access.shareRoleIds],
              },
            ]),
          ),
          logChannelId: current.logChannelId,
          enforcementEnabled: current.enforcementEnabled,
        }
      : emptySettings();
  }

  async set(guildId: string, next: GuildSettings): Promise<void> {
    const previous = this.settings.get(guildId);
    this.settings.set(guildId, {
      protectedRoleIds: [...next.protectedRoleIds],
      allowedUserIds: [...next.allowedUserIds],
      allowedRoleIds: [...next.allowedRoleIds],
      fgStaffUserIds: [...next.fgStaffUserIds],
      fgStaffRoleIds: [...next.fgStaffRoleIds],
      fgRoles: Object.fromEntries(
        Object.entries(next.fgRoles).map(([roleId, access]) => [
          roleId,
          {
            assignUserIds: [...access.assignUserIds],
            assignRoleIds: [...access.assignRoleIds],
            shareUserIds: [...access.shareUserIds],
            shareRoleIds: [...access.shareRoleIds],
          },
        ]),
      ),
      logChannelId: next.logChannelId,
      enforcementEnabled: next.enforcementEnabled,
    });

    const snapshot: PersistedConfig = {
      version: 1,
      guilds: Object.fromEntries(this.settings),
    };
    const serialized = `${JSON.stringify(snapshot, null, 2)}\n`;

    this.writeQueue = this.writeQueue
      .catch(() => undefined)
      .then(async () => {
        // Best-effort backup of the previous settings before overwriting.
        await copyFile(this.filePath, `${this.filePath}.bak`).catch(() => undefined);
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
