// markdown.js — reads markdown files DIRECTLY (read-only).
// Two whole sections live ONLY in markdown, never in mypka.db:
//   1. Lab values  -> PKM/My Life/Key Elements/health.md tables (Silas finding 1)
//   2. Personal tasks -> Team Knowledge/tasks/{open,in-progress}/*.md (Silas finding 5)
// We parse the markdown rather than invent a schema.
import fs from 'node:fs';
import path from 'node:path';
import { REPO_ROOT } from './db.js';
import { resolveSlug } from './cockpit.js';
// SCAFFOLD ADAPTATION (2026-06-11): the one DB statement rides optionalStmt()
// (wellnessDb.js) so a mirror variant without the deliverables shape degrades
// to "no plan note" instead of crashing the boot.
import { optionalStmt } from './wellnessDb.js';

const HEALTH_MD = path.join(REPO_ROOT, 'PKM', 'My Life', 'Key Elements', 'health.md');

function readHealth() {
  return fs.existsSync(HEALTH_MD) ? fs.readFileSync(HEALTH_MD, 'utf8') : '';
}

// Pull a "## Section" block out of a markdown doc (stops at the next "## " or "---").
// The heading must sit at the START of a line (multiline `^`) so an inline-code
// mention like `## Lab trends` in prose does NOT get matched as the real heading.
function sectionBlock(md, heading) {
  // `m` makes `^` match the start of a line; the stop-lookahead must use a
  // true end-of-string assertion `$(?![\s\S])` because with `m` a bare `$`
  // matches every line-end and would capture nothing.
  const re = new RegExp(
    `^##\\s+${escapeRe(heading)}[^\\n]*\\n([\\s\\S]*?)(?=\\n##\\s|\\n---\\n|$(?![\\s\\S]))`,
    'm'
  );
  const m = md.match(re);
  return m ? m[1] : '';
}

// Parse the first GitHub-style table found in a block into {headers, rows}.
function parseTable(block) {
  const lines = block.split('\n').map((l) => l.trim());
  const start = lines.findIndex((l) => l.startsWith('|') && l.endsWith('|'));
  if (start === -1) return null;
  const headerCells = splitRow(lines[start]);
  // line start+1 is the |---|---| separator
  const rows = [];
  for (let i = start + 2; i < lines.length; i++) {
    const l = lines[i];
    if (!l.startsWith('|')) break;
    rows.push(splitRow(l));
  }
  return { headers: headerCells, rows };
}

function splitRow(line) {
  return line
    .replace(/^\|/, '')
    .replace(/\|$/, '')
    .split('|')
    .map((c) => stripMd(c.trim()));
}

// Strip markdown emphasis / wikilinks down to readable text.
function stripMd(s) {
  return s
    .replace(/\[\[([^\]|]+)\|([^\]]+)\]\]/g, '$2')
    .replace(/\[\[([^\]]+)\]\]/g, '$1')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/⚠/g, '')
    .trim();
}

function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Keep **bold** as a marker the client renders as emphasis; strip the rest.
function stripKeepBold(s) {
  return s
    .replace(/\[\[([^\]|]+)\|([^\]]+)\]\]/g, '$2')
    .replace(/\[\[([^\]]+)\]\]/g, '$1')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/⚠/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

// Markdown chunk -> ordered readable blocks (p / ul / h / quote) so the
// click-to-expand Sheet shows the FULL text broken into scannable pieces (v2).
function toReadableBlocks(md) {
  if (!md) return [];
  const lines = String(md).split('\n');
  const blocks = [];
  let para = [];
  let list = [];
  const flushPara = () => {
    if (para.length) { blocks.push({ type: 'p', text: stripKeepBold(para.join(' ')) }); para = []; }
  };
  const flushList = () => {
    if (list.length) { blocks.push({ type: 'ul', items: list.map(stripKeepBold) }); list = []; }
  };
  for (const raw of lines) {
    const line = raw.trim();
    if (!line) { flushPara(); flushList(); continue; }
    const heading = line.match(/^#{2,4}\s+(.*)$/);
    if (heading) { flushPara(); flushList(); blocks.push({ type: 'h', text: stripKeepBold(heading[1]) }); continue; }
    const bullet = line.match(/^[-*]\s+(.*)$/);
    if (bullet) { flushPara(); list.push(bullet[1]); continue; }
    const quote = line.match(/^>\s?(.*)$/);
    if (quote) { flushPara(); flushList(); if (quote[1]) blocks.push({ type: 'quote', text: stripKeepBold(quote[1]) }); continue; }
    flushList();
    para.push(line);
  }
  flushPara();
  flushList();
  return blocks;
}

// ---- Labs -----------------------------------------------------------------
// "## Lab trends" contains several "### Marker" subsections, each with a table.
// We surface them as titled panels exactly as authored (text, not typed columns).
export function getLabs() {
  const md = readHealth();
  const block = sectionBlock(md, 'Lab trends');
  if (!block) return { panels: [], asOf: null, note: 'health.md Lab trends section not found' };

  const panels = [];
  // Split into ### subsections.
  const subRe = /###\s+([^\n]+)\n([\s\S]*?)(?=\n###\s|$)/g;
  let m;
  while ((m = subRe.exec(block)) !== null) {
    const title = stripMd(m[1]);
    const sub = m[2];
    const table = parseTable(sub);
    const assessment = extractAssessment(sub);
    // Text-only subsections (thyroid coverage-gap, Outlier flag, Coverage
    // gaps, Cross-links) carry no table — capture their prose so the UI can
    // render them as a calm note instead of an empty table.
    const note = table ? null : firstProse(sub);
    // v2: the full prose of the subsection, broken into readable blocks, for the
    // click-to-expand Sheet (the card preview shows only the first sentence).
    // Strip the table itself out before block-converting so the sheet shows
    // the assessment / worth-bringing prose, not a re-typed table.
    const proseOnly = sub.replace(/^\s*\|.*\|\s*$/gm, '');
    panels.push({ title, table, assessment, note, full: toReadableBlocks(proseOnly) });
  }
  return { panels };
}

// First substantive prose paragraph of a block (for text-only lab subsections).
function firstProse(block) {
  const para = block
    .split(/\n\s*\n/)
    .map((p) => p.replace(/\s+/g, ' ').trim())
    .find((p) => p && !p.startsWith('|') && !p.startsWith('#'));
  return para ? stripMd(para) : null;
}

// "**Einschätzung:** ..." sentence under each lab table — the calm framing.
// The `**Einschätzung:**` marker matches a German-language label in health.md
// (the reference instance was authored in German); adapt the marker to your own
// language if your health.md uses a different one. The function name is English.
function extractAssessment(block) {
  const m = block.match(/\*\*Einschätzung:\*\*\s*([\s\S]*?)(?=\n\n|\*\*Worth bringing|$)/);
  if (!m) return null;
  return stripMd(m[1]).replace(/\s+/g, ' ').trim();
}

// ---- Diagnoses ------------------------------------------------------------
export function getDiagnoses() {
  const md = readHealth();
  const block = sectionBlock(md, 'Active diagnoses');
  const table = parseTable(block);
  const confirmed = [];
  if (table) {
    for (const r of table.rows) {
      // columns: Diagnosis | ICD-10 | Confirmed | Source document | Status
      if (r[0] && r[0] !== '—') {
        confirmed.push({ name: r[0], icd: r[1] || null, confirmed: r[2] || null });
      }
    }
  }
  // SCAFFOLD ADAPTATION: the reference instance hardcoded three PERSONAL
  // diagnosis chips here (its owner's curated context). The scaffold surfaces
  // only what it can read from the user's own health.md table — no chips are
  // invented. An adapting assistant may re-add curated chips for THIS user.
  const chips = [];
  return { confirmed, chips };
}

// Some exams/open-questions map to a REAL note (a project or key-element), so the
// PLANNED row can resolve into the universal viewer instead of only opening its text
// in the Sheet. We match the item's text against known note slugs and, if the slug
// actually resolves, attach a `{type, slug}` link. Pure-text items stay Sheet-only.
//
// EXAMPLE / EMPTY BY DEFAULT. The cockpit author's real exam→note mappings (their
// own health-note slugs) have been removed. Define your own as a JSON array via the
// EXAM_NOTE_HINTS env var: [{ "pattern": "<regex>", "slug": "<note-slug>" }, …].
// Unset (default) → no exam links are attached (still honest, just Sheet-only).
const EXAM_NOTE_HINTS = (() => {
  try {
    const raw = JSON.parse(process.env.EXAM_NOTE_HINTS || '[]');
    if (!Array.isArray(raw)) return [];
    return raw
      .filter((h) => h && typeof h.pattern === 'string' && typeof h.slug === 'string')
      .map((h) => ({ re: new RegExp(h.pattern, 'i'), slug: h.slug }));
  } catch {
    return []; // malformed env → no hints, never crash
  }
})();

// Cache slug->resolvability so we only hit the resolver once per slug per request.
function firstResolvableExamNote(text) {
  for (const h of EXAM_NOTE_HINTS) {
    if (!h.re.test(text)) continue;
    const matches = resolveSlug(h.slug);
    if (matches.length > 0) {
      return { type: matches[0].type, slug: matches[0].slug };
    }
  }
  return null;
}

// ---- Open questions / next exams ------------------------------------------
// Numbered list under "## Open questions / next exams". We surface the bold lead
// of each item + flag overdue/deadline items, paired with the PLANNED framing.
export function getOpenQuestions() {
  const md = readHealth();
  const block = sectionBlock(md, 'Open questions / next exams');
  if (!block) return [];
  const items = [];
  // Numbered top-level items "N. **Title** ..." (skip indented sub-bullets).
  // (JS has no \Z; end-of-string is handled by [\s\S]*? + the final $ alternative.)
  const re = /^(\d+)\.\s+([\s\S]*?)(?=^\d+\.\s|$(?![\s\S]))/gm;
  let m;
  while ((m = re.exec(block)) !== null) {
    const num = parseInt(m[1], 10);
    const raw = m[2];
    // Title = first bold run, else first sentence.
    const titleM = raw.match(/\*\*([^*]+)\*\*/);
    const title = titleM ? stripMd(titleM[1]) : stripMd(raw.split('.')[0]);
    const text = stripMd(firstSentence(raw)).replace(/\s+/g, ' ').trim();
    const lower = raw.toLowerCase();
    const answered = lower.includes('answered') || lower.includes('resolved');
    // 'überfällig' / 'frist' are German-language synonyms matched alongside the
    // English terms (the reference health.md was authored in German). Harmless to
    // keep for English-only notes; add your own language's terms if needed.
    const overdue = lower.includes('overdue') || lower.includes('überfällig');
    const deadlineM = raw.match(/\b(20\d{2}-\d{2}-\d{2})\b/);
    const deadline = (lower.includes('deadline') || lower.includes('frist')) && deadlineM
      ? deadlineM[1] : null;
    // v2: full item prose (the whole numbered entry incl. sub-bullets) as readable
    // blocks, with the leading bold title removed so the sheet doesn't repeat it.
    const bodyAfterTitle = titleM ? raw.replace(titleM[0], '').replace(/^[\s—:.-]+/, '') : raw;
    // Attach a resolvable note link when the exam clearly maps to one (HNO, PKV/BMI,
    // Knie). Match against the TITLE only — matching the whole body produced
    // misleading links (a CV-consolidation item that merely *mentions* the HNO
    // workup, a Divertikulitis item that mentions weight). A precise, sometimes-
    // absent link beats a confident wrong one.
    const note = firstResolvableExamNote(title);
    items.push({ num, title, text, answered, overdue, deadline, note, full: toReadableBlocks(bodyAfterTitle) });
  }
  return items;
}

function firstSentence(s) {
  const clean = s.replace(/\n+/g, ' ');
  const m = clean.match(/^.*?[.!?](\s|$)/);
  return m ? m[0] : clean.slice(0, 240);
}

// ---- Personal tasks (NOT in mypka.db) -------------------------------------
const TASK_DIRS = [
  path.join(REPO_ROOT, 'Team Knowledge', 'tasks', 'in-progress'),
  path.join(REPO_ROOT, 'Team Knowledge', 'tasks', 'open'),
];

// EXAMPLE HEURISTIC (health module). Surfaces only PERSONAL health/life/family
// tasks from Team Knowledge/tasks/, excluding work/ops tasks. Two signals, EITHER
// qualifies:
//   1. linked_my_life frontmatter touches one of the configured life-element slugs, or
//   2. body/title hits one of the configured keywords AND the task's assignee matches
//      the configured owner.
//
// These two lists are DELIBERATELY GENERIC PLACEHOLDERS — adapt them to your own
// My Life slugs and language. The cockpit author's real lists (German health slugs,
// owner name) have been removed; replace EXAMPLE_* with your own to make this active.
//
// Configurable via env (so you don't have to edit source):
//   PERSONAL_LIFE_LINKS — comma-separated linked_my_life slugs to treat as personal
//   PERSONAL_TASK_OWNER — the `assignee` value that marks a task as yours (for
//                         keyword-only matches). Empty (default) → keyword-only
//                         matches are ignored; only link matches qualify.
const PERSONAL_LIFE_LINKS = (process.env.PERSONAL_LIFE_LINKS
  || 'health,family' /* EXAMPLE_LIFE_LINKS — replace with your own life-element slugs */)
  .split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);

// EXAMPLE keyword hints. Empty by default so a fresh install matches on links only;
// add your own health/family keywords here (or leave empty). Word-boundary matched.
const PERSONAL_TASK_HINTS = (process.env.PERSONAL_TASK_HINTS || '' /* EXAMPLE: 'doctor,checkup' */)
  .split(',').map((s) => s.trim()).filter(Boolean)
  .map((w) => new RegExp(`(^|[^a-z0-9äöüß])${w}([^a-z0-9äöüß]|$)`, 'i'));

// The assignee value that marks a task as the owner's (for keyword-only matches).
// Empty default → keyword-only matches never qualify (no owner name hard-coded).
const PERSONAL_TASK_OWNER = (process.env.PERSONAL_TASK_OWNER || '').toLowerCase();

export function getPersonalTasks() {
  const out = [];
  for (const dir of TASK_DIRS) {
    if (!fs.existsSync(dir)) continue;
    const status = dir.endsWith('in-progress') ? 'in-progress' : 'open';
    for (const f of fs.readdirSync(dir)) {
      if (!f.endsWith('.md') || f.startsWith('EXAMPLE') || f.startsWith('.')) continue;
      const full = path.join(dir, f);
      const md = fs.readFileSync(full, 'utf8');
      const title = parseFm(md, 'title') || titleFromFilename(f);
      const assignee = (parseFm(md, 'assignee') || '').toLowerCase();
      const links = (parseFm(md, 'linked_my_life') || '').toLowerCase();
      const haystack = (f + ' ' + md).toLowerCase();
      const linkHit = PERSONAL_LIFE_LINKS.some((l) => links.includes(l));
      const kwHit = PERSONAL_TASK_HINTS.some((re) => re.test(haystack));
      // The configured owner must match for keyword-only matches; link matches are
      // trusted regardless (a family task may be assigned to a coordinator). With no
      // PERSONAL_TASK_OWNER configured, keyword-only matches never qualify.
      const isPersonal = linkHit || (kwHit && PERSONAL_TASK_OWNER && assignee === PERSONAL_TASK_OWNER);
      if (!isPersonal) continue;
      out.push({
        file: f,
        status,
        title: stripMd(title),
        due: parseFm(md, 'due') || parseFm(md, 'deadline'),
        // health/family link drives the calmer framing in the UI
        lifeLinked: linkHit,
      });
    }
  }
  // in-progress first, then open; within a group, nearest due date first.
  out.sort((a, b) => {
    if (a.status !== b.status) return a.status === 'in-progress' ? -1 : 1;
    return (a.due || '9999').localeCompare(b.due || '9999');
  });
  return out;
}

function parseFm(md, key) {
  const fm = md.match(/^---\n([\s\S]*?)\n---/);
  if (!fm) return null;
  const m = fm[1].match(new RegExp('^' + key + ':\\s*(.+)$', 'm'));
  return m ? m[1].replace(/^["']|["']$/g, '').trim() : null;
}

function titleFromFilename(f) {
  return f
    .replace(/\.md$/, '')
    .replace(/^tsk-\d{4}-\d{2}-\d{2}-\d+-/, '')
    .replace(/-/g, ' ');
}

// ---- Nutrition plan link (EXAMPLE, health module) --------------------------
// Links the health dashboard's "Planned" pointer to a nutrition-plan deliverable
// note so it is CLICKABLE into the universal viewer. The regen slugs deliverables
// as `<folder>--<filename>`, so we look the slug up from the deliverables table by
// a LIKE pattern rather than guessing, and hand the client a `{type, slug}` it can
// route through #/note/deliverables/<slug>.
//
// The slug match is CONFIGURABLE — the cockpit author's real deliverable slug has
// been removed. Point it at your own nutrition-plan deliverable via env:
//   NUTRITION_PLAN_SLUG — substring matched against deliverable slugs
//                         (default 'EXAMPLE_nutrition_plan' → matches nothing,
//                          so the pointer stays inert until you set it).
const NUTRITION_PLAN_SLUG = (process.env.NUTRITION_PLAN_SLUG || 'EXAMPLE_nutrition_plan').trim();

const deliverableSlugStmt = optionalStmt(`
  SELECT slug, title FROM deliverables
  WHERE slug LIKE ?
  ORDER BY length(slug) ASC
  LIMIT 1
`);

export function getNutritionPlan() {
  // Resolve the deliverable note (if any) so the UI can open it in-app. Inert by
  // default: the EXAMPLE_ slug matches nothing until NUTRITION_PLAN_SLUG is set.
  const row = deliverableSlugStmt.get(`%${NUTRITION_PLAN_SLUG}%`);
  const note = row ? { type: 'deliverables', slug: row.slug } : null;
  // `path` is kept for the UI's plain-text fallback label (Planned.tsx). It is the
  // resolved deliverable title/slug when matched, else '' (the UI shows the note
  // link when present and the path string only as a fallback).
  const exists = Boolean(row);
  return { exists, path: row ? (row.title || row.slug) : '', note };
}
