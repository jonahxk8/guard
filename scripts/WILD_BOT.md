# Discord bot setup

The bot protects selected server roles. It checks Discord's audit log when a protected role is added and removes unauthorized assignments. If it cannot verify the assigner, it removes the role rather than allowing an unverified assignment.

## Discord setup

1. Create a Discord application and bot in the Discord Developer Portal.
2. Add the bot token as `DISCORD_BOT_TOKEN` in the host's secrets or environment-variable settings. Never paste it into chat or commit it.
3. Enable the **Message Content Intent** in the Discord Developer Portal; `,fg share` uses message content.
4. Start the **Wild Discord Bot** workflow on Replit, or follow the Railway setup below.
5. Invite the bot with the required scopes and permissions shown in its startup logs.
6. Move the bot's role above every role it needs to manage.
7. Give it **Manage Roles** and **View Audit Log**. It also needs **View Channel**, **Send Messages**, and **Embed Links** in the alert channel.
8. Run `/wild allow add user:@member` or `/wild allow add role:@role` to authorize assigners for regular protected roles. Admins are not automatically allowlisted.
9. Run `/wild watch add role:@role` for each regular role to protect.
10. Optionally set alerts with `/wild logs set channel:#mod-logs`.

The bot listens for Discord audit-log events. If the actor is not allowlisted, it removes the protected role. Discord's role hierarchy must let the bot manage that role.

## Commands

- `/commands` — list command names.
- `/wild roles` — browse server roles.
- `/wild status` — view protection and permission status.
- `/wild watch add|remove|list` — manage protected roles.
- `/wild allow add|remove|list` — allow members or roles to assign regular protected roles.
- `/wild enforcement pause|resume` — pause or resume automatic removal.
- `/wild logs set|clear` — configure optional guard alerts.
- `/fg staff add|remove|list` — manage the people and roles allowed to create and assign FG roles. Manage Server is required.
- `/fg roles create` — create an FG role; only FG staff can create one.
- `/fg roles assign` — assign an FG role; FG staff or that FG role's assign list can do this.
- `/fg roles list` — list created FG roles.
- `/fg access add|remove|list` — configure per-FG-role assignment and sharing access.
- `,fg share @member` — offer one of your FG roles to a member. The mentioned member accepts or declines with buttons. You must hold that FG role and be on its share allowlist.

Members with **Manage Server** can configure regular role protection. FG staff create FG roles; each FG role's staff and per-role allowlists control assignment and sharing. Manage Server members or FG staff can maintain the FG access lists.

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

Configuration is stored in `data/wild-config.json` by default and can be relocated with `WILD_CONFIG_PATH`.
