# Wild — Discord Role Guard Bot

Wild protects selected server roles. When a protected role is added, it
checks Discord's audit log for who assigned it. If the assigner isn't
allowlisted, the bot removes the role, DMs the assigner to explain why,
and logs the removal. If it can't verify who assigned the role, it
removes the role by default (fail closed) instead of allowing an
unverified assignment.

The server owner bypasses the guard — the owner's own grants are never
reverted. Repeat offenders (3+ unauthorised assignments) are flagged in
the log.

## Discord setup

1. Create a Discord application and bot in the Discord Developer Portal.
2. Set `DISCORD_BOT_TOKEN` in your host's secrets / environment variables.
   Never paste the token into chat or commit it.
3. Enable the **Message Content Intent** in the Developer Portal;
   `,fg share` uses message content.
4. Invite the bot with Manage Roles, View Audit Log, View Channel,
   Send Messages, and Embed Links.
5. Move the bot's role above every role it needs to manage.
6. Run `/wild allow add user:@member` (or `role:@role`) to authorise
   assigners, then `/wild watch add role:@role` for each role to protect.
7. Optionally set alerts with `/wild logs set channel:#mod-logs`.

Administrator roles can never be protected or assigned through the bot,
and `/wild roles` requires Manage Server. All embeds are black
(colour 0, no footer, no timestamp).

## Commands

- `/commands` — list command names.
- `/wild roles` — browse server roles (Manage Server required).
- `/wild status` — view protection status, including any protected or FG
  roles the bot can't manage.
- `/wild watch add|remove|list` — manage protected roles.
- `/wild allow add|remove|list` — allow members or roles to assign
  protected roles.
- `/wild enforcement pause|resume` — pause or resume automatic removal.
- `/wild logs set|clear` — configure guard alerts.
- `/fg staff add|remove|list` — manage FG staff.
- `/fg roles create|assign|list` — create and assign FG roles. FG roles
  are created with no permissions.
- `/fg access add|remove|list` — per-FG-role assign/share access.
- `,fg share @member` — offer one of your FG roles to a member.

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

- Slash commands are registered globally, so `/wild`, `/commands`, and
  `/fg` can take up to an hour to appear in Discord after the bot first
  starts.
- The bot code lives in `scripts/src/`. The other workspace packages
  (`artifacts/`, `lib/`) are unrelated Replit scaffold and are not used
  by the bot.

Full setup and troubleshooting: see `scripts/WILD_BOT.md`.
