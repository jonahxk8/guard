import { copyFile, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

export interface GuildSettings {
  protectedRoleIds: string[];
  allowedUserIds: string[];
  allowedRoleIds: string[];
  fgStaffUserIds: string[];
  fgStaffRoleIds: string[];
  fgRoles: Record<string, FgRoleAccess>;
  /** Role all FG roles sit under (Bleed-style base role). Null = not set. */
  fgBaseRoleId: string | null;
  /** FG role id -> owner user id. One FG role per member (Wild rule). */
  fgRoleOwners: Record<string, string>;
  /**
   * FG role id -> user ids authorised to share that role. The FG role
   * owner, the server owner, and whitelisted staff are always authorised
   * and are not listed here. A member gets listed by /fg auth add
   * (permission to share only — they do not get the role itself). The
   * old /fg assign command also listed members here; it was removed,
   * and the lists are kept so old configs still load.
   */
  fgRoleSharers: Record<string, string[]>;
  /**
   * Blacklist: user id -> protected role ids that user may never be given.
   * A blacklisted grant is removed instantly, whoever gave it (except the
   * server owner). Works for any protected role, not just one role.
   */
  blacklist: Record<string, string[]>;
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
  fgBaseRoleId: null,
  fgRoleOwners: {},
  fgRoleSharers: {},
  blacklist: {},
  logChannelId: null,
  enforcementEnabled: true,
});

function parseOptionalSnowflake(
  value: unknown,
  fieldName: string,
  guildId: string,
): string | null {
  if (value === undefined || value === null) return null;
  if (!isSnowflake(value)) {
    throw new Error(`Wild settings field ${fieldName} for server ${guildId} is invalid.`);
  }
  return value;
}

function parseFgRoleOwners(value: unknown, guildId: string): Record<string, string> {
  if (value === undefined) return {};
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`FG role owners for server ${guildId} are invalid.`);
  }
  const owners: Record<string, string> = {};
  for (const [roleId, userId] of Object.entries(value)) {
    if (!isSnowflake(roleId) || !isSnowflake(userId)) {
      throw new Error(`FG role owners for server ${guildId} are invalid.`);
    }
    owners[roleId] = userId;
  }
  return owners;
}

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

function parseFgRoleSharers(value: unknown, guildId: string): Record<string, string[]> {
  if (value === undefined) return {};
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`FG role sharers for server ${guildId} are invalid.`);
  }
  const map: Record<string, string[]> = {};
  for (const [roleId, userIds] of Object.entries(value)) {
    if (!isSnowflake(roleId) || !isSnowflakeArray(userIds)) {
      throw new Error(`FG role sharers for server ${guildId} are invalid.`);
    }
    map[roleId] = [...new Set(userIds)];
  }
  return map;
}

function parseBlacklist(value: unknown, guildId: string): Record<string, string[]> {
  if (value === undefined) return {};
  // Lenient: also accept an array of { userId, roleId } pairs.
  if (Array.isArray(value)) {
    const map: Record<string, string[]> = {};
    for (const entry of value) {
      if (typeof entry !== "object" || entry === null) {
        throw new Error(`Blacklist settings for server ${guildId} are invalid.`);
      }
      const { userId, roleId } = entry as Record<string, unknown>;
      if (!isSnowflake(userId) || !isSnowflake(roleId)) {
        throw new Error(`Blacklist settings for server ${guildId} are invalid.`);
      }
      const list = map[userId] ?? (map[userId] = []);
      if (!list.includes(roleId)) list.push(roleId);
    }
    return map;
  }
  if (typeof value !== "object" || value === null) {
    throw new Error(`Blacklist settings for server ${guildId} are invalid.`);
  }
  const map: Record<string, string[]> = {};
  for (const [userId, roleIds] of Object.entries(value)) {
    if (!isSnowflake(userId) || !isSnowflakeArray(roleIds)) {
      throw new Error(`Blacklist settings for server ${guildId} are invalid.`);
    }
    map[userId] = [...new Set(roleIds)];
  }
  return map;
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
    fgBaseRoleId: parseOptionalSnowflake(
      candidate.fgBaseRoleId,
      "fgBaseRoleId",
      guildId,
    ),
    // fgAwardRoleId was removed (the award system is gone). Old configs
    // may still have it stored — it is ignored here, never read back,
    // and never written again, so those configs still load fine.
    fgRoleOwners: parseFgRoleOwners(candidate.fgRoleOwners, guildId),
    fgRoleSharers: parseFgRoleSharers(candidate.fgRoleSharers, guildId),
    blacklist: parseBlacklist(candidate.blacklist, guildId),
    logChannelId: candidate.logChannelId,
    enforcementEnabled: candidate.enforcementEnabled ?? true,
  };
}

/** Is this user blacklisted from this protected role? */
export function isBlacklisted(
  settings: GuildSettings,
  userId: string,
  roleId: string,
): boolean {
  return (settings.blacklist?.[userId] ?? []).includes(roleId);
}

/** Total number of blacklist pairs (user, role) in this server. */
export function blacklistCount(settings: GuildSettings): number {
  return Object.values(settings.blacklist ?? {}).reduce(
    (total, roleIds) => total + roleIds.length,
    0,
  );
}

/** Every blacklist pair, as { userId, roleId }. */
export function blacklistEntries(settings: GuildSettings): Array<{
  userId: string;
  roleId: string;
}> {
  return Object.entries(settings.blacklist ?? {}).flatMap(([userId, roleIds]) =>
    roleIds.map((roleId) => ({ userId, roleId })),
  );
}

/** User ids explicitly authorised to share one FG role (owner not included). */
export function fgSharersFor(settings: GuildSettings, roleId: string): string[] {
  return [...(settings.fgRoleSharers?.[roleId] ?? [])];
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
          fgBaseRoleId: current.fgBaseRoleId ?? null,
          fgRoleOwners: { ...current.fgRoleOwners },
          fgRoleSharers: Object.fromEntries(
            Object.entries(current.fgRoleSharers ?? {}).map(([roleId, userIds]) => [
              roleId,
              [...userIds],
            ]),
          ),
          blacklist: Object.fromEntries(
            Object.entries(current.blacklist ?? {}).map(([userId, roleIds]) => [
              userId,
              [...roleIds],
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
      fgBaseRoleId: next.fgBaseRoleId ?? null,
      fgRoleOwners: { ...(next.fgRoleOwners ?? {}) },
      fgRoleSharers: Object.fromEntries(
        Object.entries(next.fgRoleSharers ?? {}).map(([roleId, userIds]) => [
          roleId,
          [...userIds],
        ]),
      ),
      blacklist: Object.fromEntries(
        Object.entries(next.blacklist ?? {}).map(([userId, roleIds]) => [
          userId,
          [...roleIds],
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
