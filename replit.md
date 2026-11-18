# Wild Discord Role Guard

Wild is a Discord bot that protects selected server roles, checks who assigned them, and removes watched roles from users who are not on the allowlist.

## Run & Operate

- `pnpm --filter @workspace/api-server run dev` — run the API server (port 5000)
- `pnpm --filter @workspace/scripts run wild` — run the Wild Discord bot
- `pnpm --filter @workspace/scripts run typecheck` — check the bot package
- `pnpm run typecheck` — full typecheck across all packages
- `pnpm run build` — typecheck + build all packages
- `pnpm --filter @workspace/api-spec run codegen` — regenerate API hooks and Zod schemas from the OpenAPI spec
- `pnpm --filter @workspace/db run push` — push DB schema changes (dev only)
- Required env: `DATABASE_URL` — Postgres connection string

## Stack

- pnpm workspaces, Node.js 24, TypeScript 5.9
- Discord bot: discord.js 14, TypeScript
- API: Express 5
- DB: PostgreSQL + Drizzle ORM
- Validation: Zod (`zod/v4`), `drizzle-zod`
- API codegen: Orval (from OpenAPI spec)
- Build: esbuild (CJS bundle)

## Where things live

- `scripts/src/wild.ts` starts the bot and registers the `/wild` commands.
- `scripts/src/wild/` contains role protection, configuration, embeds, and the role browser.
- `scripts/WILD_BOT.md` documents Discord permissions and setup.
- `data/wild-config.json` stores server settings locally and is ignored by Git.

## Architecture decisions

- A role assignment is allowed only when its audit-log actor is explicitly allowlisted.
- Wild uses Discord audit-log events to verify role assignments without the privileged Server Members Intent.
- Server configuration is stored as a small, atomically written JSON file; the bot token stays in Replit Secrets.

## Product

- Paginated, sortable role browser with a compact Discord embed.
- Per-server protected-role and allowed-user lists.
- Optional moderation alerts and permission status.

## User preferences

- No additional user preferences recorded.

## Gotchas

- Wild needs Manage Roles and View Audit Log. Its gateway subscription uses Discord's guild moderation events rather than the privileged Server Members Intent.
- Move Wild's bot role above every role it needs to manage.

## Pointers

- See the `pnpm-workspace` skill for workspace structure, TypeScript setup, and package details
