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

## Git

Commit and push as `jnanottamgy`. Do not add AI attribution (no `Co-Authored-By`, session links, or "Generated with" lines) to commits, PRs or comments.
