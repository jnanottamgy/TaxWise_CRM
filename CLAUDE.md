# CLAUDE.md

TaxWise CRM — built for TaxWise Consultants (https://www.twchartered.com), a finance and tax advisory firm.

## Installed design skills (`.claude/skills/`)

| Skill | Source | Use for |
|---|---|---|
| `ui-ux-pro-max` | nextlevelbuilder/ui-ux-pro-max-skill | UI styles, palettes, font pairings, UX rules, stack guidelines |
| `design`, `design-system`, `ui-styling`, `brand`, `banner-design`, `slides` | nextlevelbuilder/ui-ux-pro-max-skill | Companion design skills |
| `taste-skill` (`design-taste-frontend`) | leonxlnx/taste-skill | High-taste frontend direction, motion, layout |
| `hyperframes`, `hyperframes-cli`, `hyperframes-registry`, `media-use`, `figma`, `slideshow`, `style-sampling`, `reverse-any-video`, `remotion-to-hyperframes`, `motion-doctrine`, `cut-the-curve`, `seam-craft`, `oversized-cursor`, `captions-overlay`, `changelog-video` | heygen-com/hyperframes | Video made from HTML (HyperFrames) |
| `remotion-best-practices`, `remotion-create`, `remotion-render`, `remotion-studio`, `remotion-captions`, `remotion-markup`, `remotion-interactivity`, `remotion-multimedia`, `remotion-maps`, `remotion-saas`, `remotion-docs`, `remotion-upgrade`, `remotion-license` | remotion-dev/skills | Remotion's official skills |
| `video-use`, `manim-video` | browser-use/video-use | Editing video by conversation; Manim explainers |
| `video-toolkit`, `remotion`, `ffmpeg`, `moviepy`, `blender`, `elevenlabs`, `acestep`, `ltx2`, `ideogram4`, `qwen-edit`, `runpod`, `playwright-recording`, `synthetic-ui-demo`, `video-design`, `parody-short`, `youtube-stats` | digitalsamba/claude-code-video-toolkit | Video production toolkit (its `remotion-official` is the same as `remotion-best-practices`, so it was left out) |
| `explainer`, `split-screen`, `storytelling`, `ranking-list`, `trial-reels`, `behind-the-person`, `orbit-reel`, `picture-stack`, `scene-switch`, `shape-shift`, `visual-notes` | artemnovitckii/claude-editing-skills | 9:16 talking-head reel edits |

Video skills need their own tools when used (ffmpeg, Python, Node, and for some an API key: ElevenLabs, HeyGen, Gemini and the like). Keys go in the environment, never in the repository.

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
