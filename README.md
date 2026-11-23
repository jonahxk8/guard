# Wild — Discord Role Guard Bot

Wild protects selected server roles. When a protected role is added, it
checks Discord's audit log for who assigned it. If the assigner isn't
whitelisted, the bot removes the role, DMs the assigner to explain why,
and logs the removal. If it can't verify who assigned the role, it
removes the role by default (fail closed) instead of allowing an
unverified assignment.

The server owner and anyone with the Discord Administrator permission
bypass the guard — their grants are never reverted. Repeat offenders
(3+ unauthorised assignments) are flagged in the log.

Wild is simple on purpose: seven slash commands, each with a "," prefix
version that works the same way. Every reply is an embed — confirmations
and errors are short invisible (ephemeral) embeds, only you can see them.
All embeds use no colour at all (no accent bar, so they blend into the
chat background and look invisible), no footer, no timestamp.

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
The server owner and anyone with the Discord Administrator permission
can use the bot fully, exactly like each other. All commands need Manage
Server, except `/fg color`, `/fg create`, `/fg rename`, `/fg icon`,
`/fg remove`, and `/fg share`, which any whitelisted member (or the
server owner or an Administrator) can use. `/fg create` needs an FG base
role set first. `/blacklist list` can also be used by whitelisted
members; `/blacklist add` and `/blacklist remove` need Manage Server.

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
  (`,fg color <color> <name> <second_color>`). Colours accept any CSS
  colour name or hex code: `#rrggbb`, `rrggbb`, `#rgb`, `rgb`, or
  `0xrrggbb`.
- `/fg create <name> <color> [second_color] [@member]` /
  `,fg create <name> <color> [second_color] [@member]` — create an FG
  role for yourself, or for a named member. Needs an FG base role set
  first. Only the server owner, administrators, or whitelisted members
  can use it.
- `/fg rename <name>` / `,fg rename <name>` — rename your own FG role.
- `/fg icon <url>` / `,fg icon <url>` — set your own FG role's icon
  (image link, emoji, or custom emoji).
- `/fg remove` / `,fg remove` — delete your own FG role.
- `/fg list` / `,fg list` — list all FG roles and their owners.
- `/fg cleanup` / `,fg cleanup` — remove FG roles whose owners left
  the server.
- `/fg share @member @role` / `,fg share @member @role` — offer one of
  your FG roles to a member (see "Sharing FG roles" below).
- `/fg assign @member @role` / `,fg assign @member @role` — give an
  existing FG role to a member, and authorise them to share it (server
  owner, administrators, or whitelisted only).
- `/fg auth add @member @role` / `,fg auth add @member @role` — let
  someone share one of your FG roles, without giving them the role
  (the FG role's owner, the server owner, administrators, or whitelisted
  only).
- `/fg auth remove @member @role` / `,fg auth remove @member @role` —
  take someone's permission to share an FG role away (same gate as
  auth add; the FG role owner themself can never be removed).
- `/fg auth list @role` / `,fg auth list @role` — list who can share
  an FG role, owner first (same gate as auth add).
- `/blacklist add @user @role` / `,blacklist add @user @role` —
  blacklist a member from a protected role (Manage Server).
- `/blacklist remove @user @role` / `,blacklist remove @user @role` —
  unblacklist them (Manage Server).
- `/blacklist list` / `,blacklist list` — list the blacklist, 10 users
  per page with Prev/Next buttons (Manage Server or whitelisted).
- `/help` / `,help` — show all commands, grouped by category.
  `/help fg` (or `,help fg`) shows one category; `/help fg create`
  shows just that command. A bare `,fg` or `,blacklist` just points at
  the help page now — no usage wall.

## Help

`/help` / `,help` opens a paged help menu — one colourless embed per
page, one field per command, plain text only, no emojis. Help shows
only the syntax for the form it was opened with: `/help` shows slash
forms, `,help` shows prefix forms. Each command is one field: the
syntax in backticks, then a short purpose line. There are no "Who:"
lines — help only ever shows the commands *you* can actually use,
worked out from your roles, your FG roles, and whether you are
whitelisted or an admin. If you cannot use a command, it is not on
your menu at all.

Who sees what: the server owner, anyone with the Discord Administrator
permission, and whitelisted users / roles see the full menu (Guard, FG,
Blacklist). An FG owner sees only FG — their own role's commands
(rename, icon, remove), sharing, and auth. Someone assigned an FG role
or authed to share one sees only FG share. A normal member with no FG
role sees the FG category with the note "You don't have an FG role
yet — ask an admin or whitelisted member to assign you one." and no
commands they can't touch. Asking for a command you can't use gets
the short error "You can't use that command.", never the command's
syntax. Buttons re-check what you can do on every press, so a menu
opened before you lost a role or whitelist can't reach pages you no
longer qualify for.

The main page lists the visible categories with buttons to jump to
each one, with command counts for you, not the total:

```
Help
  Guard — Protect roles and whitelist assigners
          4 commands
  FG — Personal FG roles
       13 commands
  Blacklist — Block members from roles
              3 commands
  [Guard] [FG] [Blacklist]
```

Each category page lists its commands the same way — one field per
command, one purpose line:

```
Help - FG (1/2)
  `/fg base @role`
  Set the FG base role
  ...
  [Next] [Back]
```

FG has 13 subcommands, so it splits into 2 pages of 7 and 6
("Help - FG (1/2)" and "(2/2)") with Prev/Next buttons; the
page count is recomputed after filtering, so an FG owner sees their
7 commands on one page. Guard and Blacklist fit on one page each.
`/help fg create` or `/help blacklist add` (`,help fg create` and so
on) shows just that one command: Syntax, What it does, and an
Example, with a Back button to its category page. Unknown topics get
a short error pointing at `/help`. Only the person who ran /help can
use its buttons — anyone else gets told to run /help for their own
menu — and the buttons stop working after 5 minutes.

Every other Wild embed uses the same style: no colour, plain
title, no footer, no timestamp, one field per item — /status (one
field per section), /fg list (one field per FG role, with its owner),
the guard log embed (Role / Assigned by / Reason fields), and the FG
share offer (Role / From / To fields, with its Yes / No buttons). The
guard DM is an embed in the same style (Role / Member / Server /
Reason fields) that states what was removed and why — it never asks
you to get whitelisted.

## Prefix commands — read this first

Prefix replies **cannot be invisible**: Discord has no ephemeral
message replies, so a `,` reply is always visible in the channel.
That is a Discord limitation, not a bug. Wild mitigates it two ways:
your `,` command message is deleted after handling (best-effort), and
error replies auto-delete after 10 seconds (best-effort). Success
replies stay. Every reply is an embed, in the same colourless style as
the slash replies. If you need invisible errors, use the slash versions
instead.

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

The exceptions are the **server owner** and **Administrators**: their
grants are never reverted, same as the rest of the guard. If the audit
log cannot say who gave the role, the grant is still removed (fail
closed).

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
- **No award role.** Wild used to have one shared "award" role given
  on FG creation; it was removed because it was confusing.
- **Sharing FG roles.** Only these people can share an FG role: the
  server owner, whitelisted staff, the FG role's owner, and anyone the
  owner or staff authorised to share it. Staff give someone an FG role
  (and permission to share it) with `/fg assign`. An FG owner lets
  someone else share their role with `/fg auth add` — auth is
  permission to share, not the role itself.
- **Share is Wild-only.** Bleed documents no share command. In Wild,
  `/fg share` lets someone authorised to share an FG role offer it to
  a friend; the friend accepts or declines with buttons. All share
  errors are invisible (ephemeral) — only the offer itself is public,
  because the friend needs to see it.

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

- Slash commands are registered globally with a full overwrite on
  startup: the bot registers exactly `/protect`, `/whitelist`,
  `/status`, `/setup`, `/fg`, `/blacklist`, and `/help`, and removes any
  stale commands Discord still lists from older versions (`/wild`,
  `/roles`, `/watch`, `/enforcement`, `/logs`, `/commands`, `/fg staff`,
  `/fg access`, `/fg award`). The new list can take up to an hour to
  appear in Discord after a redeploy — and nothing updates until you
  redeploy the bot on Railway. The old `/logs` commands are gone,
  replaced by `/setup` and `,logchannel`. Prefix commands work as soon
  as the bot is online and Message Content Intent is enabled — no wait.
- The bot code lives in `scripts/src/`. The other workspace packages
  (`artifacts/`, `lib/`) are unrelated Replit scaffold and are not used
  by the bot.

Full setup and troubleshooting: see `scripts/WILD_BOT.md`.
