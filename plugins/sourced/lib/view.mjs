// Local view (plan Task 11): plain text for one turn in the terminal, and the
// upload preview for one capture. Pure: no network, no process, no files.
//
// Exports:
//   renderTurn(result, { width = 100, color = false, opened = [], prompt }) -> string
//     `result` is what turnToDetail returns (capture, no-search, unfinished,
//     unreadable). `opened` is read only for no-search: the fetched URLs.
//     `prompt` is shown for the kinds that can't upload, after the first
//     line, cut to PROMPT_SHORT_CHARS with a visible "…" (nothing uploads
//     from these, so the cut hides nothing that would be sent).
//   renderPreview(detail, payload, { fingerprint }) -> { screen, file }
//     Built from the payload (what will be sent), never shortened or wrapped.
//     screen, in order: the header (time and model), "Prompt" in full,
//     "Answer" in full, "Searches (n)" with each query and its result count,
//     "Pages (n)" with every page address that uploads (tags · address, the
//     title below), the inferred-links note, and "Also sent" with the title
//     (the start of the prompt, G9), the turn id, install id, model, the two times, the fixed labels and a line for
//     the per-site counts and ranks. file: the screen text, then
//     "Everything this upload holds" and the whole payload as JSON (U11),
//     then the fingerprint line when one is given. No confirm line.
//   visible(text, { multiline = false }) -> string
//     The one way payload text reaches the terminal (see "visible text").
//   VIEW_TEXT: every user-facing string ({n}, {model}, {time} are filled in).
//
// Pages merge by the page-list rule (spec section 5, as src/popup/url-list.js
// pageKey): the vendored normalizeUrl drops utm_* parameters, then the key
// drops the scheme, `www.`, the fragment and a trailing slash, with the host
// lowercased. normalizeUrl alone keeps those, so the key adds them here.
// The view renders its own strings, never url-list.js's, which name ChatGPT.
import { normalizeUrl } from './vendor.mjs';

export const PROMPT_SHORT_CHARS = 300;

export const VIEW_TEXT = Object.freeze({
  inferredNote: 'Links in the answer are inferred by Sourced, not marked by Claude Code.',
  noSearch: 'No web search',
  unreadable: "Couldn't read this turn",
  unfinished: 'This turn is still running.',
  citedInferredTag: 'Cited (inferred)',
  citedTag: 'Cited',
  openedTag: 'Opened',
  resultTag: 'Result #{n}',
  resultOfSearchTag: 'Result #{n} of search {m}',
  pagesMerged: ' (merged from {n} results)',
  shortPrompt: 'Prompt:',
  shortPromptCut: '…',
  tagSeparator: ' · ',
  searchesHeading: 'Searches ({n})',
  pagesHeading: 'Pages ({n})',
  resultCountOne: '1 result',
  resultCountMany: '{n} results',
  headerTime: '{time} UTC',
  headerSeparator: ' · ',
  previewPrompt: 'Prompt',
  previewAnswer: 'Answer',
  previewAlsoAs: 'Also as: {url}',
  sentHeading: 'Also sent',
  sentTitle: 'Title: {v}',
  sentTurnId: 'Turn id: {v}',
  sentInstallId: 'Install id: {v}',
  sentModel: 'Model: {v}',
  sentAsked: 'Asked: {v}',
  sentAnswered: 'Answered: {v}',
  sentLabels: 'Labels: surface {surface}, client {client}, captured via {via}',
  sentDerived: 'Per-site counts and ranks worked out from the pages above.',
  previewFingerprint: 'Upload fingerprint (SHA-256): {hash}',
  previewEscapes: 'Characters that would not show are written as escapes such as \\x1b or \\u{202e}, and a backslash as \\\\.',
  previewPayload: 'Everything this upload holds'
});

const fill = (template, vars) => template.replace(/\{(\w+)\}/g, (_, k) => String(vars[k]));

// --- visible text ------------------------------------------------------------
//
// visible() never removes or reorders a character (U11). Each code point maps
// to itself or to one escape:
//   `\`                      -> `\\` (always, so every `\` that shows starts an escape)
//   newline, tab             -> raw with { multiline: true }, else `\n` and `\t`
//   other C0, DEL, C1        -> `\xHH`
//   Cf (bidi controls, zero-width, soft hyphen, BOM, tags), U+2028, U+2029,
//   every other Default_Ignorable_Code_Point except the variation selectors
//   U+FE0E and U+FE0F (which only pick text or emoji style), the Hangul
//   fillers U+115F, U+1160, U+3164, U+FFA0, the Braille blank U+2800,
//   private-use characters, noncharacters, every space separator (Zs) other
//   than U+0020, lone surrogates
//                            -> `\u{H...}`
// Every other character passes through. The escapes and the plain characters
// form a prefix-free code (a shown `\` is always followed by `\`, `n`, `t`,
// `x` + 2 hex digits, or `u{...}`), so the shown text decodes to exactly one
// uploaded text: the mapping is injective.
const HIDDEN = String.raw`\u2028\u2029\p{Cf}\p{Co}\p{Noncharacter_Code_Point}\u115f\u1160\u3164\uffa0\u2800`;
const HIDDEN_MORE = String.raw`(?![\ufe0e\ufe0f])\p{Default_Ignorable_Code_Point}|(?! )\p{Zs}`;
const ESCAPE = new RegExp(String.raw`[\x00-\x1f\x7f-\x9f\\${HIDDEN}]|${HIDDEN_MORE}|[\ud800-\udfff]`, 'u');
const hex = (n, w) => n.toString(16).padStart(w, '0');

export function visible(text, { multiline = false } = {}) {
  const s = String(text);
  if (!ESCAPE.test(s)) return s;
  let out = '';
  for (const ch of s) {
    const cp = ch.codePointAt(0);
    if (ch === '\\') out += '\\\\';
    else if (ch === '\n') out += multiline ? ch : '\\n';
    else if (ch === '\t') out += multiline ? ch : '\\t';
    else if (cp <= 0x9f && (cp < 0x20 || cp >= 0x7f)) out += `\\x${hex(cp, 2)}`;
    else if (ESCAPE.test(ch)) out += `\\u{${hex(cp, 4)}}`;
    else out += ch;
  }
  return out;
}

const line = (v) => visible(v);
const block = (v) => visible(v, { multiline: true });

// JSON.stringify escapes C0, `"`, `\` and lone surrogates; this also escapes
// DEL, C1 and every character visible() escapes as \uXXXX (a pair for one
// outside the BMP). Those characters only occur inside JSON strings (the
// indentation is U+0020 and newline), so JSON.parse of the result gives back
// the same value.
const JSON_EXTRA = new RegExp(String.raw`[\x7f-\x9f${HIDDEN}]|${HIDDEN_MORE}`, 'gu');
const unitEscape = (ch) => [...Array(ch.length).keys()].map((i) => `\\u${hex(ch.charCodeAt(i), 4)}`).join('');

export function visibleJson(value) {
  return JSON.stringify(value, null, 2).replace(JSON_EXTRA, unitEscape);
}

// --- width and color ---------------------------------------------------------

const len = (s) => Array.from(s).length;

function fit(s, width) {
  const chars = Array.from(s);
  if (chars.length <= width) return s;
  return `${chars.slice(0, Math.max(0, width - 1)).join('')}…`;
}

// Cuts `text` so that prefix + text + suffix fits; the suffix always shows.
function fitWith(prefix, text, suffix, width) {
  const room = width - len(prefix) - len(suffix);
  if (room < 1) return fit(prefix + text + suffix, width);
  return prefix + fit(text, room) + suffix;
}

const styles = (color) => ({
  bold: (s) => (color ? `\x1b[1m${s}\x1b[22m` : s),
  dim: (s) => (color ? `\x1b[2m${s}\x1b[22m` : s)
});

// --- pages ------------------------------------------------------------------

function parseWeb(url) {
  if (typeof url !== 'string') return null;
  try {
    const u = new URL(normalizeUrl(url));
    return u.protocol === 'http:' || u.protocol === 'https:' ? u : null;
  } catch {
    return null;
  }
}

function pageKey(url) {
  const u = parseWeb(url);
  if (!u) return null;
  return u.hostname.toLowerCase().replace(/^www\./, '') + u.pathname.replace(/\/+$/, '') + u.search;
}

const isInferred = (entry) => entry?.provenance !== 'captured';

// Some search results carry the start of the page as their title, such as
// '> ## Documentation Index' or '# Web search' from a .md page, or a long
// paragraph (seen by the coordinator, 2026-11-21). Such a title is not shown:
// the page's host stands in for it, and a real title from another stage of
// the turn wins. The saved preview file's JSON keeps the title as uploaded.
export const PAGE_TITLE_MAX_CHARS = 200;
export function isPageText(title) {
  const t = String(title).trim();
  return /^[#>]/.test(t) || Array.from(t).length > PAGE_TITLE_MAX_CHARS;
}
const hostOf = (url) => parseWeb(url)?.hostname.toLowerCase().replace(/^www\./, '') ?? '';
const shownTitle = (row) => line(row.title).trim() || (row.pageText ? line(hostOf(row.url)) : '');

function buildPages(stages) {
  const rows = new Map();
  const rowFor = (url) => {
    const key = pageKey(url);
    if (!key) return null;
    if (!rows.has(key)) {
      rows.set(key, { url: normalizeUrl(url), urls: [], title: '', rank: null, rankRound: null, opened: false, cited: false, citedCaptured: false, order: rows.size });
    }
    const row = rows.get(key);
    if (!row.urls.includes(url)) row.urls.push(url);
    return row;
  };
  const adopt = (row, item) => {
    if (row.title || typeof item.title !== 'string' || !item.title.trim()) return;
    if (isPageText(item.title)) row.pageText = true;
    else row.title = item.title.trim();
  };
  for (const stage of stages) {
    for (const item of stage.retrieved || []) {
      const row = item && rowFor(item.url);
      if (!row) continue;
      adopt(row, item);
      const best = Number.isInteger(item.bestRank?.refIndex);
      const rank = best ? item.bestRank.refIndex : item.refIndex;
      const round = best ? item.bestRank.roundIndex : item.roundIndex;
      if (Number.isInteger(rank) && (row.rank === null || rank < row.rank)) {
        row.rank = rank;
        row.rankRound = Number.isInteger(round) ? round : null;
      }
    }
    for (const item of stage.accessed || []) {
      const row = item && rowFor(item.url);
      if (!row) continue;
      row.opened = true;
      adopt(row, item);
    }
    for (const item of stage.quoted || []) {
      const row = item && rowFor(item.url);
      if (!row) continue;
      row.cited = true;
      if (!isInferred(item)) row.citedCaptured = true;
      adopt(row, item);
    }
  }
  return [...rows.values()];
}

// "Most used": cited and opened, cited, opened, then the rest, each by rank.
const roleOf = (row) => (row.cited && row.opened ? 0 : row.cited ? 1 : row.opened ? 2 : 3);
const byRank = (a, b) => (a.rank ?? Infinity) - (b.rank ?? Infinity) || a.order - b.order;
const sortPages = (rows) => [...rows].sort((a, b) => roleOf(a) - roleOf(b) || byRank(a, b));

// searchNo: roundIndex -> the search's number as listed, given only when the
// turn listed more than one search ("Result #n of search m").
function pageTags(row, searchNo) {
  const tags = [];
  if (row.cited) tags.push(row.citedCaptured ? VIEW_TEXT.citedTag : VIEW_TEXT.citedInferredTag);
  if (row.opened) tags.push(VIEW_TEXT.openedTag);
  if (row.rank !== null) {
    const m = searchNo && row.rankRound !== null ? searchNo.get(row.rankRound) : undefined;
    tags.push(m ? fill(VIEW_TEXT.resultOfSearchTag, { n: row.rank + 1, m }) : fill(VIEW_TEXT.resultTag, { n: row.rank + 1 }));
  }
  return tags;
}

// A page's title and address are never cut, so they can be read and copied
// whole (owner, 2026-11-20, after O3 saw them cut with "…"); the terminal wraps
// a long one. The tags line still fits the width.
function pageLines(rows, width, st, searchNo) {
  const out = [];
  rows.forEach((row, i) => {
    const url = line(row.url);
    const title = shownTitle(row);
    out.push(`  ${i + 1}. ${title || url}`);
    if (title) out.push(st.dim(`     ${url}`));
    const tags = pageTags(row, searchNo);
    if (tags.length) out.push(fit(`     ${tags.join(VIEW_TEXT.tagSeparator)}`, width));
  });
  return out;
}

// The listed queries of the stages ([stage, query] pairs with real text),
// their raw result counts, and roundIndex -> search number when there is
// more than one search.
function searchesOf(stages) {
  const queries = stages.flatMap((stage) => list(stage?.queries).filter((q) => typeof q?.text === 'string' && q.text.trim()).map((q) => [stage, q]));
  const counts = queries.map(([stage, q]) => resultCount(stage, q));
  const searchNo = queries.length > 1 ? new Map(queries.map(([, q], i) => [q.roundIndex, i + 1]).filter(([r]) => Number.isInteger(r)).reverse()) : null;
  return { queries, counts, total: counts.reduce((n, c) => n + c, 0), searchNo };
}

const countText = (n) => (n === 1 ? VIEW_TEXT.resultCountOne : fill(VIEW_TEXT.resultCountMany, { n }));

function pagesHeading(n, total) {
  return fill(VIEW_TEXT.pagesHeading, { n }) + (total !== n ? fill(VIEW_TEXT.pagesMerged, { n: total }) : '');
}

// --- renderTurn ---------------------------------------------------------------

function headerTime(seconds) {
  if (typeof seconds !== 'number' || !Number.isFinite(seconds)) return null;
  const iso = new Date(seconds * 1000).toISOString();
  return fill(VIEW_TEXT.headerTime, { time: `${iso.slice(0, 10)} ${iso.slice(11, 16)}` });
}

// The raw number of results one search returned.
function resultCount(stage, query) {
  const size = stage.roundSizes?.[query.roundIndex];
  return Number.isInteger(size) ? size : list(stage.retrieved).filter((r) => r?.roundIndex === query.roundIndex).length;
}

function renderCapture(detail, width, st) {
  const stages = Array.isArray(detail.stages) ? detail.stages : [];
  const lines = [];
  const time = headerTime(detail.createTime);
  const model = typeof detail.searchData?.model === 'string' && detail.searchData.model ? line(detail.searchData.model) : null;
  const header = [time, model].filter(Boolean).join(VIEW_TEXT.headerSeparator);
  if (header) lines.push(st.bold(fit(header, width)), '');

  const { queries, counts, total, searchNo } = searchesOf(stages);
  lines.push(st.bold(fit(fill(VIEW_TEXT.searchesHeading, { n: queries.length }), width)));
  queries.forEach(([, q], i) => {
    lines.push(fitWith(`  ${i + 1}. `, line(q.text), ` (${countText(counts[i])})`, width));
  });

  const rows = sortPages(buildPages(stages));
  lines.push('', st.bold(fit(pagesHeading(rows.length, total), width)));
  lines.push(...pageLines(rows, width, st, searchNo));

  if (rows.some((r) => r.cited && !r.citedCaptured)) lines.push('', fit(VIEW_TEXT.inferredNote, width));
  return lines;
}

function renderNoSearch(opened, width, st) {
  const lines = [fit(VIEW_TEXT.noSearch, width)];
  const rows = buildPages([{ accessed: (Array.isArray(opened) ? opened : []).map((url) => ({ url })) }]);
  if (rows.length) {
    lines.push('', st.bold(fit(fill(VIEW_TEXT.pagesHeading, { n: rows.length }), width)));
    lines.push(...pageLines(rows, width, st));
  }
  return lines;
}

// The prompt in the short view: at most PROMPT_SHORT_CHARS characters of
// it, escaped as everywhere else, with "…" when it was cut.
function shortPrompt(prompt) {
  if (typeof prompt !== 'string' || prompt === '') return [];
  const chars = Array.from(prompt);
  const cut = chars.length > PROMPT_SHORT_CHARS;
  const text = block(cut ? chars.slice(0, PROMPT_SHORT_CHARS).join('') : prompt) + (cut ? VIEW_TEXT.shortPromptCut : '');
  return ['', VIEW_TEXT.shortPrompt, ...text.split('\n')];
}

export function renderTurn(result, { width = 100, color = false, opened = [], prompt } = {}) {
  const w = Number.isInteger(width) && width >= 20 ? width : 20;
  const st = styles(color === true);
  switch (result?.kind) {
    case 'capture':
      return renderCapture(result.detail, w, st).join('\n');
    case 'no-search': {
      const [first, ...rest] = renderNoSearch(opened, w, st);
      return [first, ...shortPrompt(prompt), ...rest].join('\n');
    }
    case 'unfinished':
      return [fit(VIEW_TEXT.unfinished, w), ...shortPrompt(prompt)].join('\n');
    default:
      return [fit(VIEW_TEXT.unreadable, w), ...shortPrompt(prompt)].join('\n');
  }
}

// --- renderPreview -------------------------------------------------------------

const list = (v) => (Array.isArray(v) ? v : []);
const strings = (values) => values.filter((v) => typeof v === 'string' && v !== '');
const unique = (values) => [...new Set(values)];

function isoOf(ms) {
  if (typeof ms !== 'number' || !Number.isFinite(ms)) return null;
  const d = new Date(ms);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

// One line per merged page: its tags, then the address in full; the title
// below; any other address that merged into it below that. Not shortened.
function previewPageLines(rows, searchNo) {
  const out = [];
  for (const row of rows) {
    const [first, ...more] = row.urls;
    const tags = pageTags(row, searchNo);
    out.push(`  ${[...tags, line(first)].join(VIEW_TEXT.tagSeparator)}`);
    const title = shownTitle(row);
    if (title) out.push(`    ${title}`);
    for (const u of more) out.push(`    ${fill(VIEW_TEXT.previewAlsoAs, { url: line(u) })}`);
  }
  return out;
}

export function renderPreview(detail, payload, { fingerprint } = {}) {
  void detail; // The preview reads only the payload, so it can't show less than uploads.
  const sd = payload?.search_data ?? {};
  const stages = list(sd.stages);
  const lines = [];

  const model = typeof sd.model === 'string' && sd.model ? sd.model : null;
  const header = [headerTime(payload?.create_time), model ? line(model) : null].filter(Boolean).join(VIEW_TEXT.headerSeparator);
  if (header) lines.push(header, '');

  const prompts = unique(strings([...list(sd.userQueries).map((q) => q?.text), ...stages.map((s) => s?.userQuery)]));
  lines.push(VIEW_TEXT.previewPrompt);
  for (const p of prompts) lines.push(block(p));
  lines.push('');

  lines.push(VIEW_TEXT.previewAnswer);
  const answers = unique(strings([payload?.answer_markdown, ...stages.map((s) => s?.answerMarkdown)]));
  for (const a of answers) lines.push(block(a));
  lines.push('');

  // Each search with its raw result count, then any query text the payload
  // holds outside the stages.
  const { queries, counts, total, searchNo } = searchesOf(stages);
  const listed = new Set(queries.map(([, q]) => q.text));
  const extra = unique(strings(list(sd.searchQueries).map((q) => q?.text))).filter((t) => !listed.has(t));
  lines.push(fill(VIEW_TEXT.searchesHeading, { n: queries.length + extra.length }));
  queries.forEach(([, q], i) => lines.push(`  ${i + 1}. ${line(q.text)} (${countText(counts[i])})`));
  extra.forEach((t, i) => lines.push(`  ${queries.length + i + 1}. ${line(t)}`));
  lines.push('');

  // Every page address that uploads, merged by the page-list rule. The legacy
  // lists come after the stages, so an address only they hold still shows.
  const rows = sortPages(buildPages([...stages, { retrieved: list(sd.results).map((r) => ({ url: r?.url, title: r?.title })), quoted: list(sd.citations) }]));
  lines.push(pagesHeading(rows.length, total));
  lines.push(...previewPageLines(rows, searchNo));
  lines.push('');
  if (rows.some((r) => r.cited && !r.citedCaptured)) lines.push(VIEW_TEXT.inferredNote, '');

  lines.push(VIEW_TEXT.sentHeading);
  const sent = (template, v) => lines.push(`  ${fill(template, { v: line(v) })}`);
  if (typeof payload?.title === 'string') sent(VIEW_TEXT.sentTitle, payload.title);
  if (typeof payload?.conversation_id === 'string') sent(VIEW_TEXT.sentTurnId, payload.conversation_id);
  if (typeof payload?.install_id === 'string') sent(VIEW_TEXT.sentInstallId, payload.install_id);
  if (model) sent(VIEW_TEXT.sentModel, model);
  const asked = isoOf(typeof payload?.create_time === 'number' ? payload.create_time * 1000 : null);
  const answered = isoOf(payload?.captured_at);
  if (asked) sent(VIEW_TEXT.sentAsked, asked);
  if (answered) sent(VIEW_TEXT.sentAnswered, answered);
  lines.push(`  ${fill(VIEW_TEXT.sentLabels, { surface: line(sd.surface ?? ''), client: line(sd.client ?? ''), via: line(sd.capturedVia ?? '') })}`);
  lines.push(`  ${VIEW_TEXT.sentDerived}`);

  if (lines.some((l) => l.includes('\\'))) lines.push('', VIEW_TEXT.previewEscapes);
  const screen = lines.join('\n');

  // The readable sections leave out numbers, booleans and some strings; this
  // block holds all of it, so nothing uploads unseen (U11).
  const file = [screen, '', VIEW_TEXT.previewPayload, visibleJson(payload)];
  if (typeof fingerprint === 'string' && fingerprint) file.push('', fill(VIEW_TEXT.previewFingerprint, { hash: fingerprint }));
  return { screen, file: file.join('\n') };
}
