# Wild — Discord Role Guard Bot

Wild protects selected server roles. When a protected role is added, it
checks Discord's audit log for who assigned it. If the assigner isn't
whitelisted, the bot removes the role, DMs the assigner to explain why,
and logs the removal. If it can't verify who assigned the role, it
removes the role by default (fail closed) instead of allowing an
unverified assignment.

The server owner and holders of the six staff admin roles (see
"Who is an admin" below) bypass the guard — their grants are never
reverted. The Discord Administrator permission alone grants nothing:
a member with Administrator but no staff admin role is treated like
any ordinary member. Repeat offenders (3+ unauthorised assignments)
are flagged in the log. Grants by whitelisted users are logged too
("Authorized role assignment", same alert channel, role stays, no DM)
— so the log shows who handed out watched roles, not just who tried
and failed. Owner, staff-admin, FG-owner and authorised-sharer grants
stay silent.

Wild is simple on purpose: seven slash commands, each with a "," prefix
version that works the same way. Every reply is an embed — confirmations
and errors are short invisible (ephemeral) embeds, only you can see them.
All embeds use no color at all (no accent bar, so they blend into the
chat background and look invisible), no footer, no timestamp. Prefix
replies are public (Discord has no invisible prefix replies): error
replies auto-delete after 10 seconds, other public replies after
1 minute 30 seconds. Interactive messages — share offers, the /fg
remove confirmation, paged help and blacklist lists — stay until
their buttons expire (5 minutes).

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
The server owner and holders of the six staff admin roles can use the
bot fully, exactly like each other. Who can use what: the guard
commands (`/protect`, `/whitelist`, `/status`, `/setup`,
`/blacklist add`, `/blacklist remove`, `/blacklist list`) need the
server owner, a staff admin role, a whitelisted member, or literal
Manage Server. `/fg base` and `/fg cleanup` need the server owner, a
staff admin role, or literal Manage Server. `/fg list` needs the
server owner, a staff admin role, a whitelisted member, or literal
Manage Server. `/fg create` and `/fg add` need the server owner, a
staff admin role, or a whitelisted member. `/fg color` needs an FG
role of your own. `/fg rename`, `/fg icon`, `/fg remove`,
`/fg share`, `/fg drop`, `/fg members`, and `/fg auth` work on your
own FG role (or one you can share). The Discord Administrator
permission alone grants nothing anywhere — see \"Who is an admin\"
below.

### Silent ignore

When someone who is not allowed uses an admin command, the bot sends
no reply at all — not even an ephemeral error. On slash it briefly
shows \"thinking\" (it defers, then deletes the deferred reply) and
then nothing; on prefix it simply never replies, and your command
message is still deleted as usual. This covers only authorisation
failures on admin commands (`/protect`, `/whitelist`, `/status`,
`/setup`, `/blacklist`, `/fg base`, `/fg create`, `/fg add`,
`/fg cleanup`, `/fg auth`). Functional errors still reply as before
(wrong usage, \"you don't have an FG role\", \"that role isn't an FG
role\", \"that member already has an FG role\", ...), and FG-owner
commands used by someone who qualifies for them still work — a
non-whitelisted admin who owns an FG role can still `/fg share` /
`/fg color` / `/fg auth` for their own role. Ignoring is reply-only:
the gates are still enforced server-side and nothing happens.

## Who is an admin

Bot admin access is the server owner, or a member holding one of these
six staff roles (baked into the bot, by role ID):

- 1569765098883391510
- 1572935769931255808
- 1528406720588546128
- 1528406720588546125
- 1528406720588546124
- 1572646478944407603

Those roles grant admin access wherever they exist. A server without
them has owner-only admin access. The Discord Administrator permission
alone grants nothing — a member with Administrator but no staff admin
role (and not the owner) is an ordinary member: their unauthorised
grants are reverted, they are silently ignored on admin commands (see
\"Silent ignore\" above), and they see only the plain-member help. There is
no command to change the six roles (a future option).

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
  under (owner, staff admin, or Manage Server).
- `/fg color <color> [second_color]` / `,fg color <color> [second_color]` —
  recolor your own FG role. One hex = solid, two = gradient, separated
  by a space or a comma. Colors are hex codes only: `#rrggbb`, `rrggbb`,
  `#rgb`, `rgb`, or `0xrrggbb` — any hex code works, so 16,777,216 colors
  are possible, no names. `random` picks a random color, `holographic`
  (alias `holo`) gives the role Discord's holographic style, and
  `dominant` uses the color of your profile picture. More than two
  colors is rejected. Gradients and holographic need the Enhanced Role
  Styles perk (3 server boosts on it); without it the role is made solid
  in the first color instead, and the bot says so. Anyone who owns an FG
  role can use it.
- `/fg create <name> [@member]` / `,fg create <name> [@member]` —
  create an FG role for yourself, or for a named member, and give it
  to them right away. The role takes
  the color of that member's profile picture; if the picture can't be
  read, it uses a default color instead. Needs an FG base role set
  first. Only the server owner, administrators, or whitelisted members
  can use it.
- `/fg add @role @member` / `,fg add @role @member` — add an
  existing role as an FG role for a named member, and give it to them
  right away. The member is required: the role belongs to whoever is
  named, never to the caller by default. No base role is needed. Same
  gates as `/fg create`.
- `/fg rename <name>` / `,fg rename <name>` — rename your own FG role.
- `/fg icon <url>` / `,fg icon <url>` — set your own FG role's icon
  (image link, emoji, or custom emoji).
- `/fg remove` / `,fg remove` — delete your own FG role. Asks for
  confirmation first with one line ("Delete @$ for good? Tap Yes to
  delete it.") and Yes/No buttons; nothing is deleted until you tap
  Yes.
- `/fg drop` / `,fg drop` — give back an FG role someone shared with
  you. No arguments; owners can't drop their own role (use `/fg remove`
  to delete it). Dropping frees your one-FG-role slot, so you can make
  your own afterwards.
- `/fg members` / `,fg members` — list the members of your FG role,
  owner first, plain names, one per line (25 max with a "+N more"
  line). The role is worked out from you, like `/fg share`.
- `/fg list` / `,fg list` — list all FG roles and their owners, one
  line per role: the role itself, then the owner's name (owner, staff
  admin, whitelisted, or Manage Server).
- `/fg cleanup` / `,fg cleanup` — remove FG roles whose owners left
  the server (owner, staff admin, or Manage Server).
- `/fg share @member` / `,fg share @member` — offer an FG role to a
  member (see "Sharing FG roles" below). The role is picked for you:
  your own FG role first, otherwise the one FG role you can share.
  The offer pings the member it is for, so they see it.
- `/fg auth add @member` / `,fg auth add @member` — let
  someone share one of your FG roles, without giving them the role
  (the FG role's owner, the server owner, staff admins, or whitelisted
  only). The role is worked out from you: your own FG role, or the one
  FG role you can share.
- `/fg auth remove @member` / `,fg auth remove @member` —
  take someone's permission to share an FG role away (same gate as
  auth add; the FG role owner themself can never be removed).
- `/fg auth list [@role]` / `,fg auth list [@role]` — list who can share
  an FG role, owner first (same gate as auth add). The role is optional:
  leave it out and the bot uses your FG role.
- `/blacklist add @user @role` / `,blacklist add @user @role` —
  blacklist a member from a protected role (owner, staff admin,
  whitelisted, or Manage Server).
- `/blacklist remove @user @role` / `,blacklist remove @user @role` —
  unblacklist them (owner, staff admin, whitelisted, or Manage Server).
- `/blacklist list` / `,blacklist list` — list the blacklist, 10 users
  per page with Prev/Next buttons (owner, staff admin, whitelisted, or
  Manage Server).
- `/help` / `,help` — show all commands, grouped by category.
  `/help fg` (or `,help fg`) shows one category; `/help fg create`
  shows just that command. A bare `,fg` or `,blacklist` just points at
  the help page now — no usage wall.

## Help

`/help` / `,help` opens a paged help menu — one colorless embed per
page, one field per command, plain text only, no emojis. Help shows
only the syntax for the form it was opened with: `/help` shows slash
forms, `,help` shows prefix forms. Each command is one field: the
syntax in backticks, then a short purpose line. There are no "Who:"
lines — help only ever shows the commands *you* can actually use,
worked out from your roles, your FG roles, and whether you are
whitelisted or an admin. Discord permissions never count: a member
with the Discord Administrator permission (or Manage Server) who is
not the owner, holds no staff admin role, and is not whitelisted sees
exactly what a plain member sees. If you cannot use a command, it is not on
your menu at all.

Who sees what: the server owner, holders of a staff admin role,
and whitelisted users / roles see the full menu (Guard, FG,
Blacklist). A member with the Discord Administrator permission but no
staff admin role and not whitelisted sees exactly what a plain member
sees — the FG category with the no-FG-role note when they hold no FG
role, no Guard, no Blacklist, and no fg base / fg cleanup / fg list;
if they hold an FG role or are a listed sharer, they see exactly what
a plain member holding that FG role sees, nothing more. An FG owner sees only FG — their own role's commands
(rename, icon, remove, drop), sharing, members, and auth. Someone
holding a shared FG role sees FG share, FG drop, and FG members;
someone authed to share one sees FG share and FG members. A normal member with no FG
role sees the FG category with the note "You don't have an FG role
yet — ask an admin or whitelisted member to create one for you." and no
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
       15 commands
  Blacklist — Block members from roles
              3 commands
  [Guard] [FG] [Blacklist]
```

Each category page lists its commands the same way — one field per
command, one purpose line:

```
Help - FG (1/3)
  `/fg base @role`
  Set the FG base role
  ...
  [Next] [Back]
```

FG has 15 subcommands, so it splits into 3 pages of 7, 7, and 1
("Help - FG (1/3)", "(2/3)", and "(3/3)") with Prev/Next buttons; the
page count is recomputed after filtering, so an FG owner sees their
10 commands across 2 pages. Guard and Blacklist fit on one page each.
`/help fg create` or `/help blacklist add` (`,help fg create` and so
on) shows just that one command: Syntax, What it does, and an
Example, with a Back button to its category page. Unknown topics get
a short error pointing at `/help`. Only the person who ran /help can
use its buttons — anyone else gets told to run /help for their own
menu — and the buttons stop working after 5 minutes.

Every other Wild embed uses the same style: no color, plain
title, no footer, no timestamp, one field per item — /status (one
field per section), /fg list (one line per FG role, with its owner),
the guard log embed (Role / Assigned by / Reason fields), and the FG
share offer (one line, with its Yes / No buttons). The
guard DM is an embed in the same style (Role / Member / Server /
Reason fields) that states what was removed and why — it never asks
you to get whitelisted. The FG share offer and the FG remove
confirmation are the exception: each is a single one-line embed with
no fields ("@sharer is offering @role to @member — tap Yes to accept."
and "Delete @role for good? Tap Yes to delete it.").

## Prefix commands — read this first

Prefix replies **cannot be invisible**: Discord has no ephemeral
message replies, so a `,` reply is always visible in the channel.
That is a Discord limitation, not a bug. Wild mitigates it two ways:
your `,` command message is deleted after handling (best-effort), and
error replies auto-delete after 10 seconds (best-effort). Success
replies stay. Every reply is an embed, in the same colorless style as
the slash replies. If you need invisible errors, use the slash versions
instead. Unauthorised use of an admin `,` command gets no reply at
all (see \"Silent ignore\" above) — the command message is still
deleted.

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

The exceptions are the **server owner** and **staff admins**: their
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

## Works side by side with Bleed and Greed

Wild guards roles granted through Bleed and Greed the same way as any
other grant. When either bot adds a role, Discord's audit log shows
that bot as the executor — but the bot passes a reason naming the
human who asked for it, so Wild reads that reason, checks that person
against the whitelist, and if they aren't authorised the role is
removed, they are DM'd, and it is logged — for FG and protected roles
alike. The two reason formats: Bleed writes "added role by <user>";
Greed writes "Role update by <name> (<user id>)". Wild uses the ID
when one is present — it is authoritative, since usernames can change
or be reused — and falls back to the name. If the reason is missing,
Wild falls back to attributing the grant to the FG role's owner; if
there is no one to attribute it to, the role is still removed and
logged, with no DM.

## FG roles — Bleed booster-role style

FG roles work like Bleed's booster roles: each member makes their own
unique, personal, cosmetic role that sits under one base role, and
customises it themselves (name, color, icon). Set the base once with
`/fg base`.

Wild adaptations (these are Wild rules, not Bleed behaviour):

- **Eligibility is being whitelisted, not boosting.** Bleed gates FG
  roles on boosting the server; Wild gates them on `/whitelist`
  instead.
- **One FG role per member.** A member can hold at most one FG role,
  whether it's their own or one shared with them. Make a second one
  only after removing the first with `/fg remove` (or giving a shared
  one back with `/fg drop`). Nobody who already
  holds more than one has any taken away — the rule only applies
  going forward.
- **No award role.** Wild used to have one shared "award" role given
  on FG creation; it was removed because it was confusing.
- **Sharing FG roles.** Only these people can share an FG role: the
  server owner, whitelisted staff, the FG role's owner, and anyone the
  owner or staff authorised to share it. `/fg share @member` offers
  the role automatically: your own FG role first, otherwise the one
  FG role you can share. If you can share more than one and own
  none, the bot says so and names them — it can't pick one for you.
  An FG owner lets someone else share their role with
  `/fg auth add` — auth is permission to share, not the role itself.
  The old `/fg assign` command was removed: sharing is the only way
  to give someone an existing FG role.
- **Share is Wild-only.** Bleed documents no share command. In Wild,
  `/fg share` lets someone authorised to share an FG role offer it to
  a friend; the friend accepts or declines with buttons. All share
  errors are invisible (ephemeral) — only the offer itself is public,
  because the friend needs to see it, and the offer pings them (the
  accepted/declined/expired message pings them too). When someone
  other than the owner shares the role and the friend accepts, the
  owner gets a one-line DM about it ("Sam shared your FG role My FG
  to Alex.").

FG roles are created with no permissions, are automatically protected,
and the audit-log guard applies to them like any other protected role —
even when an FG role is not listed under `/protect` (for example it was
made before auto-protect existed, or unprotected with `/protect`): any
grant by someone who is not the server owner, a staff admin,
whitelisted, the FG role's owner, or an authorised sharer is removed
instantly, including self-grants. Having Manage Roles alone never
authorises a grant. `/protect` cannot unprotect an FG role — FG roles
are always protected. If the bot cannot remove a role (its own role sits
below it, or it lost Manage Roles), the giver is DM'd that the removal
failed instead of being told the role was removed.
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
- Permission checks always fetch the member fresh from Discord, never
  from the bot's cache — so removing a staff admin role (or a whitelisted
  role) from someone takes effect immediately, with no restart. The bot
  does not need the Server Members privileged intent for this.
- On startup the bot re-checks the last 10 minutes of role-change audit
  entries, so a grant made while it was down (e.g. during a redeploy)
  is still caught. If the role is already gone by then, nothing happens
  — no DM, no log, no offence.
- If the guard ever ignores a role you expect it to watch, check that
  the bot actually knows it: `/fg list` shows the FG roles it knows.
  An FG role made by another bot is not an FG role to Wild until you
  protect it with `/protect @role`.
- If a prefix command answers "The bot couldn't complete that command",
  check the Railway logs for `[wild] prefix command failed:` — the log
  line names the real error, with its Discord error code and HTTP
  status. A stale deploy is not the cause for `,fg share`: the share
  handler is identical across the last several builds (verified by
  diffing them), the offer payload resolves cleanly through discord.js,
  and the failures seen were Discord API failures on sending the offer
  itself (worked once, failed three times, with full permissions). The
  offer send is now retried once for retryable errors (a 4xx is never
  retried), and the share path names the failed step in its own reply
  instead ("Couldn't send the FG role offer...") and logs
  `[wild] fg share: ...` with the error code. Nothing on the live bot
  changes until you redeploy, so do still redeploy after a push to get
  the new build — but redeploying alone does not fix a share failure.

Full setup and troubleshooting: see `scripts/WILD_BOT.md`.
