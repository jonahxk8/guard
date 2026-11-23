# Wild — Discord Role Guard Bot

Wild protects selected server roles. When a protected role is added, it
checks Discord's audit log for who assigned it. If the assigner isn't
whitelisted, the bot removes the role, DMs the assigner to explain why,
and logs the removal. If it can't verify who assigned the role, it
removes the role by default (fail closed) instead of allowing an
unverified assignment.

The server owner bypasses the guard — the owner's own grants are never
reverted. Repeat offenders (3+ unauthorised assignments) are flagged in
the log.

Wild is simple on purpose: seven slash commands, each with a "," prefix
version that works the same way. Confirmations and errors are short
invisible (ephemeral) plain-text replies — only you can see them. All
embeds are black (colour 0, no footer, no timestamp).

## Discord setup

1. Create a Discord application and bot in the Discord Developer Portal.
2. Set `DISCORD_BOT_TOKEN` in your host's secrets / environment variables.
   Never paste the token into chat or commit it.
3. Enable **Message Content Intent** in the Developer Portal (Bot >
   Privileged Gateway Intents). Wild needs it to read "," prefix
   commands. It was not needed when Wild was slash-only.
4. Invite the bot with Manage Roles, Manage Messages, View Audit Log,
   View Channel, Send Messages, and Embed Links. Manage Messages lets
   it delete your "," command message after handling it.
5. Move the bot's role above every role it needs to manage.
6. Run `/whitelist @member` (or `@role`) to authorise assigners, then
   `/protect @role` for each role to protect.
7. Optionally set alerts with `/setup #mod-logs`.

Administrator roles can never be protected or assigned through the bot.
All commands need Manage Server, except `/fg color`, `/fg create`,
`/fg rename`, `/fg icon`, `/fg remove`, and `/fg share`, which any
whitelisted member (or the server owner) can use. `/fg create` needs an
FG base role set first. `/blacklist list` can also be used by
whitelisted members; `/blacklist add` and `/blacklist remove` need
Manage Server.

## Commands

Every command works as a slash command and as a "," prefix command —
same behaviour, same handler. Prefix examples use mentions or raw IDs.

- `/protect @role` / `,guard @role` — protect a role, or stop
  protecting it (tap again). The prefix is `,guard`, not `,protect`,
  because Greed owns `,protect` (see "No clash with Greed" below).
- `/whitelist @user` or `@role` / `,whitelist @user` or `@role` —
  whitelist someone, or remove them (tap again).
- `/status` / `,status` — view protection status, including any
  protected or FG roles the bot can't manage.
- `/setup #channel` / `,logchannel #channel` or `,logchannel off` —
  set the alert channel. Run it with no channel (or `off`) to turn
  alerts off. The prefix is `,logchannel`, not `,setup`, because
  Greed owns `,setup`.
- `/fg base @role` / `,fg base @role` — set the base role FG roles sit
  under (Manage Server).
- `/fg color <color> <name>` / `,fg color <color> <name>` — make your
  own FG role. Optional second colour for a gradient
  (`,fg color <color> <name> <second_color>`).
- `/fg create <name> <color> [second_color] [@member]` /
  `,fg create <name> <color> [second_color] [@member]` — create an FG
  role for yourself, or for a named member. Needs an FG base role set
  first. Only the server owner or whitelisted members can use it.
- `/fg rename <name>` / `,fg rename <name>` — rename your own FG role.
- `/fg icon <url>` / `,fg icon <url>` — set your own FG role's icon
  (image link, emoji, or custom emoji).
- `/fg remove` / `,fg remove` — delete your own FG role.
- `/fg list` / `,fg list` — list all FG roles and their owners.
- `/fg cleanup` / `,fg cleanup` — remove FG roles whose owners left
  the server.
- `/fg share @member @role` / `,fg share @member @role` — offer one of
  your FG roles to a member.
- `/fg award set @role` / `/fg award view` / `/fg award remove` /
  `,fg award set @role` / `,fg award view` / `,fg award remove` — the
  shared role given when someone makes an FG role (Manage Server).
- `/blacklist add @user @role` / `,blacklist add @user @role` —
  blacklist a member from a protected role (Manage Server).
- `/blacklist remove @user @role` / `,blacklist remove @user @role` —
  unblacklist them (Manage Server).
- `/blacklist list` / `,blacklist list` — list the blacklist (Manage
  Server or whitelisted).
- `/help` / `,help` — show all commands, grouped by category.
  `/help fg` (or `,help fg`) shows one category; `/help fg create`
  shows just that command. A bare `,fg` or `,blacklist` just points at
  the help page now — no usage wall.

## Help

`/help` shows every command in one black embed, grouped by category
(Guard, FG, Blacklist), one line per command with a one-line purpose.
`/help guard`, `/help fg`, or `/help blacklist` shows one category
with each command's exact slash and prefix syntax, and `/help fg
create` or `/help blacklist add` shows one command's syntax, purpose,
and who can use it. Unknown topics get a short error pointing at
`/help`.

## Prefix commands — read this first

Prefix replies **cannot be invisible**: Discord has no ephemeral
message replies, so a `,` reply is always visible in the channel.
That is a Discord limitation, not a bug. Wild mitigates it two ways:
your `,` command message is deleted after handling (best-effort), and
error replies auto-delete after 10 seconds (best-effort). Success
replies stay. Only `/status`, `/fg list`, and the share offer use
embeds; everything else is short plain text. If you need invisible
errors, use the slash versions instead.

Unknown `,` commands get no reply at all — the bot stays silent, so
it never spams errors and never deletes a message that belongs to
another bot.

## Blacklist

The blacklist blocks a **member** from a **protected role**: if that
role is ever given to them, Wild removes it instantly, whoever gave
it — even a whitelisted giver or FG staff. It works for any protected
role, not just one ("pic" was only an example). Set it with
`/blacklist add @user @role` (the role must already be protected —
otherwise the bot answers "Protect that role first with
/protect @role"). Remove it with `/blacklist remove @user @role`, and
see the whole list with `/blacklist list`. `/status` shows how many
blacklist entries there are.

The one exception is the **server owner**: the owner's own grants are
never reverted, same as the rest of the guard. If the audit log cannot
say who gave the role, the grant is still removed (fail closed).

## No clash with Greed

Greed also uses the "," prefix, and it owns two names Wild would
otherwise want: `,protect` (marks a member/role off-limits to Greed
moderation) and `,setup` (auto-creates Greed's imute/rmute/jailed
roles and a mod category). Typing either with both bots in the server
fires Greed's action, not Wild's — so Wild's prefix versions are
renamed: `,guard` does what `/protect` does, and `,logchannel` does
what `/setup` does. The slash commands `/protect` and `/setup` are
unchanged; only the prefix names differ.

Wild also never uses Greed's `,boosterrole` (alias `,br`), `,autorole`,
or bare `,role`, and no `,fg boosterrole` subcommand.

Not verified: whether Greed also has `,whitelist`, `,status`, `,fg`,
or `,blacklist`. No full Greed command index was checked, so before
relying on those four, type them in a test channel with both bots
present and confirm Wild answers and Greed stays silent.

## FG roles — Bleed booster-role style

FG roles work like Bleed's booster roles: each member makes their own
unique, personal, cosmetic role that sits under one base role, and
customises it themselves (name, colour, icon). Set the base once with
`/fg base`, and keep it above any coloured roles or the colour won't
show.

Wild adaptations (these are Wild rules, not Bleed behaviour):

- **Eligibility is being whitelisted, not boosting.** Bleed gates FG
  roles on boosting the server; Wild gates them on `/whitelist`
  instead.
- **One FG role per member.** Make a second one only after removing
  the first with `/fg remove`.
- **Award role:** `/fg award set` picks one shared role, and Wild
  gives it to a member when they make their FG role. Bleed grants its
  award when someone boosts — Wild has no boost event to hook.
- **Share is Wild-only.** Bleed documents no share command. In Wild,
  `/fg share` lets someone who holds an FG role and is whitelisted
  offer it to a friend; the friend accepts or declines with buttons.
  All share errors are invisible (ephemeral) — only the offer itself
  is public, because the friend needs to see it.

FG roles are created with no permissions, are automatically protected,
and the audit-log guard applies to them like any other protected role.
Role icons only show on Boost Level 2+ servers.

## Run it

Requires Node 24+ and pnpm 10.

```sh
pnpm install
pnpm --filter @workspace/scripts run wild        # run from TypeScript
pnpm run build:wild                              # compile
pnpm run start:wild                              # run the compiled bot
pnpm --filter @workspace/scripts run typecheck   # check types
pnpm --filter @workspace/scripts run test        # run bot tests
```

Settings live in `data/wild-config.json` by default, or wherever
`WILD_CONFIG_PATH` points. A `wild-config.json.bak` backup of the
previous settings is written on every save.

## Railway deployment

Deploy as a long-running worker service from the repository root:

- Build command: `pnpm run build:wild`
- Start command: `pnpm run start:wild`
- Add `DISCORD_BOT_TOKEN` as a Railway variable.
- Add a Railway volume mounted at `/data` and set
  `WILD_CONFIG_PATH=/data/wild-config.json` so settings survive redeploys.
- One replica only, with restart on failure. No public domain or HTTP
  port is needed.

## Notes

- Slash commands are registered globally, so `/protect`, `/whitelist`,
  `/status`, `/setup`, `/fg`, `/blacklist`, and `/help` can take up to
  an hour to appear in Discord after the bot first starts. The old
  `/wild`, `/roles`, `/watch`, `/enforcement`, `/logs`, and `/commands`
  commands are gone. Prefix commands work as soon as the bot is online
  and Message Content Intent is enabled — no wait.
- The bot code lives in `scripts/src/`. The other workspace packages
  (`artifacts/`, `lib/`) are unrelated Replit scaffold and are not used
  by the bot.

Full setup and troubleshooting: see `scripts/WILD_BOT.md`.
