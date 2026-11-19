# Discord Role Guard Bot

The bot protects selected Discord roles, checks who assigned them, and removes unauthorized assignments. It also manages FG roles with per-role assignment and sharing allowlists.

## Run & Operate

- `pnpm --filter @workspace/api-server run dev` — run the API server (port 5000)
- `pnpm --filter @workspace/scripts run wild` — run the Discord bot directly
- `pnpm run build:wild` — compile the bot for Railway
- `pnpm run start:wild` — run the compiled Railway build
- `pnpm --filter @workspace/scripts run typecheck` — check the bot package
- `pnpm --filter @workspace/scripts run test` — test the bot package
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

- `scripts/src/wild.ts` starts the bot and registers `/wild`, `/commands`, and `/fg`.
- `scripts/src/wild/` contains role protection, FG-role sharing, configuration, embeds, and the role browser.
- `scripts/WILD_BOT.md` documents Discord permissions, FG roles, and Railway setup.
- `data/wild-config.json` stores server settings locally and is ignored by Git.

## Architecture decisions

- A regular protected-role assignment is allowed only when its audit-log actor is explicitly allowlisted by member or role.
- FG roles have separate staff and per-role assign/share allowlists.
- The bot uses Discord audit-log events to verify role assignments and Message Content Intent for `,fg share`.
- Server configuration is stored as a small, atomically written JSON file; keep that file on persistent storage in hosted deployments.

## Product

- Paginated, sortable role browser with a compact Discord embed.
- Per-server protected-role and member/role allowlists.
- FG staff, role assignment, and acceptance-button sharing flows.
- Optional moderation alerts and permission status.

## User preferences

- No additional user preferences recorded.

## Gotchas

- The bot needs Manage Roles and View Audit Log. It also needs Message Content Intent for `,fg share`.
- Move the bot's role above every role it needs to manage.

## Pointers

- See the `pnpm-workspace` skill for workspace structure, TypeScript setup, and package details
