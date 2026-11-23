/**
 * In-memory count of unauthorised role assignments, per server and actor.
 *
 * This is deliberately not persisted: it is a short-lived moderation signal
 * for the "repeat offender" log field, not a punishment record. Counts reset
 * when the bot restarts.
 */

export const REPEAT_OFFENDER_THRESHOLD = 3;

const offenses = new Map<string, Map<string, number>>();

/** Record one unauthorised assignment and return the actor's new total. */
export function recordOffense(guildId: string, actorId: string): number {
  let perGuild = offenses.get(guildId);
  if (!perGuild) {
    perGuild = new Map<string, number>();
    offenses.set(guildId, perGuild);
  }
  const next = (perGuild.get(actorId) ?? 0) + 1;
  perGuild.set(actorId, next);
  return next;
}

export function getOffenseCount(guildId: string, actorId: string): number {
  return offenses.get(guildId)?.get(actorId) ?? 0;
}

/** Test helper: clear all recorded offences. */
export function clearOffenses(): void {
  offenses.clear();
}
