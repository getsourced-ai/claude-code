// Turn to capture detail (plan Task 7): one reader turn (reader.mjs) becomes
// the capture detail the extension's surfaces produce, through the vendored
// stageFromRecord and searchDataFromStages.
//
// Exports:
//   turnToDetail(turn, meta, { capturedVia = 'transcript' })
//     -> { kind: 'unreadable', reason }   checked first (U8)
//      | { kind: 'unfinished' }           the turn ended on a tool call
//      | { kind: 'no-search', prompt }    S1 / U7: no search with results
//      | { kind: 'capture', detail }
//   reasons: 'injected-context', 'not-typed-prompt', 'skipped',
//            'unreadable-search', 'bad-session-id', 'no-turn-key',
//            'no-prompt', 'no-time', 'missing-result', 'mixed-turn',
//            'duplicate-key', 'duplicate-records', 'background-agent'
//   'not-typed-prompt': the turn was started by a record no person typed (a
//   subagent hand-back or a task notice; reader.mjs prompt_origin, seen in
//   O1, 2026-11-15). 'background-agent': the turn launched a subagent in the
//   background, whose searches ran after the turn's answer (seen in O1).
//
// Order of checks: the unreadable reasons that hold for any turn first; then
// unfinished; then 'missing-result' (a web call with no result), which is
// only checked on a finished turn. A still-running turn always has calls
// waiting for results, so checking it after unfinished keeps the outcome
// "This turn is still running." for it.
//
// The record built here follows the prototype mapper (tools/capture/claude-code/
// src/mapper.mjs:28-106 at be14c87) without `run`, and without the local-only
// keys (mode, domain filters, fetch status and bytes, subagent type), so none
// of them can reach the detail. S1 for Claude Code is applied here, not taken
// from searchDataFromStages, which also counts query text and answer links.
// searchData.citations is always [] (S2): the answer links are inferred, and
// only stages[].quoted[] carries the provenance label beside each one;
// searchData.provenance.citations is 'heuristic' when that list is not empty.
import { isSessionId, isPromptId } from './ids.mjs';
import { turnIsSearch, turnIsFinished } from './reader.mjs';
import {
  stageFromRecord,
  searchDataFromStages,
  entityDataFromRecords,
  provenanceOf,
  toEpochSeconds,
  toEpochMs,
  validateCaptureDetail
} from './vendor.mjs';

const CAPTURED_VIA = new Set(['transcript', 'hooks']);
const MAX_MODEL_LENGTH = 100;

const isHttp = (u) => {
  if (typeof u !== 'string') return false;
  try {
    const p = new URL(u).protocol;
    return p === 'http:' || p === 'https:';
  } catch {
    return false;
  }
};

const is2xx = (status) => Number.isInteger(status) && status >= 200 && status < 300;

const allSearches = (turn) => [...turn.searches, ...turn.subagents.flatMap((a) => a.searches)];
const allFetches = (turn) => [...turn.fetches, ...turn.subagents.flatMap((a) => a.fetches)];

function turnKey(turn) {
  const key = turn.prompt_id ?? turn.prompt_uuid ?? null;
  return isPromptId(key) ? key : null;
}

function unreadableReason(turn, meta) {
  // P2: editor or harness context mixed into the typed prompt.
  if (turn.prompt_injected === true) return 'injected-context';
  // U11: no person typed what started this turn.
  if (typeof turn.prompt_origin === 'string') return 'not-typed-prompt';
  // U11: a message arrived while this turn was still working, so the answer
  // may be for either prompt (reader.mjs, "Turn starts").
  // A queued message stored as an attachment arrived before the final answer.
  if (turn.continues_previous === true || turn.cut_off === true || turn.queued_message === true) return 'mixed-turn';
  // U8: the turn's records appear twice, so its searches would count twice.
  if (turn.duplicate_records === true) return 'duplicate-records';
  // Two turns of one session hold this turn key (turns.mjs).
  if (turn.duplicate_key === true) return 'duplicate-key';
  // U11: a background subagent searched after the answer was written, so the
  // answer does not belong to those searches.
  if (turn.subagents.some((a) => a.background === true)) return 'background-agent';
  if (turn.skipped > 0) return 'skipped';
  if (allSearches(turn).some((s) => s.status === 'unreadable')) return 'unreadable-search';
  if (!isSessionId(meta?.session_id)) return 'bad-session-id';
  if (!turnKey(turn)) return 'no-turn-key';
  if (typeof turn.prompt !== 'string' || turn.prompt === '') return 'no-prompt';
  if (toEpochSeconds(turn.started_at) === null || toEpochMs(turn.ended_at) === null) return 'no-time';
  return null;
}

// One csi.capture-shaped record (only the keys stageFromRecord reads).
function recordFromTurn(turn, key) {
  const queries = [];
  const results = [];
  allSearches(turn).forEach((s, round) => {
    // Errored and zero-result searches keep their query text (the surface
    // shows it); they add no results. Empty or non-string text is left out.
    if (typeof s.query === 'string' && s.query.trim()) queries.push({ text: s.query, round });
    if (s.status !== 'ok' || !Array.isArray(s.results)) return;
    for (const r of s.results) {
      if (!isHttp(r.url) || !Number.isInteger(r.rank)) continue;
      results.push({ url: r.url, title: typeof r.title === 'string' ? r.title : '', rank: r.rank - 1, round });
    }
  });
  const opened = allFetches(turn)
    .filter((f) => isHttp(f.url) && is2xx(f.status))
    .map((f) => ({ url: f.url }));
  const citations = (turn.cited || [])
    .filter((c) => isHttp(c.url))
    .map((c) => ({
      url: c.url,
      title: typeof c.anchor === 'string' ? c.anchor : '',
      provenance: 'heuristic',
      cite_count: 1,
      cited_text: typeof c.context === 'string' && c.context ? [c.context] : []
    }));
  return {
    turn_id: key,
    prompt: turn.prompt,
    asked_at: turn.started_at,
    captured_at: turn.ended_at,
    answer_markdown: turn.answer_markdown,
    queries,
    results,
    opened,
    citations,
    entities: []
  };
}

export function turnToDetail(turn, meta, { capturedVia = 'transcript' } = {}) {
  if (!CAPTURED_VIA.has(capturedVia)) throw new TypeError('turnToDetail: capturedVia must be transcript or hooks');
  const reason = unreadableReason(turn, meta);
  if (reason) return { kind: 'unreadable', reason };
  if (!turnIsFinished(turn)) return { kind: 'unfinished' };
  // U8: a finished turn with a WebSearch or WebFetch call that never got its
  // result is missing data (a dropped or lost line).
  if (turn.missing_results > 0 || allSearches(turn).some((s) => s.status === 'pending')) return { kind: 'unreadable', reason: 'missing-result' };

  const key = turnKey(turn);
  const record = recordFromTurn(turn, key);
  // S1: a WebSearch returned at least one result, and at least one of them is
  // a page link that can be shown.
  if (!turnIsSearch(turn) || record.results.length === 0) return { kind: 'no-search', prompt: turn.prompt };

  const stage = stageFromRecord(record, 0);
  const shared = searchDataFromStages([record], [stage]);
  const model = turn.models?.[0];
  const searchData = {
    ...shared,
    // S2: the legacy citations list has no per-entry label, and every link
    // here is inferred. The labeled copies are stages[].quoted[].
    citations: [],
    hasSearch: true,
    provenance: { citations: provenanceOf(stage.quoted), entities: null },
    ...(typeof model === 'string' && model && model.length <= MAX_MODEL_LENGTH ? { model } : {})
  };

  const detail = {
    conversationId: `${meta.session_id}.${key}`,
    surface: 'claude_code',
    searchData,
    stages: [stage],
    entityData: entityDataFromRecords([record]),
    answerMarkdown: stage.answerMarkdown,
    prompt: turn.prompt,
    title: null,
    createTime: toEpochSeconds(turn.started_at),
    timestamp: toEpochMs(turn.ended_at),
    client: 'logged-in',
    capturedVia,
    partial: false
  };
  const check = validateCaptureDetail(detail, 'claude_code');
  if (!check.ok) return { kind: 'unreadable', reason: check.reason };
  return { kind: 'capture', detail };
}
