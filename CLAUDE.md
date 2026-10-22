# CLAUDE.md

TaxWise CRM — built for TaxWise Consultants (https://www.twchartered.com), a finance and tax advisory firm.

## Installed design skills (`.claude/skills/`)

| Skill | Source | Use for |
|---|---|---|
| `ui-ux-pro-max` | nextlevelbuilder/ui-ux-pro-max-skill | UI styles, palettes, font pairings, UX rules, stack guidelines |
| `design`, `design-system`, `ui-styling`, `brand`, `banner-design`, `slides` | nextlevelbuilder/ui-ux-pro-max-skill | Companion design skills |
| `taste-skill` (`design-taste-frontend`) | leonxlnx/taste-skill | High-taste frontend direction, motion, layout |

### UI UX Pro Max search

```bash
python3 .claude/skills/ui-ux-pro-max/scripts/search.py "<query>" --domain <domain> [-n <max_results>]
python3 .claude/skills/ui-ux-pro-max/scripts/search.py "<query>" --design-system [-p "TaxWise CRM"]
python3 .claude/skills/ui-ux-pro-max/scripts/search.py "<query>" --stack <stack>
```

Domains: `product`, `style`, `typography`, `color`, `landing`, `chart`, `ux`, `icons`, `react`, `web`, `google-fonts`, `gsap`.
Upstream developer notes: `.claude/skills/ui-ux-pro-max/UPSTREAM-CLAUDE.md`.

## Building the app

- Product spec: `docs/SPEC.md` (cite as §n). Engineering conventions: `docs/CONVENTIONS.md`. Design brief: `docs/DESIGN.md`.
- Stack: Next.js 16.4 (proxy.ts, async params/cookies, cacheComponents off), React 19, Tailwind v4, shadcn/ui (Radix), Supabase, zod 4, Vitest 5.
- Server actions use `defineAction` (`lib/action.ts`); roles come from `profiles.role` only; the service-role key lives only in `server/admin.ts`.
- Local DB: Postgres 16 + Supabase shim (`tests/db/shim/`), `npm run db:reset`, `npm run test:db`.
- UI work: follow `docs/DESIGN.md`; use the `ui-ux-pro-max` and `taste-skill` (app-screens) skills for UI/UX decisions.

## Git

Commit and push as `jnanottamgy`. Do not add AI attribution (no `Co-Authored-By`, session links, or "Generated with" lines) to commits, PRs or comments.
