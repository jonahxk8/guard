# Discord bot setup

The bot protects selected server roles. It checks Discord's audit log when a protected role is added and removes unauthorized assignments. If it cannot verify the assigner, it removes the role rather than allowing an unverified assignment.

## Discord setup

1. Create a Discord application and bot in the Discord Developer Portal.
2. Add the bot token as `DISCORD_BOT_TOKEN` in the host's secrets or environment-variable settings. Never paste it into chat or commit it.
3. Enable **Message Content Intent** in the Developer Portal (Bot >
   Privileged Gateway Intents). Wild needs it to read "," prefix
   commands — it was removed when Wild was slash-only, and it must be
   turned back on for prefix commands to fire.
4. Start the **Wild Discord Bot** workflow on Replit, or follow the Railway setup below.
5. Invite the bot with the required scopes and permissions shown in its startup logs.
6. Move the bot's role above every role it needs to manage.
7. Give it **Manage Roles**, **Manage Messages**, and **View Audit Log**.
   It also needs **View Channel**, **Send Messages**, and **Embed Links**
   in the alert channel. Manage Messages lets it delete your ","
   command message after handling it.
8. Run `/whitelist @member` or `/whitelist @role` to authorize assigners. The server owner and anyone with the Discord Administrator permission bypass the guard: their grants are never reverted. Administrators can use the bot fully, exactly like the server owner.
9. Run `/protect @role` for each role to protect. Roles with the Administrator permission can't be protected or assigned through the bot.
10. Optionally set alerts with `/setup #mod-logs`. Run `/setup` with no channel to turn alerts off.

The bot listens for Discord audit-log events. If the actor is not whitelisted, it removes the protected role. Discord's role hierarchy must let the bot manage that role.

When a grant is removed, the bot DMs the assigner an embed (Role /
Member / Server / Reason fields) stating which role was removed and
why. The DM never asks to get whitelisted. After 3 unauthorised assignments by the same person in the same server, the log embed flags them as a repeat offender. If no alert channel is set, the removal and DM still happen — nothing is silently skipped.

The bot also corroborates each audit-log event against the guild's recent audit log (up to 10 entries, matched by target, role, and time). When it can't verify who assigned a role, it removes the role by default.

Every reply is a colourless embed (no colour set, so it blends in with no accent bar; plain title and description, no footer, no timestamp) — confirmations, errors, `/status`, `/fg list`, the log embed, and the share offer alike. Slash replies are invisible (ephemeral). `/status` lists any protected or FG roles the bot can't manage and shows "Needs setup" until the bot's role is moved above them; the same check runs at startup and logs a warning per server.

Prefix (",") replies cannot be invisible — Discord has no ephemeral message replies, so a `,` reply is always visible in the channel. That is a Discord limitation, not a bug. Wild mitigates it: your `,` command message is deleted after handling (best-effort), and error replies auto-delete after 10 seconds (best-effort). Success replies stay. If you need invisible errors, use the slash versions. Unknown `,` commands get no reply at all, and the message is never deleted — it may belong to Greed or another bot.

There is no pause command: the guard always enforces. An old config with enforcement paused is ignored.

## Commands

Every command works as a slash command and as a "," prefix command —
same behaviour, same handler. Prefix examples use mentions or raw IDs.

Core — all need Manage Server, except `/blacklist list` (Manage Server
or whitelisted):

- `/protect @role` / `,guard @role` — protect a role, or stop protecting it (tap again). Prefix is `,guard` because Greed owns `,protect`.
- `/whitelist @user` or `@role` / `,whitelist @user` or `@role` — whitelist someone, or remove them (tap again).
- `/status` / `,status` — view protection status, FG roles, and blacklist count.
- `/setup #channel` / `,logchannel #channel` or `,logchannel off` — set the alert channel, or turn alerts off. Prefix is `,logchannel` because Greed owns `,setup`.

Blacklist — blocks a member from a protected role. If that role is ever given to them, Wild removes it instantly, whoever gave it — even a whitelisted giver or FG staff. It works for any protected role, not just one ("pic" was only an example). The exceptions are the server owner and Administrators: their grants are never reverted. If the audit log cannot say who gave the role, the grant is still removed (fail closed).

- `/blacklist add @user @role` / `,blacklist add @user @role` — blacklist a member from a protected role (Manage Server). The role must already be protected, or the bot answers "Protect that role first with /protect @role".
- `/blacklist remove @user @role` / `,blacklist remove @user @role` — unblacklist them (Manage Server).
- `/blacklist list` / `,blacklist list` — list the blacklist as a paginated embed, 10 users per page with Prev/Next buttons, one field per user (Manage Server or whitelisted).

FG roles — Bleed booster-role style. Each member makes their own unique, personal, cosmetic role under one base role and customises it (name, colour, icon). FG roles are created with no permissions, are automatically protected, and the guard applies to them like any other protected role.

- `/fg base @role` / `,fg base @role` — set the base role FG roles sit under (Manage Server). Keep it above any coloured roles or the colour won't show.
- `/fg color <color> <name>` / `,fg color <color> <name>` — make your own FG role. Optional second colour for a gradient (`,fg color <color> <name> <second_color>`). Colours accept any CSS colour name or hex code: `#rrggbb`, `rrggbb`, `#rgb`, `rgb`, or `0xrrggbb`. Only whitelisted members (or the server owner or an Administrator) can make one, and only one FG role per member (Wild rule — Bleed gates this on boosting instead).
- `/fg create <name> <color> [second_color] [@member]` / `,fg create <name> <color> [second_color] [@member]` — create an FG role for yourself, or for a named member. Needs an FG base role set first (`/fg base`). Only the server owner, administrators, or whitelisted members can use it.
- `/fg rename <name>` / `,fg rename <name>` — rename your own FG role.
- `/fg icon <url>` / `,fg icon <url>` — set your own FG role's icon: image link, emoji, or custom emoji. Role icons only show on Boost Level 2+ servers.
- `/fg remove` / `,fg remove` — delete your own FG role.
- `/fg list` / `,fg list` — list all FG roles and their owners (Manage Server or whitelisted).
- `/fg cleanup` / `,fg cleanup` — remove FG roles whose owners left the server (Manage Server).
- `/fg share @member @role` / `,fg share @member @role` — offer one of your FG roles to a member. Wild-only extra — Bleed documents no share command. You may share only if you are the server owner, an Administrator, whitelisted, the FG role's owner, or authorised to share that role (see below). All errors are invisible (ephemeral) on slash, or auto-deleting on prefix; only the offer itself is public.
- `/fg assign @member @role` / `,fg assign @member @role` — give an existing FG role to a member, and authorise them to share it (server owner, administrators, or whitelisted only). If they already hold the role, it just authorises them.
- `/fg auth add @member @role` / `,fg auth add @member @role` — let someone share one of your FG roles, without giving them the role (the FG role's owner, the server owner, administrators, or whitelisted only).
- `/fg auth remove @member @role` / `,fg auth remove @member @role` — take someone's permission to share an FG role away (same gate as auth add; the FG role owner themself can never be removed).
- `/fg auth list @role` / `,fg auth list @role` — list who can share an FG role, owner first (same gate as auth add).

Sharing FG roles, in three lines: staff assign FG roles to people, so only those people are authorised to share them; an FG owner can authorise others to share their role; auth is permission to share, not the role itself. The old shared "award" role was removed — it was confusing and is gone.

## Help

`/help` / `,help` opens a paged help menu — one colourless embed per
page, one field per command, plain text only, no emojis. Help shows
only the syntax for the form it was opened with: `/help` shows slash
forms, `,help` shows prefix forms. Each command is one field: the
syntax in backticks, then a short purpose line. There are no "Who:"
lines — help is personalised: it only shows the commands *you* can
actually use, worked out from your roles, your FG roles, and whether
you are whitelisted or an admin.

Who sees what: the server owner, anyone with the Discord
Administrator permission, and whitelisted users / roles see the full
menu (Guard, FG, Blacklist). An FG owner sees only FG — their own
role's commands (rename, icon, remove), sharing, and auth. Someone
assigned an FG role or authed to share one sees only FG share. A
normal member with no FG role sees the FG category with the note
"You don't have an FG role yet — ask an admin or whitelisted member
to assign you one." and no commands they can't touch. Asking for a
command you can't use gets the short error "You can't use that
command.", never the command's syntax. The capability check runs
again on every button press, so a member who lost a role or their
whitelist cannot reach pages through a menu they opened earlier.

FG has 13 subcommands, so it
splits into 2 pages of 7 and 6 ("Help - FG (1/2)" and "(2/2)") with
Prev/Next buttons and a Back button to the main page; the page count
is recomputed after filtering, so an FG owner sees their 7 commands
on one page. Guard and Blacklist fit on one page each. `/help fg create`,
`/help blacklist add`, or `/help protect` shows just that command —
Syntax, What it does, and an Example — with a Back button to its
category page. An unknown topic gets a short error pointing at `/help`.
Only the person who ran /help can use its buttons, and they stop
working after 5 minutes.

Every other Wild embed uses the same style: no colour, plain
title, no footer, no timestamp, one field per item — /status (one
field per section), /fg list (one field per FG role, with its owner),
the guard log embed (Role / Assigned by / Reason fields), and the FG
share offer (Role / From / To fields, with its Yes / No buttons). The
guard DM is an embed in the same style (Role / Member / Server /
Reason fields) that states what was removed and why — it never asks
you to get whitelisted.

A bare `,fg` or `,blacklist` (or an unknown subcommand) no longer
dumps every usage variant — it just says "Use ,help fg" (or
",help blacklist"). There is no usage wall anywhere now.

## No clash with Greed

Greed also uses the "," prefix, and it owns two names Wild would otherwise want: `,protect` (marks a member/role off-limits to Greed moderation) and `,setup` (auto-creates Greed's imute/rmute/jailed roles and a mod category). Typing either with both bots in the server fires Greed's action, not Wild's — so Wild's prefix versions are renamed: `,guard` does what `/protect` does, and `,logchannel` does what `/setup` does. The slash commands `/protect` and `/setup` are unchanged; only the prefix names differ.

Wild also never uses Greed's `,boosterrole` (alias `,br`), `,autorole`, or bare `,role`, and no `,fg boosterrole` subcommand.

Not verified: whether Greed also has `,whitelist`, `,status`, `,fg`, or `,blacklist`. No full Greed command index was checked, so before relying on those four, type them in a test channel with both bots present and confirm Wild answers and Greed stays silent.

The old `/wild`, `/roles`, `/watch`, `/enforcement`, `/logs`, `/commands`, `/fg staff`, `/fg access`, and `/fg award` commands are gone.

## Railway deployment

Deploy this repository as a long-running worker service, using the repository root:

- Build command: `pnpm run build:wild`
- Start command: `pnpm run start:wild`
- Add `DISCORD_BOT_TOKEN` as a Railway variable.
- Add a Railway volume mounted at `/data` and set `WILD_CONFIG_PATH=/data/wild-config.json` so server settings survive redeploys.
- No public domain or HTTP port is needed; this bot connects to Discord as a worker.
- Enable restart-on-failure in the service's deployment settings.
- Run one replica so multiple copies do not process the same Discord role events concurrently.

## Local running and checks

- `pnpm --filter @workspace/scripts run wild` — start directly from TypeScript for local/Replit use.
- `pnpm run build:wild` — compile the bot for Railway.
- `pnpm run start:wild` — start the compiled bot.
- `pnpm --filter @workspace/scripts run typecheck` — check the TypeScript sources.
- `pnpm --filter @workspace/scripts run test` — run the bot tests.

Configuration is stored in `data/wild-config.json` by default and can be relocated with `WILD_CONFIG_PATH`. A `wild-config.json.bak` backup of the previous settings is written on every save.

The token is `DISCORD_BOT_TOKEN` (not `DISCORD_TOKEN`). Slash commands are registered globally with a full overwrite on startup: the bot registers exactly `/protect`, `/whitelist`, `/status`, `/setup`, `/fg`, `/blacklist`, and `/help`, and removes any stale commands Discord still lists from older versions. The new list can take up to an hour to appear in Discord after a redeploy — and nothing updates until you redeploy the bot on Railway. The old `/logs` commands are gone, replaced by `/setup` and `,logchannel`. Prefix commands work as soon as the bot is online and Message Content Intent is enabled — no wait.
