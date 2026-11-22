// Reads the local queue the hooks write (queue-write.mjs) and groups it into
// turns shaped like the transcript reader's (reader.mjs), so later steps take
// either source. Read only: nothing here writes, and it imports only node:fs,
// node:path and plugin/lib files (no network module, no child process).
//
// Exports:
//   readQueue(sessionId, { env })       -> { records, skipped }
//       Every queue record in queue/<sessionId>/ that parses, has v === 1, a
//       known kind ('search', 'fetch', 'stop') and a session_id equal to the
//       folder name. Search and fetch records also need a valid tool_use_id,
//       stop records a valid prompt_id. Anything else is skipped and counted.
//       A record's prompt_id is a valid id or null. Temp files (*.tmp) and the
//       sweep marker are not records and are not counted.
//   turnsFromQueue(sessionId, { env })  -> { turns, skipped }
//       Records grouped by prompt_id (records with a null prompt_id are left
//       out; resolveTurn in turns.mjs can still join them by tool_use_id).
//   turnFromRecords(records)            -> turn | null
//       One reader-shaped turn from search, fetch and stop records.
//
// Turn shape (as reader.mjs, plus source): { index, prompt: null,
// prompt_uuid: null, prompt_id, started_at, ended_at, models: [],
// request_ids: [], message_ids: [], searches, fetches, subagents: [],
// skipped: 0, answer_markdown, answer_after_tools, cited: [], source: 'hooks' }.
// search: { tool_use_id, issued_at, query, results: [{ rank, title, url,
// host }], search_count, duration_s, status: 'ok' | 'error' }. Rank is
// 1-based across the inner searches, in order, as the reader counts it.
// fetch: { tool_use_id, issued_at, url, final_url, status, errored }.
// Searches and fetches are ordered by their `at` time. answer_markdown is the
// stop file's answer, and answer_after_tools is true only when a stop file
// exists. `cited` stays empty: a queue turn has no prompt and is never
// uploaded, so answer links are not derived here.
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { queueDir } from './paths.mjs';
import { isSessionId, isPromptId, isToolUseId } from './ids.mjs';
import { RECORD_VERSION, SWEEP_MARKER } from './queue-write.mjs';
import { hostOf } from './links.mjs';

const KINDS = new Set(['search', 'fetch', 'stop']);

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const timeOf = (rec) => {
  const t = Date.parse(rec.at);
  return Number.isFinite(t) ? t : Infinity;
};

function validRecord(rec, sessionId) {
  if (!isObject(rec) || rec.v !== RECORD_VERSION || !KINDS.has(rec.kind)) return false;
  if (rec.session_id !== sessionId) return false;
  if (rec.kind === 'stop') return isPromptId(rec.prompt_id);
  if (!isToolUseId(rec.tool_use_id)) return false;
  return rec.prompt_id === null || rec.prompt_id === undefined || isPromptId(rec.prompt_id);
}

export function readQueue(sessionId, { env = process.env } = {}) {
  if (!isSessionId(sessionId)) return { records: [], skipped: 0 };
  const dir = queueDir(env, sessionId);
  let names;
  try {
    names = readdirSync(dir).sort();
  } catch (err) {
    if (err?.code === 'ENOENT' || err?.code === 'ENOTDIR') return { records: [], skipped: 0 };
    throw err;
  }
  const records = [];
  let skipped = 0;
  for (const name of names) {
    if (!name.endsWith('.json') || name === SWEEP_MARKER) continue;
    let rec;
    try {
      rec = JSON.parse(readFileSync(join(dir, name), 'utf8'));
    } catch (err) {
      // A damaged or half-written file is skipped; a file gone since the
      // listing (the sweep) is not a record at all.
      if (err?.code === 'ENOENT') continue;
      if (!(err instanceof SyntaxError) && err?.code !== 'EISDIR') throw err;
      skipped += 1;
      continue;
    }
    if (!validRecord(rec, sessionId)) {
      skipped += 1;
      continue;
    }
    records.push({ ...rec, prompt_id: rec.prompt_id ?? null, _file: name });
  }
  return { records, skipped };
}

function searchOf(rec) {
  const results = [];
  let rank = 0;
  const inner = Array.isArray(rec.results) ? rec.results : [];
  for (const block of inner) {
    if (!Array.isArray(block)) continue;
    for (const item of block) {
      if (!isObject(item) || typeof item.url !== 'string') continue;
      rank += 1;
      results.push({ rank, title: typeof item.title === 'string' ? item.title : null, url: item.url, host: hostOf(item.url) });
    }
  }
  return {
    tool_use_id: rec.tool_use_id,
    issued_at: typeof rec.at === 'string' ? rec.at : null,
    query: typeof rec.query === 'string' ? rec.query : null,
    results,
    search_count: typeof rec.search_count === 'number' ? rec.search_count : null,
    duration_s: typeof rec.duration_s === 'number' ? rec.duration_s : null,
    status: rec.error === false ? 'ok' : 'error'
  };
}

function fetchOf(rec) {
  return {
    tool_use_id: rec.tool_use_id,
    issued_at: typeof rec.at === 'string' ? rec.at : null,
    url: typeof rec.url === 'string' ? rec.url : null,
    final_url: typeof rec.final_url === 'string' ? rec.final_url : null,
    status: typeof rec.status === 'number' ? rec.status : null,
    errored: rec.error !== false
  };
}

// Stable sort by `at`, then file name, so equal times keep a fixed order.
const byTime = (a, b) => timeOf(a) - timeOf(b) || (a._file < b._file ? -1 : a._file > b._file ? 1 : 0);

export function turnFromRecords(records) {
  const calls = records.filter((r) => r.kind === 'search' || r.kind === 'fetch').sort(byTime);
  if (!calls.length) return null;
  const stops = records.filter((r) => r.kind === 'stop').sort(byTime);
  const stop = stops[stops.length - 1] ?? null;
  const times = calls.map((r) => r.at).filter((t) => typeof t === 'string');
  const ids = [...new Set(calls.map((r) => r.prompt_id))];
  return {
    index: 0,
    prompt: null,
    prompt_uuid: null,
    prompt_id: ids.length === 1 ? ids[0] : null,
    started_at: times[0] ?? null,
    ended_at: (stop && typeof stop.at === 'string' ? stop.at : times[times.length - 1]) ?? null,
    models: [],
    request_ids: [],
    message_ids: [],
    searches: calls.filter((r) => r.kind === 'search').map(searchOf),
    fetches: calls.filter((r) => r.kind === 'fetch').map(fetchOf),
    subagents: [],
    skipped: 0,
    answer_markdown: stop && typeof stop.answer === 'string' ? stop.answer : null,
    answer_after_tools: stop !== null,
    cited: [],
    source: 'hooks'
  };
}

export function turnsFromQueue(sessionId, { env = process.env } = {}) {
  const { records, skipped } = readQueue(sessionId, { env });
  const groups = new Map();
  for (const r of records) {
    if (r.prompt_id === null) continue;
    if (!groups.has(r.prompt_id)) groups.set(r.prompt_id, []);
    groups.get(r.prompt_id).push(r);
  }
  const turns = [...groups.values()]
    .map(turnFromRecords)
    .filter(Boolean)
    .sort((a, b) => (Date.parse(a.started_at) || 0) - (Date.parse(b.started_at) || 0));
  turns.forEach((t, i) => (t.index = i));
  return { turns, skipped };
}
