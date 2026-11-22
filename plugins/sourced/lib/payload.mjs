// Payload builder (plan Task 8): a capture detail from turn.mjs becomes the
// exact body the plugin sends to collect. Owner gates G2 (one row per turn:
// conversation_id = <session uuid>.<turn key>) and G9 (answered 2026-11-15:
// create_time and captured_at are the turn's own start and end; model is the
// main model id; title is the start of the prompt, never the session title).
//
// Restates the extension's saveChat payload (src/content/data-client.js:185-205,
// whose helpers are not exported): the eight P1 keys, citedText removed from
// every stage entry (as uploadableStages, data-client.js:88-98), and no origin
// or run (U10). Unlike the extension it does not spread the detail: every
// entry is rebuilt from a fixed list of keys, so a key the reader or the
// shared stage builder adds later never reaches an upload (P2).
//
// Exports:
//   buildPayload(detail, { installId }) -> payload object (throws on a detail
//                                          that is not a claude_code capture)
//   payloadBytes(payload)               -> the exact JSON text to send
//   payloadHash(payloadOrBytes)         -> sha256 hex of those bytes
//   titleFromPrompt(prompt)             -> the row title, or null
//   TITLE_MAX_CHARS                     -> 80
import { createHash } from 'node:crypto';
import { isSessionId } from './ids.mjs';
import { validateCaptureDetail } from './vendor.mjs';

// G9 (owner, 2026-11-15): the title is the start of the exact prompt the
// preview shows, so it sends nothing the preview does not already show. Runs
// of whitespace (line breaks included) become one space, so the title is one
// line. At most TITLE_MAX_CHARS characters (code points, so no character is
// split). A longer prompt is cut at the last space within that length, when
// that space is in the second half; otherwise it is cut at the length. No
// ellipsis is added, so the title is always a start of the flattened prompt.
// Claude Code's own session title (ai-title) is never used: it describes the
// whole session, which is "something else from this session".
export const TITLE_MAX_CHARS = 80;
export function titleFromPrompt(prompt) {
  if (typeof prompt !== 'string') return null;
  const flat = prompt.replace(/[\s\u0085]+/gu, ' ').trim();
  if (!flat) return null;
  const chars = Array.from(flat);
  if (chars.length <= TITLE_MAX_CHARS) return flat;
  const head = chars.slice(0, TITLE_MAX_CHARS);
  if (chars[TITLE_MAX_CHARS] === ' ') return head.join('');
  const space = head.lastIndexOf(' ');
  if (space >= TITLE_MAX_CHARS / 2) return head.slice(0, space).join('');
  return head.join('');
}

const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const list = (v) => (Array.isArray(v) ? v : []);

// Copies only `keys`, in that order, leaving out a key the source lacks.
function pick(src, keys) {
  const out = {};
  if (!isPlainObject(src)) return out;
  for (const k of keys) if (src[k] !== undefined) out[k] = src[k];
  return out;
}

const USER_QUERY_KEYS = ['text', 'nodeId', 'timestamp', 'turnExchangeId'];
const SEARCH_QUERY_KEYS = ['text', 'userQueryIdx', 'searchQueryIdx'];
const RESULT_KEYS = ['domain', 'url', 'title', 'snippet', 'pubDate', 'refType', 'userQueryIdx', 'searchQueryIndexes', 'searchQueryIdx'];
const QUERY_KEYS = ['text', 'roundIndex', 'domains'];
const RETRIEVED_KEYS = ['url', 'normalizedUrl', 'domain', 'title', 'snippet', 'pubDate', 'roundIndex', 'refIndex'];
const RANK_KEYS = ['roundIndex', 'refIndex'];
const ACCESSED_KEYS = ['url', 'normalizedUrl', 'domain', 'title', 'roundIndex', 'refIndex'];
// citedText is deliberately not here (uploadableStages).
const QUOTED_KEYS = ['url', 'normalizedUrl', 'domain', 'title', 'snippet', 'refId', 'viaStage', 'citeWidgetId', 'sourceLabel', 'citeCount', 'provenance'];
const BY_DOMAIN_KEYS = ['retrieved', 'accessed', 'quoted', 'recommended'];

function stageOut(stage) {
  const roundSizes = {};
  for (const [k, v] of Object.entries(isPlainObject(stage.roundSizes) ? stage.roundSizes : {})) {
    if (/^\d+$/.test(k) && Number.isInteger(v)) roundSizes[k] = v;
  }
  const byDomain = {};
  for (const [d, counts] of Object.entries(isPlainObject(stage.byDomain) ? stage.byDomain : {})) {
    byDomain[d] = pick(counts, BY_DOMAIN_KEYS);
  }
  return {
    turnExchangeId: stage.turnExchangeId,
    userQuery: stage.userQuery,
    finalMessageId: stage.finalMessageId,
    queries: list(stage.queries).map((q) => ({ ...pick(q, QUERY_KEYS), domains: list(q.domains).filter((d) => typeof d === 'string') })),
    retrieved: list(stage.retrieved).map((r) => ({
      ...pick(r, RETRIEVED_KEYS),
      ...(isPlainObject(r.bestRank) ? { bestRank: pick(r.bestRank, RANK_KEYS) } : r.bestRank === null ? { bestRank: null } : {})
    })),
    roundSizes,
    accessed: list(stage.accessed).map((a) => pick(a, ACCESSED_KEYS)),
    quoted: list(stage.quoted).map((q) => pick(q, QUOTED_KEYS)),
    // Claude Code has no captured recommendations (collect refuses any).
    recommended: [],
    byDomain,
    answerMarkdown: typeof stage.answerMarkdown === 'string' ? stage.answerMarkdown : null
  };
}

export function buildPayload(detail, { installId } = {}) {
  if (!isSessionId(installId)) throw new TypeError('buildPayload: installId must be a UUID');
  const check = validateCaptureDetail(detail, 'claude_code');
  if (!check.ok) throw new TypeError(`buildPayload: not a capture (${check.reason})`);
  if (detail.surface !== 'claude_code') throw new TypeError('buildPayload: not a claude_code capture');

  const sd = detail.searchData;
  const model = typeof sd.model === 'string' && sd.model ? { model: sd.model } : {};
  const provenance = isPlainObject(sd.provenance) ? sd.provenance : {};
  const searchData = {
    hasSearch: true,
    userQueries: list(sd.userQueries).map((q) => pick(q, USER_QUERY_KEYS)),
    searchQueries: list(sd.searchQueries).map((q) => pick(q, SEARCH_QUERY_KEYS)),
    results: list(sd.results).map((r) => pick(r, RESULT_KEYS)),
    // S2: always empty. The answer links are inferred, and the legacy list
    // has no per-entry label (collect refuses a provenance key there); the
    // labeled copies are stages[].quoted[].
    citations: [],
    provenance: { citations: provenance.citations ?? null, entities: null },
    ...model,
    stages: detail.stages.map(stageOut),
    partial: detail.partial === true,
    client: detail.client,
    capturedVia: detail.capturedVia,
    surface: 'claude_code'
  };

  return {
    conversation_id: detail.conversationId,
    install_id: installId,
    // G9: the start of the prompt shown in the preview, never the session title.
    title: titleFromPrompt(detail.prompt),
    create_time: detail.createTime,
    captured_at: detail.timestamp,
    search_data: searchData,
    // No entity data on this surface (S4: never inferred).
    entity_data: { hasEntities: false, entities: [], entityTypes: [], entityPositions: [] },
    answer_markdown: typeof detail.answerMarkdown === 'string' ? detail.answerMarkdown : null
  };
}

export function payloadBytes(payload) {
  return JSON.stringify(payload);
}

export function payloadHash(payloadOrBytes) {
  const bytes = typeof payloadOrBytes === 'string' ? payloadOrBytes : payloadBytes(payloadOrBytes);
  return createHash('sha256').update(bytes, 'utf8').digest('hex');
}
