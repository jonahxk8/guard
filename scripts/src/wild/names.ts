/**
 * Display names for replies — never interpolate a Discord object directly.
 *
 * Bug this fixes: several replies used `${user}` / `${role}` on objects
 * that have no useful `toString` on every path. Real discord.js User/Role
 * objects stringify to mentions, but the prefix adapter's fake
 * interaction returns plain `{ id }` objects, whose template rendering
 * is "[object Object]" — which is exactly what users saw live
 * ("[object Object] is now whitelisted."). Every reply below therefore
 * resolves a plain name (or an explicit `<@id>` / `<@&id>` mention built
 * from the id) instead of interpolating the object.
 *
 * All helpers tolerate partial/mock objects: when no name is available
 * they fall back to the mention form, never to "[object Object]".
 */

interface NamedUser {
  id: string;
  username?: string | null;
  displayName?: string | null;
}

interface NamedMember {
  id: string;
  displayName?: string | null;
  user?: NamedUser | null;
}

interface NamedRole {
  id: string;
  name?: string | null;
}

interface NamedChannel {
  id: string;
  name?: string | null;
}

/** A member's server display name, falling back to their username. */
export function memberDisplayName(
  member: NamedMember | null | undefined,
  user?: NamedUser | null,
): string {
  if (member?.displayName) return member.displayName;
  if (member?.user?.username) return member.user.username;
  if (user?.displayName) return user.displayName;
  if (user?.username) return user.username;
  const id = member?.id ?? user?.id;
  return id ? `<@${id}>` : "Unknown member";
}

/** A role's plain name (not a mention). */
export function roleDisplayName(role: NamedRole | null | undefined): string {
  if (!role) return "Unknown role";
  return role.name ?? `<@&${role.id}>`;
}

/** A role mention, built from its id — safe on every path. */
export function roleMention(role: NamedRole | null | undefined): string {
  if (!role) return "Unknown role";
  return `<@&${role.id}>`;
}

/** A channel's name, as `#name`. */
export function channelDisplayName(
  channel: NamedChannel | null | undefined,
): string {
  if (!channel) return "Unknown channel";
  return channel.name ? `#${channel.name}` : `<#${channel.id}>`;
}
