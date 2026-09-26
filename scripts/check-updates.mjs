// Weekly research job: checks 11 US/Canada grid operators for new or revised
// interconnection-procedure and power-system study guideline documents, and
// merges genuine findings into ../data/updates.json.
//
// Run via `node scripts/check-updates.mjs` (from the repo root) with
// ANTHROPIC_API_KEY set. Invoked by .github/workflows/check-updates.yml on a
// weekly cron; the workflow commits whatever this script writes.

import Anthropic from "@anthropic-ai/sdk";
import { readFileSync, writeFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_PATH = join(__dirname, "..", "data", "updates.json");

// Opus 5 by default per house style — swap to "claude-sonnet-5" (env MODEL)
// for a ~5x cheaper run if weekly Opus cost is a concern; Sonnet is plenty
// capable for this kind of structured research-and-log task.
const MODEL = process.env.MODEL || "claude-opus-5";
const MAX_TOKENS = 16000;
const RECENT_WINDOW_DAYS = 365;

const client = new Anthropic(); // reads ANTHROPIC_API_KEY from env

const GROUPS = [
  {
    key: "us-east-central",
    entities: ["PJM", "MISO", "NYISO", "ISO-NE"],
    brief: `PJM Interconnection (pjm.com, planning.pjm.com — Manuals 14A/14B/14D/14G/14H), MISO (misoenergy.org — Attachment X GIP, BPM-015), NYISO (nyiso.com — Manual 23, OATT Attachment X/Z), ISO-NE (iso-ne.com — Schedule 22/23, Planning Procedures).`,
  },
  {
    key: "us-south-west",
    entities: ["SPP", "ERCOT", "CAISO"],
    brief: `SPP (spp.org — OATT Attachment V GIP, Planning Criteria, GI Manual Business Practice), ERCOT (ercot.com — Nodal Protocols §3, Planning Guide, NPRR/PGRR tracker — not FERC-jurisdictional), CAISO (caiso.com — Appendix DD/S GIP/SGIP, Tariff, Planning Standards).`,
  },
  {
    key: "canada",
    entities: ["IESO", "AESO", "HQ", "BCH"],
    brief: `IESO Ontario (ieso.ca — Market Rules Ch.4, Market Manual 1.4, ORTAC), AESO Alberta (aeso.ca — ISO Rules §5, Connection Process), Hydro-Québec TransÉnergie (hydroquebec.com — connection technical requirements, E.12-01) [entity code "HQ"], BC Hydro (bchydro.com — Technical Interconnection Requirements, Transmission System Studies Guide) [entity code "BCH"].`,
  },
];

const VALID_ENTITIES = new Set(["PJM", "MISO", "SPP", "ERCOT", "CAISO", "NYISO", "ISO-NE", "IESO", "AESO", "HQ", "BCH"]);
const VALID_CATEGORIES = new Set(["Interconnection Procedure", "Study Guideline", "Tariff Filing", "Regulatory Filing", "Other"]);

function today() {
  return new Date().toISOString().slice(0, 10);
}

function slugify(s) {
  return (s || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
}

function normalizeUrl(u) {
  return (u || "").trim().replace(/\/$/, "").toLowerCase();
}

function normalizeTitle(t) {
  return (t || "").trim().toLowerCase().replace(/\s+/g, " ");
}

function extractJsonArray(text) {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const candidate = fenced ? fenced[1] : text;
  const start = candidate.indexOf("[");
  const end = candidate.lastIndexOf("]");
  if (start === -1 || end === -1 || end < start) return null;
  try {
    return JSON.parse(candidate.slice(start, end + 1));
  } catch {
    return null;
  }
}

async function researchGroup(group, existingUpdates) {
  const existingForGroup = existingUpdates.filter((d) => group.entities.includes(d.entity));
  const knownList = existingForGroup
    .map((d) => `- [${d.entity}] ${d.title} — ${d.url || "(no url)"} — ${d.date || "unknown"}`)
    .join("\n") || "(none logged yet)";

  const system = `You are a research assistant checking US/Canadian grid operators for new or revised generator interconnection procedures and power-system study/planning guidelines. Use the web_search tool as needed. Be conservative: only report a finding if you can point to a real, plausible URL — never fabricate a document, date, or filing. Respond with ONLY a single fenced \`\`\`json code block containing a JSON array (no other prose) — an empty array \`[]\` if there is nothing new. Each element must have exactly these fields: entity (one of ${[...VALID_ENTITIES].join("/")}), region ("US" or "CA"), category (one of ${[...VALID_CATEGORIES].join("/")}), title, url, date (YYYY-MM-DD, a partial date, or "unknown"), summary (1-2 plain sentences).`;

  const user = `Check these operators for anything new or revised since what's already logged below (new document versions, FERC/regulatory filings, stakeholder-approved redlines, effective-date changes):\n\n${group.brief}\n\nAlready logged for this group (do not repeat these unless a genuinely newer version/filing supersedes one):\n${knownList}\n\nReturn only genuinely new findings not already covered above.`;

  let messages = [{ role: "user", content: user }];
  const tools = [{ type: "web_search_20260209", name: "web_search", max_uses: 10 }];

  let response;
  for (let iterations = 0; iterations < 6; iterations++) {
    response = await client.messages.create({
      model: MODEL,
      max_tokens: MAX_TOKENS,
      system,
      tools,
      messages,
    });
    if (response.stop_reason === "pause_turn") {
      messages.push({ role: "assistant", content: response.content });
      continue;
    }
    break;
  }

  const textBlock = response.content.filter((b) => b.type === "text").pop();
  if (!textBlock) {
    console.warn(`[${group.key}] no text block in final response (stop_reason=${response.stop_reason})`);
    return [];
  }

  const parsed = extractJsonArray(textBlock.text);
  if (!Array.isArray(parsed)) {
    console.warn(`[${group.key}] could not parse JSON array from model output; skipping this group's findings this run`);
    return [];
  }
  return parsed.filter((f) => f && VALID_ENTITIES.has(f.entity) && VALID_CATEGORIES.has(f.category) && f.title && f.url);
}

function mergeFindings(existingUpdates, findings, runDate) {
  const byUrl = new Map(existingUpdates.map((d) => [normalizeUrl(d.url), d]));
  const byTitle = new Map(existingUpdates.map((d) => [normalizeTitle(d.title), d]));
  const existingIds = new Set(existingUpdates.map((d) => d.id));
  let added = 0;

  for (const f of findings) {
    const urlKey = normalizeUrl(f.url);
    const titleKey = normalizeTitle(f.title);
    if ((urlKey && byUrl.has(urlKey)) || byTitle.has(titleKey)) continue; // duplicate

    let id = `${f.entity.toLowerCase()}-${slugify(f.title) || "update"}`;
    let n = 2;
    while (existingIds.has(id)) {
      id = `${f.entity.toLowerCase()}-${slugify(f.title) || "update"}-${n++}`;
    }
    existingIds.add(id);

    const doc = {
      id,
      entity: f.entity,
      region: f.region === "CA" ? "CA" : "US",
      category: f.category,
      title: f.title,
      url: f.url,
      date: f.date || "unknown",
      summary: f.summary || "",
      isRecentChange: true,
      detectedAt: runDate,
    };
    existingUpdates.push(doc);
    byUrl.set(urlKey, doc);
    byTitle.set(titleKey, doc);
    added++;
  }
  return added;
}

function ageOutOldChanges(updates, runDate) {
  const cutoff = new Date(runDate);
  cutoff.setDate(cutoff.getDate() - RECENT_WINDOW_DAYS);
  let aged = 0;
  for (const d of updates) {
    if (!d.isRecentChange) continue;
    if (!/^\d{4}-\d{2}(-\d{2})?$/.test(d.date || "")) continue; // "unknown" or partial year-month only
    const docDate = new Date(d.date.length === 7 ? d.date + "-01" : d.date);
    if (isNaN(docDate.getTime())) continue;
    if (docDate < cutoff) {
      d.isRecentChange = false;
      aged++;
    }
  }
  return aged;
}

async function main() {
  const raw = JSON.parse(readFileSync(DATA_PATH, "utf8"));
  const updates = raw.updates || [];
  const runDate = today();

  let totalAdded = 0;
  const unreachable = [];
  for (const group of GROUPS) {
    try {
      const findings = await researchGroup(group, updates);
      const added = mergeFindings(updates, findings, runDate);
      totalAdded += added;
      console.log(`[${group.key}] +${added} new finding(s)`);
    } catch (err) {
      console.error(`[${group.key}] research failed:`, err.message || err);
      unreachable.push(group.key);
    }
  }

  const aged = ageOutOldChanges(updates, runDate);

  const notesParts = [];
  notesParts.push(totalAdded > 0 ? `Found ${totalAdded} new item(s).` : "No new items found this cycle.");
  if (aged > 0) notesParts.push(`${aged} entr${aged === 1 ? "y" : "ies"} aged out of the 12-month "recent" window.`);
  if (unreachable.length > 0) notesParts.push(`Could not complete research for: ${unreachable.join(", ")}.`);

  const meta = {
    lastRun: runDate,
    sourcesChecked: 11,
    totalUpdates: updates.length,
    notes: notesParts.join(" "),
  };

  writeFileSync(DATA_PATH, JSON.stringify({ meta, updates }, null, 2) + "\n");
  console.log(`Wrote ${updates.length} total updates. ${meta.notes}`);
}

main().catch((err) => {
  console.error("check-updates failed:", err);
  process.exit(1);
});
