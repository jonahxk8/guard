# Wild Discord bot

Wild protects selected server roles. When a watched role is added, it checks Discord's audit log to identify the assigner. Allowlisted users can assign watched roles; any other assigner is removed from the role. If Wild cannot verify the audit entry, it removes the role rather than silently allowing an unverified assignment.

## First setup

1. Create a Discord application and bot in the Discord Developer Portal.
2. Keep the bot token in Replit Secrets as `DISCORD_BOT_TOKEN`. Never paste it into chat or commit it to a file.
3. Start the **Wild Discord Bot** workflow. Its logs show an invite link with the required bot permissions.
4. Invite Wild, then move Wild's bot role above every role it should protect.
5. Make sure Wild has **Manage Roles** and **View Audit Log**. It also needs **View Channel**, **Send Messages**, and **Embed Links** for the optional alert channel.
6. Run `/wild allow add user:@member` for each person who may assign watched roles. Admins aren't automatically allowlisted.
7. Run `/wild watch add role:@role` for each role to protect.
8. Optionally set alerts with `/wild logs set channel:#mod-logs`.

Wild listens for Discord audit-log events. If the actor is not allowlisted, it removes the watched role. Discord's role hierarchy must let Wild manage that role.

## Commands

- `/wild roles` — paginated role browser with role-order/A–Z sorting.
- `/wild status` — protection and permission status.
- `/wild watch add|remove|list` — manage protected roles.
- `/wild allow add|remove|list` — manage authorized assigners.
- `/wild logs set|clear` — configure optional moderation alerts.

Only members with **Manage Server** may change Wild's configuration. The role browser is available to everyone.

## Running and checks

- `pnpm --filter @workspace/scripts run wild` — start the bot.
- `pnpm --filter @workspace/scripts run typecheck` — check the TypeScript sources.

Configuration is stored in `data/wild-config.json` and can be relocated with `WILD_CONFIG_PATH`.
