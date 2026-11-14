# Axowsky's Anime List

A one-page personal anime profile: my list from [OglądajAnime](https://ogladajanime.pl/anime_list/194074), enriched with [MyAnimeList](https://myanimelist.net) data, with my own tier-based rating system on top.

Live: <https://axo86.pages.dev>

Everything runs on free tiers that need no credit card and do not pause when idle.

## How it works

```
data/import/*.csv ─┐
                   ├─► scripts/sync.ts ─► data/anime.json ─► astro build ─► Cloudflare Pages
OA public list ────┘        │
                            └─► Jikan (MAL), AniList as backup ⇄ data/mal-cache.json

Browser ─► /api/annotations (Pages Function) ─► D1      refined scores, reviews, tags
/admin  ─► GitHub sign-in ─► PUT /api/annotations/:key  (owner only)
```

- **List data** (title, status, score, progress, type, date added) comes only from OglądajAnime: the CSV export, plus one polite request per run for the public list page, which also carries the slug and the date added that the CSV lacks. OA anime pages are never fetched.
- **Everything else** (covers, genres, studios, episode length, MAL score, links) comes from MyAnimeList through the keyless [Jikan API](https://jikan.moe), cached in `data/mal-cache.json`.
- **Backup source.** When Jikan is unreachable, the sync asks [AniList](https://anilist.co) instead (also free and keyless). AniList entries carry their MAL id, so titles are still keyed by and linked to MAL. See "When Jikan is down" below.
- **Annotations** (refined score, review, tags, favorite character) live in a Cloudflare D1 database. The page is built with the annotations that exist at build time and re-checks the API on load, so an edit shows up without a rebuild.

## Stack

| Part | Choice | Why |
| --- | --- | --- |
| Site | [Astro](https://astro.build) + TypeScript (strict), static output | Plain HTML and CSS, one small script for search, filters and the theme |
| Hosting + API | Cloudflare Pages + Pages Functions | Free, never sleeps, static files and API on one platform |
| Database | Cloudflare D1 (SQLite) | Free, does not pause on inactivity (Supabase's free tier does; Turso would mean a second vendor) |
| Admin sign-in | GitHub OAuth, restricted to one account | No passwords to store. Cloudflare Access is supported as an alternative (see below) |
| Sync | GitHub Actions | Free for public repositories |
| Charts | Hand-written HTML/CSS/SVG | No chart library to download |
| Font | Inter Variable, self-hosted | One family, no third-party font requests |
| Tests | Vitest + Playwright (+ axe) | Unit tests for the data logic, end-to-end smoke tests against the real Pages runtime |

## Updating the list

Three ways, most reliable first:

1. **Export a CSV.** On OglądajAnime open your list, press the export button, put the file in `data/import/` and push. The newest file (by the date in its name) is used. Pushing a CSV starts the sync right away.
2. **Run the sync on your own computer** (`npm run sync`, then commit and push `data/`). From a home connection the public list page loads fine, and it also carries the date added, which the CSV does not have.
3. **Wait for the daily run.** The `Sync anime list` workflow runs every day and asks OglądajAnime for the public list once. At the time of writing OglądajAnime answers GitHub's servers with HTTP 403, so the scheduled run keeps the last known list and only refreshes MAL data. It logs the refusal and never tries to get around it. If OglądajAnime stops refusing, list changes will be picked up daily with no further work.

You can also run it by hand: GitHub → Actions → *Sync anime list* → *Run workflow*, or locally:

```bash
npm run sync               # full run
npm run sync -- --no-oa    # do not contact OglądajAnime, use the CSV
npm run sync -- --offline  # no network at all
```

The sync commits `data/anime.json` only when something changed, and then starts the deploy.

Status mapping: Oglądam → Watching, Obejrzane → Completed, Planuje → Plan to Watch, Wstrzymane → On Hold, Porzucone → Dropped. OA's "Nie oglądam" (progress without a list status) becomes Completed when every episode is watched, otherwise On Hold.

## Fixing a wrong MAL match

`data/unmatched.md` lists every title that was matched with low confidence or not at all, with the runner-up candidate. To fix one, add its OglądajAnime slug (or exact title) and the right MAL id to `data/overrides.json`:

```json
{
  "86-eighty-six-2nd-season": 48569,
  "Some Exact OA Title": 12345,
  "a-title-that-is-not-on-mal": null
}
```

Push the file (this starts the sync) or run `npm run sync`. The MAL id is the number in the MAL URL: `myanimelist.net/anime/48569/...`.

## When Jikan is down

Jikan is a volunteer-run service and has outages. The sync then falls back to AniList for every title it still needs:

- Titles are matched with the same rules and keep their MAL id, so links and annotation keys do not change.
- Covers, genres, studios, episode counts and lengths come from AniList. Its genre list differs a little from MAL's.
- There is no MAL score in that data, so the MAL score column and the "Sort: MAL score" option are hidden until at least one MAL score is known.
- On the first run where Jikan answers again, every entry that only has AniList data is replaced with MAL data, and titles AniList could not match confidently are searched again on Jikan. Nothing needs to be done by hand.

`data/unmatched.md` says how many titles currently use backup data.

## Editing annotations

Open `/admin`, sign in with GitHub, find the title, open its row and edit:

- **Refined score** (1–100): replaces the converted OA score.
- **Tags**: comma separated, shown as chips.
- **Review**: shown inline on the list as an expandable line.
- **Favorite character**: free text.

Annotations are keyed by MAL id (`mal:123`), falling back to the OA slug (`oa:some-slug`), so they survive title changes and removals on OglądajAnime.

## Changing the rating system

Thresholds, tier names and labels are in [`src/config/rating.ts`](src/config/rating.ts). Tier colors are in [`src/styles/tokens.css`](src/styles/tokens.css) as `--tier-<id>-bg`, `-fg` and `-solid`, each defined once for both themes with `light-dark()`.

| Score | Tier | Label |
| --- | --- | --- |
| 95–100 | S+ | Masterpiece |
| 90–94 | S | Exceptional |
| 80–89 | A | Great |
| 70–79 | B | Good |
| 60–69 | C | Decent |
| 50–59 | D | Mediocre |
| 1–49 | F | Bad |

The final score is the refined score when set, otherwise the OA score × 10. A score on a Plan to Watch entry is shown in the list but left out of the Top 10, the mean score and the tier chart.

## Local development

```bash
npm install
npm run dev                # Astro dev server (no API)
npm run build              # static build into dist/
npm run db:migrate:local   # create the local D1 database
npm run pages:dev          # dist/ + Pages Functions + local D1 on http://localhost:8788
npm test                   # unit tests
npm run test:e2e           # builds, starts wrangler, runs Playwright
npm run check              # type check
```

For `/admin` locally, copy `.dev.vars.example` to `.dev.vars` and fill it in.

## Deployment

One-time setup:

1. **D1 database**: `npx wrangler login`, then `npx wrangler d1 create axo86-annotations`. Copy the printed `database_id` into `wrangler.toml`, then `npm run db:migrate`.
2. **Pages project**: Cloudflare dashboard → Workers & Pages → Create → at the bottom, "Looking to deploy Pages? Get started" → Import an existing Git repository → pick this repository. Project name `axo86`, build command `npm run build`, output directory `dist`. The D1 binding and `ADMIN_GITHUB_ID` are read from `wrangler.toml`.
3. **Deploy token**: the `Deploy` workflow builds the site in GitHub Actions and uploads it with wrangler, on every push to `main` and after every sync that changed the data. It needs two repository secrets:
   - `CLOUDFLARE_API_TOKEN`: Cloudflare dashboard → My Profile → API Tokens → Create Token → Custom token → permission *Account · Cloudflare Pages · Edit*.
   - `CLOUDFLARE_ACCOUNT_ID`: the account id shown on the Workers & Pages overview.

   Set them with `gh secret set CLOUDFLARE_API_TOKEN` and `gh secret set CLOUDFLARE_ACCOUNT_ID` (each prompts for the value). Until they are set the workflow only prints a warning.
4. **Admin sign-in**: see the next section.

After that, every push to `main` and every data change deploys. Cloudflare's own Git-triggered builds are not relied on: in this project they did not start on push, and the workflow makes the deploy visible next to the sync that caused it.

### Admin setup (GitHub sign-in)

1. GitHub → Settings → Developer settings → OAuth Apps → *New OAuth App*.
   - Homepage URL: `https://axo86.pages.dev`
   - Authorization callback URL: `https://axo86.pages.dev/api/auth/callback`
2. Copy the Client ID, generate a client secret.
3. Store the three secrets in the Pages project (each command prompts for the value, nothing is written to the repository):

```bash
npx wrangler pages secret put GITHUB_CLIENT_ID --project-name axo86
npx wrangler pages secret put GITHUB_CLIENT_SECRET --project-name axo86
npx wrangler pages secret put SESSION_SECRET --project-name axo86
```

For `SESSION_SECRET` use any long random string, for example the output of `node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"`.

Only the GitHub account whose numeric id equals `ADMIN_GITHUB_ID` in `wrangler.toml` can sign in. The session is a signed, HttpOnly, `__Host-` cookie that lasts 7 days. The server checks it on `/admin` and on every write; writes also require a same-origin request. Until the secrets are set, `/admin` and the write API refuse everything.

### Alternative: Cloudflare Access

If you prefer Cloudflare Access (Zero Trust), create an Access application covering `/admin` and `/api/annotations/*` and set `ACCESS_TEAM_DOMAIN` (for example `your-team.cloudflareaccess.com`) and `ACCESS_AUD` (the application's audience tag). When both are set, the API verifies the Access JWT on every request instead of using GitHub sign-in. Note that enabling Zero Trust may ask for a payment method even on the free plan, which is why GitHub sign-in is the default here.

## Environment variables and secrets

| Name | Where | Secret | Purpose |
| --- | --- | --- | --- |
| `SESSION_SECRET` | Pages secret | yes | Signs the admin session cookie |
| `GITHUB_CLIENT_ID` | Pages secret | no, but kept with the others | GitHub OAuth app id |
| `GITHUB_CLIENT_SECRET` | Pages secret | yes | GitHub OAuth app secret |
| `ADMIN_GITHUB_ID` | `wrangler.toml` `[vars]` | no | Numeric id of the GitHub account allowed to sign in |
| `CLOUDFLARE_API_TOKEN` | GitHub repository secret | yes | Lets the Deploy workflow upload to Cloudflare Pages (Pages: Edit only) |
| `CLOUDFLARE_ACCOUNT_ID` | GitHub repository secret | no, but kept out of the public repo | Which Cloudflare account to deploy to |
| `ACCESS_TEAM_DOMAIN`, `ACCESS_AUD` | Pages variables | no | Only for the Cloudflare Access alternative |
| `BAKE_ANNOTATIONS` | build environment | no | Set to `0` to build without fetching annotations (used by the tests) |
| `DB` | `wrangler.toml` D1 binding | no | The annotations database |

The sync itself needs no secrets: it uses the built-in `GITHUB_TOKEN` to commit. No secret is ever committed; `.dev.vars` and `.env*` are git-ignored.

## Free tiers used

Limits as published at the time of writing. This site uses a tiny fraction of each.

| Service | Used for | Free limit | Card needed | Pauses when idle |
| --- | --- | --- | --- | --- |
| Cloudflare Pages | Hosting, `*.pages.dev` subdomain | Unlimited static requests and bandwidth, 500 builds per month | No | No |
| Cloudflare Pages Functions | Annotations API, sign-in | 100,000 requests per day | No | No |
| Cloudflare D1 | Annotations | 5 GB storage, 5 million rows read and 100,000 rows written per day | No | No |
| GitHub (public repository) | Code, Actions | Actions minutes are free for public repositories | No | Scheduled workflows are switched off after 60 days without repository activity |
| GitHub OAuth app | Admin sign-in | Free | No | No |
| Jikan API | MAL metadata | No key; 3 requests per second, 60 per minute | No | No |
| AniList API | Backup metadata when Jikan is down | No key; 90 requests per minute (30 while AniList runs in its degraded mode) | No | No |
| MyAnimeList CDN, AniList CDN | Cover images | Hot-linked, lazy-loaded | No | No |

About the 60-day rule: the sync makes a small "heartbeat" commit to `data/sync-meta.json` when nothing else has changed for 30 days, so the schedule stays active on its own.

## Project layout

```
data/            import/ (CSV exports), anime.json, mal-cache.json, overrides.json, unmatched.md, sync-meta.json
scripts/         sync.ts and its parsers, matcher, Jikan and AniList clients; postbuild.ts (security headers); screenshot helpers
src/config/      rating.ts (tiers), site.ts
src/lib/         shared model, filtering, HTML templates used by both the build and the browser
src/pages/       index.astro, admin.astro, 404.astro, data.json.ts
src/styles/      tokens.css (OKLCH design tokens), global.css
functions/       Cloudflare Pages Functions: /api/annotations, /api/auth/*, /admin gate
server/          auth and database code used by the functions
migrations/      D1 schema
tests/           unit/ (Vitest), e2e/ (Playwright)
```

## Decorative motifs

Three original, abstract SVG motifs, each drawn from simple geometry and themed through `currentColor`:

- **Dawn arcs** behind the header and in the favicon, after *Akatsuki no Yona*.
- **Woven threads** as section dividers, after *Maquia*.
- **Spider lily** for empty states, after *86: Eighty Six*.

No character likenesses, logos or official artwork are used.
