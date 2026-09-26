# Interconnection Watch

Tracks recent changes to generator interconnection procedures and power-system
study guidelines across the 11 major US and Canadian grid operators (PJM,
MISO, SPP, ERCOT, CAISO, NYISO, ISO-NE, IESO, AESO, Hydro-Québec, BC Hydro).

Fully automated: a weekly GitHub Actions job does the research and commits
new findings; GitHub Pages serves the dashboard and redeploys on every
commit. No server to run, no dependency on any local machine or app being
open.

## Architecture

```
index.html                          static dashboard (HTML/CSS/vanilla JS, fetches data/updates.json)
data/updates.json                   the data store — { meta, updates: [...] }
scripts/check-updates.mjs           the research job (Node + Anthropic SDK + web search tool)
.github/workflows/check-updates.yml weekly cron that runs the script and commits the result
package.json                        one dependency: @anthropic-ai/sdk
```

**Frontend (`index.html`):** on load, `fetch('data/updates.json')` and render.
All filtering (region / operator / category) and sorting happens client-side.
No build step, no framework.

**Data (`data/updates.json`):** a single JSON file, `{ meta, updates }` — see
"Data model" below. This is the thing that changes every week; everything
else is static.

**The agent (`scripts/check-updates.mjs`):** run by the GitHub Actions
workflow, not by hand. Each run:
1. Reads the current `data/updates.json`.
2. Splits the 11 operators into 3 groups (mirrors how this was originally
   researched) and, for each group, calls the Claude API with the
   `web_search` server tool, asking it to find anything new or revised since
   what's already logged (deduping by URL/title in the prompt itself).
3. Parses each group's structured JSON response, merges genuinely new
   findings into `updates` (dedup by URL, then by title), and flips old
   entries' `isRecentChange` to `false` once they're more than ~12 months old.
4. Writes `data/updates.json` back with an updated `meta` (last run date,
   totals, a one-line summary of what changed).

The workflow then commits `data/updates.json` if it changed. Pushing to
`main` is what triggers GitHub Pages to redeploy — so the live site updates
automatically within a minute or two of the job finishing, with nobody's
laptop or app needing to be open.

## One-time setup

You need: a GitHub account, and an Anthropic API key

1. **Create the repo** (GitHub web UI: New repository — public, so GitHub
   Pages can serve it for free; nothing in here is sensitive, it's all public
   utility filings), then from this folder:
   ```bash
   cd /Users/abhishek/interconnection-watch
   git init
   git add .
   git commit -m "Initial commit: Interconnection Watch"
   git branch -M main
   git remote add origin https://github.com/<you>/interconnection-watch.git
   git push -u origin main
   ```

2. **Add the API key as a repo secret** (Settings → Secrets and variables →
   Actions → New repository secret): name it `ANTHROPIC_API_KEY`, paste the
   key value. It's never exposed in logs or to anyone browsing the repo.

3. *(Optional)* **Choose the model**: the script defaults to `claude-opus-5`.
   To use the ~5x cheaper `claude-sonnet-5` instead (plenty capable for this
   task), add a repo **variable** (not secret) named `CHECK_MODEL` with value
   `claude-sonnet-5` (Settings → Secrets and variables → Actions → Variables
   tab).

4. **Enable GitHub Pages** (Settings → Pages → Source: "Deploy from a
   branch" → Branch: `main`, folder: `/ (root)` → Save). Your dashboard will
   be live at `https://<you>.github.io/interconnection-watch/` within a
   minute or two.

5. **Run it once manually** to populate a real first data point: Actions tab
   → "Check interconnection updates" → Run workflow. Check the Actions log
   for errors (most likely cause of a failure: the secret name doesn't match
   exactly, or the key is invalid).

After that, it just runs — every Monday at 8am IST (`.github/workflows/check-updates.yml`'s cron; edit the cron expression there to change cadence, cron is always UTC).

## Local preview

```bash
npm run serve
```

opens the dashboard at `http://localhost:5173` reading the committed
`data/updates.json`. Opening `index.html` directly via `file://` mostly
works too, *except* Chrome/Safari block `fetch()` of local files opened that
way — you'll see the amber "couldn't load data/updates.json" banner. Use a
local server (`npm run serve`, or `python3 -m http.server`) instead.

To run the research job locally (e.g. to test a prompt change before pushing):
```bash
npm install
ANTHROPIC_API_KEY=sk-ant-... npm run check
```
This edits `data/updates.json` in place — review the diff before committing.

## Data model

`data/updates.json`:
```json
{
  "meta": { "lastRun": "YYYY-MM-DD", "sourcesChecked": 11, "totalUpdates": 62, "notes": "..." },
  "updates": [
    {
      "id": "pjm-manual-14h",
      "entity": "PJM",
      "region": "US",
      "category": "Interconnection Procedure",
      "title": "PJM Manual 14H – New Service Requests Cycle Process",
      "url": "https://...",
      "date": "2026-08-19",
      "summary": "...",
      "isRecentChange": true,
      "detectedAt": "2026-09-26"
    }
  ]
}
```

| field            | notes                                                                |
|------------------|-----------------------------------------------------------------------|
| `entity`         | `PJM`\|`MISO`\|`SPP`\|`ERCOT`\|`CAISO`\|`NYISO`\|`ISO-NE`\|`IESO`\|`AESO`\|`HQ`\|`BCH` |
| `region`         | `US` or `CA`                                                         |
| `category`       | `Interconnection Procedure`\|`Study Guideline`\|`Tariff Filing`\|`Regulatory Filing`\|`Other` |
| `date`           | `YYYY-MM-DD`, a partial date, or `"unknown"`                         |
| `isRecentChange` | true while inside the trailing ~12-month "recent" window; the script ages these out automatically |
| `detectedAt`     | `YYYY-MM-DD` this tracker first logged it                           |

## Cost

Each weekly run makes 3 Claude API calls (one per operator group) with the
web search tool enabled. Rough ballpark on `claude-opus-5` ($5/$25 per 1M
input/output tokens): a few dollars per run depending on how much searching
each group needs; `claude-sonnet-5` ($2/$10 per 1M) cuts that by roughly
half-to-two-thirds for what's fundamentally a structured research-and-log
task. Switch models via the `CHECK_MODEL` repo variable (see setup step 3)
without touching code. GitHub Actions minutes and Pages hosting are free for
a public repo at this frequency.

## Known gaps

A handful of baseline entries have `date: "unknown"` — mostly IESO, whose
domain didn't resolve for the research pass that seeded this tracker in one
session. Treat any `unknown`-dated entry as needing a manual check against
its linked source before relying on it for filings or engineering work.

## Migrating from the previous (Claude Artifact) version

This project previously lived as a Claude Artifact (a claude.ai-hosted page
backed by Claude's `db` capability) updated by a local Claude Code scheduled
task. That version is now superseded — the scheduled task has been paused —
because Claude's Artifact database can only be written to by an interactive
Claude session, which meant updates depended on the desktop app being open.
This GitHub-based version runs independent of any app.
