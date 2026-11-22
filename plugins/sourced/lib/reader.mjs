// Reader: Claude Code transcript records -> per-user-turn web activity.
//
// Ported from the capture prototype `tools/capture/claude-code/src/reader.mjs`
// (and readSession from `capture.mjs`) at commit be14c87. Read only: it never
// writes, never calls the network, and copies only web fields. cwd, gitBranch,
// account/org ids, the session title, file contents and other tool calls are
// never copied into the output.
//
// Exports:
//   READER_VERSION                 3 (the prototype was 1; 3 adds prompt_origin,
//                                  subagent background and the hand-back rules)
//   readRecords(records, { badAt }) -> { meta, turns } | { unsupported: 'stream-json', meta, turns: [] }
//                                  badAt (optional) is parseJsonl's list of
//                                  bad line positions (see "Damaged lines").
//   attachSubagents(result, subs)  joins readSubagents() output into result (mutates, returns it)
//   readSession(target, { root })  target = session id (UUID) or path to a .jsonl
//                                  transcript; reads it and attaches subagents.
//                                  Throws when the id is not a UUID, no
//                                  transcript is found, or the id is ambiguous
//                                  (more than one project folder holds it).
//                                  root defaults to projectsRoot(process.env).
//   promptFromRecord(r)            -> { text, injected } | null: the prompt
//                                  text of a record that starts a turn (see
//                                  "Injected context").
//   INJECTED_TAGS                  the tag names below (ide_* is a prefix)
//   turnIsSearch(turn)             S1: some search (main thread or joined
//                                  subagent) has status 'ok' and >= 1 result
//   turnIsFinished(turn)           answer_after_tools === true
//
// Shapes. meta: { session_id, cli_version, entrypoint, format, search_models,
// skipped, orphan_subagents: { agents, searches, fetches },
// bad_lines (readSession), subagent_bad_lines (attachSubagents) }.
// turn: { index, prompt, prompt_uuid, prompt_id, started_at, ended_at, models,
// request_ids, message_ids, searches, fetches, subagents, answer_markdown,
// answer_after_tools, cited, skipped }, plus, only when they apply,
// prompt_injected: true, continues_previous: true, cut_off: true,
// queued_message: true, duplicate_records: true, missing_results: <n> (a
// finished turn only) and prompt_origin: '<kind>' (a turn not started by a
// typed prompt, see "Turn starts"). A subagent entry gets background: true
// when it was launched in the background.
//
// Which shapes are real. Seen in a real session (O1, 2026-11-15, Claude Code
// 2.1.325, tests/fixtures/claude-code/transcript-o1.jsonl): the human prompt
// record (origin.kind 'human', promptId on user records only); a typed slash
// command (a human record of <command-message>/<command-name>/<command-args>
// followed by an isMeta expansion with the same promptId); a model-run
// command (a Skill tool_use, then isMeta records, no human record); a
// shell-mode command (<bash-input>, then <bash-stdout>, with a promptId and no
// origin); WebSearch and WebFetch tool_use/tool_result records; Agent calls
// for a foreground web-fetch subagent and a background general-purpose one,
// with their subagents/ files and meta.json; the queued_command attachment
// for a human message sent mid-turn and for a subagent hand-back; the
// hand-back of a background subagent as an isMeta user record with
// origin.kind 'peer' and a new promptId; and a task-notification user record
// with origin.kind 'task-notification' and its own promptId. Built by hand
// and not yet seen: editor context (ide_* blocks), compaction summaries,
// interrupts, API errors, damaged lines, teammate (orphan) subagents and a
// mid-turn message stored as a user record with a new prompt id.
//
// Injected context (P2). Claude Code puts editor and harness context into the
// prompt record as text blocks: <ide_opened_file>, <ide_selection>,
// <system-reminder>, shell-mode <bash-input>/<bash-stdout>/<bash-stderr> and
// the like. A text block that, trimmed, starts with <tag ...> for a tag in
// INJECTED_TAGS (or any ide_* or ide-* tag; names match in any case) and ends
// with the same tag's </tag> is dropped from the prompt. A remaining text (or
// a string prompt) that still holds such an opening or closing tag anywhere
// is not split by guess: the turn gets prompt_injected: true and turnToDetail
// makes it unreadable (injected-context). Image and document blocks are never
// prompt text. Pasted content is kept: the user chose to send it. Full-width
// brackets are typed text.
//
// Turn starts (U11: an answer is never attributed to a prompt other than the
// one that produced it; when unsure, split and make the new turn unreadable).
// For each user record:
//   - Not typed by a person (U11): a record whose origin.kind is set and is
//     not 'human' (a subagent hand-back has 'peer', a background task's
//     notice 'task-notification') never gives prompt text. Such a record, or
//     an isMeta record, whose promptId is present and differs from the open
//     turn's starts a turn with prompt: null and prompt_origin set to its
//     origin.kind (or 'meta'); turnToDetail makes it unreadable
//     ('not-typed-prompt'), so an answer written for a hand-back never joins
//     the human turn before it. When the next record holds typed prompt text
//     with that same promptId and the turn has no output yet, the prompt is
//     taken from it and prompt_origin is dropped (an isMeta record written
//     before its own prompt).
//   - Ignored (no effect): other isMeta, isSidechain and isCompactSummary
//     records.
//   - Continue the open turn: a record holding a tool_result (or a
//     toolUseResult); an interrupt marker (which also makes the turn
//     unfinished); any record whose promptId equals the open turn's prompt_id.
//   - Start a turn with its prompt text: a record promptFromRecord gives text.
//   - Start a turn with prompt: null (turnToDetail: unreadable 'no-prompt'):
//     any other record whose promptId is present and differs from the open
//     turn's (an image or document alone, only injected context, typed text
//     that begins with an injected tag, empty text, a local echo); and, with
//     no promptId, any such record that is not a local echo.
//   - A local echo with no promptId (its whole content is <command-name>,
//     <command-message>, <command-args>, <local-command-stdout/stderr> or
//     <bash-input/stdout/stderr> elements, or the local-command caveat) is no
//     turn start, but closes the open turn: assistant output after it starts
//     a turn with no prompt and no key (unreadable), and damaged lines after
//     it still count against the closed turn.
//   - Not a prompt (promptFromRecord null, so the rules above for records
//     with no prompt text apply): text that begins with "This session is
//     being continued from a previous conversation" (a compaction summary
//     without its flag) or "<Name> hook feedback:" (hook feedback without
//     isMeta).
//   - Mid-turn messages. When a turn starts (with or without prompt text)
//     while the open turn is in flight (it has a tool call and no answer
//     text after its last one, its last message stopped for a tool call, or
//     a web call still waits for a result; an interrupted turn or one that
//     ended on an API error is not in flight), the new turn gets
//     continues_previous: true and the open one cut_off: true. A local echo
//     that closes an in-flight turn marks it cut_off too. turnToDetail makes
//     both unreadable ('mixed-turn'): the answer that follows may have been
//     written for either prompt. A transcript that just ends mid-turn has no
//     such mark and stays unfinished.
//   - Queued attachments. Claude Code stores a message the user sends
//     mid-turn not as a user record but as an `attachment` record whose
//     attachment.type is 'queued_command' (seen in O1, with origin.kind
//     'human' and humanTurn: true, no promptId, and queue-operation enqueue
//     and remove records around it; any type containing "queued", in any
//     case, is treated the same). The model sees that text while it is still
//     answering, so when one arrives while the open turn has no final answer
//     yet (no answer text after its last tool call, a message stopped for a
//     tool call, or a web call still waiting for a result), the turn gets
//     queued_message: true and turnToDetail makes it unreadable
//     ('mixed-turn'). The exception is a subagent hand-back (seen in O1: the
//     same attachment type with origin.kind 'peer', origin.handback true and
//     origin.from the subagent's agent id): when origin.from is the agent id
//     of a subagent this turn launched, it is that subagent's result, like a
//     tool result, and has no effect. A hand-back from any other agent marks
//     the turn as for a human message. Its text is never read as a prompt.
//     One that arrives after the final answer, or with no open turn, has no
//     effect. Other attachment types (environment, instructions,
//     skill_listing, date, ...) are context, not user input, and are
//     ignored.
//   - Background subagents. An Agent call whose result says it was launched
//     in the background (seen in O1: toolUseResult.isAsync true and status
//     'async_launched'; meta.json requestShape 'background') runs after its
//     turn's answer, and its hand-back starts a new turn. Its searches are
//     still joined to the launching turn, whose subagent entry gets
//     background: true; turnToDetail makes that turn unreadable
//     ('background-agent'), because its answer was written before those
//     searches ran.
//
// Repeated records (U8). A turn whose records appear twice (a transcript
// copied or resumed into the same file) would count its searches twice. When
// a WebSearch, WebFetch or Agent/Task tool_use id appears a second time in one
// turn, or a prompt record with the turn's prompt id and the same prompt text
// arrives after the turn already has assistant output, the turn gets
// duplicate_records: true and turnToDetail makes it unreadable
// ('duplicate-records'). The check is on the tool_use block id, not on
// message.id: one assistant message is normally written as several records
// sharing its message.id. A joined subagent file with repeated records marks
// its parent turn the same way.
//
// Damaged lines (U8). A bad line (badAt) that falls after a turn's first
// record and before the next turn's first record, or after the last turn
// starts, counts in that turn's `skipped`, so the turn is unreadable. A bad
// line before the first turn has no turn and counts only in meta.bad_lines.
// The exception is a bad final line with no newline after it: that is the
// normal half-written tail of a live file. It is not counted against the last
// turn. When that turn has no answer after its tools it is unfinished anyway;
// when it already has one, the tail is the next record being written and the
// turn read so far is complete, so today's behaviour is kept.
//
// Missing results (U8). A WebSearch or WebFetch call (main thread or joined
// subagent) that never got a tool_result in a turn that is otherwise finished
// is counted in missing_results; turnToDetail makes such a turn unreadable
// (missing-result). In an unfinished turn it is normal and not counted.
// search.status: 'pending' | 'ok' | 'error' | 'unreadable'.
// fetch: status is the HTTP code (or null); errored is a boolean.
//
// Changes from the prototype:
//   - No stream-json input. A stream-json init record gives
//     { unsupported: 'stream-json', meta, turns: [] } instead of a guess.
//   - The WebFetch prompt, the search summary and error text are dropped at
//     read time. Searches keep only status 'error'; fetches keep `errored`.
//   - An unfinished turn (answer_after_tools false) has answer_markdown null
//     and cited [], so interim narration is never taken for an answer.
//   - Explicit shape checks: a non-object record, an assistant (or tool
//     result) record whose message.content is not an array, a WebSearch whose
//     query is not a string, a WebFetch whose url is not a string, a search
//     result whose `results` is not an array (status 'unreadable') and a
//     result item whose url is not a string are skipped and counted in
//     meta.skipped and in the open turn's `skipped`.
//   - The Agent/Task call description and every cost figure (the prototype's
//     meta.cost_usd) are dropped at read time.
//   - An API-error assistant record (isApiErrorMessage, or model
//     '<synthetic>') is never answer text, and a turn whose last assistant
//     output is one is unfinished. So is a turn that holds an interrupt marker
//     ('[Request interrupted ...'), and answer text must have non-whitespace
//     content.
//   - Turn starts follow "Turn starts" above (the prototype skipped a user
//     record with no prompt text, so its answer joined the turn before).
//   - A tool_use whose id fails isToolUseId is skipped and counted. A result
//     title that is not a string becomes null. A record-level toolUseResult is
//     applied only when its record holds exactly one tool_result block;
//     otherwise its searches are 'unreadable' and every block is counted in
//     skipped.
//   - Orphan subagents (teammates) are counts only in meta.orphan_subagents
//     and never put into a turn.
//   - turnIsSearch and turnIsFinished replace turnHasWeb (which counted fetches).
import { existsSync } from 'node:fs';
import { readJsonl, findTranscripts, readSubagents } from './jsonl.mjs';
import { extractLinks, normalizeUrl, hostOf } from './links.mjs';
import { isSessionId, isToolUseId } from './ids.mjs';
import { projectsRoot } from './paths.mjs';

export const READER_VERSION = 3;

const AGENT_TOOLS = new Set(['Agent', 'Task']);

const NOT_A_PROMPT = /^\s*(<local-command-|<command-name>|<command-message>|<bash-|<system-reminder>|\[Request interrupted|Caveat: The messages below)/i;
// Harness text Claude Code can write as a plain user record: a compaction
// summary that lost its isCompactSummary flag, and hook feedback ("Stop hook
// feedback:", "PostToolUse:WebSearch hook feedback:") without isMeta.
const HARNESS_TEXT = /^\s*(This session is being continued from a previous conversation|[\w:.-]+ hook feedback\s*(?::|\n|$))/i;

export const INJECTED_TAGS = Object.freeze([
  'ide_*',
  'ide-*',
  'system-reminder',
  'local-command-stdout',
  'local-command-stderr',
  'command-name',
  'command-message',
  'command-args',
  'user-prompt-submit-hook',
  'task-notification',
  'bash-input',
  'bash-stdout',
  'bash-stderr'
]);
const TAG_NAME =
  '(ide[_-][A-Za-z0-9_-]*|system-reminder|local-command-stdout|local-command-stderr|command-name|command-message|command-args|user-prompt-submit-hook|task-notification|bash-input|bash-stdout|bash-stderr)';
// The whole block is one such element: <tag ...> ... </tag>. Tag names match
// in any case (the backreference too, under the i flag).
const INJECTED_BLOCK = new RegExp(`^<${TAG_NAME}(?:\\s[^>]*)?>[\\s\\S]*</\\1\\s*>$`, 'i');
// An opening tag anywhere.
const INJECTED_OPEN = new RegExp(`<${TAG_NAME}(?=[\\s>/])`, 'i');
// A closing tag anywhere (a block cut off before its opening tag).
const INJECTED_CLOSE = new RegExp(`</${TAG_NAME}\\s*>`, 'i');
const holdsTag = (t) => INJECTED_OPEN.test(t) || INJECTED_CLOSE.test(t);

// Local slash-command and shell-mode echo: records Claude Code writes for a
// command the user ran locally. They are not model-visible user input.
const LOCAL_TAG = '(command-name|command-message|command-args|local-command-stdout|local-command-stderr|bash-input|bash-stdout|bash-stderr)';
const LOCAL_ELEMENT = new RegExp(`^\\s*<${LOCAL_TAG}(?:\\s[^>]*)?>[\\s\\S]*?</\\1\\s*>`, 'i');
const CAVEAT = /^\s*Caveat: The messages below/;

const INTERRUPT = /^\s*\[Request interrupted/;

const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

// An attachment record that carries a message queued mid-turn.
const isQueuedAttachment = (r) => r.type === 'attachment' && isPlainObject(r.attachment) && typeof r.attachment.type === 'string' && /queued/i.test(r.attachment.type);

// A queued attachment that is the hand-back of a subagent the open turn
// launched (seen in O1: origin.kind 'peer', handback true, from = agent id).
function isOwnHandback(r, turn) {
  const o = r.attachment.origin;
  if (!isPlainObject(o) || o.kind !== 'peer' || o.handback !== true || typeof o.from !== 'string') return false;
  return turn.subagents.some((a) => a.agent_id === o.from);
}

// The record carries an origin that is not a person typing (O1: 'peer',
// 'task-notification'). Records with no origin (older transcripts) are not
// judged by it.
const hasNonHumanOrigin = (r) => isPlainObject(r.origin) && r.origin.kind !== 'human';

// The prompt_origin of a turn a non-typed record starts.
function originOf(r) {
  if (hasNonHumanOrigin(r)) return typeof r.origin.kind === 'string' && /^[a-z][a-z-]{0,39}$/.test(r.origin.kind) ? r.origin.kind : 'other';
  return r.isMeta === true ? 'meta' : null;
}

const isToolResultRecord = (r) => r.toolUseResult !== undefined || (Array.isArray(r.message?.content) && r.message.content.some((b) => b?.type === 'tool_result'));

// One whole <tag>...</tag> element with no second listed tag opened inside.
function isInjectedBlock(text) {
  const t = text.trim();
  const m = INJECTED_BLOCK.exec(t);
  if (!m) return false;
  const open = t.indexOf('>') + 1;
  const close = t.lastIndexOf('</');
  return !INJECTED_OPEN.test(t.slice(open, close));
}

// A user record that starts a turn: real prompt text, not a tool result,
// not a meta/compaction/sidechain record. Injected context blocks are dropped
// (see the header); { text, injected } or null.
export function promptFromRecord(r) {
  if (!isPlainObject(r) || r.type !== 'user' || r.isMeta || r.isCompactSummary || r.isSidechain) return null;
  // A hand-back or a task notice is never a prompt the user typed (U11).
  if (hasNonHumanOrigin(r)) return null;
  if (r.toolUseResult !== undefined) return null;
  const c = r.message?.content;
  let text = null;
  let injected = false;
  if (typeof c === 'string') {
    text = c;
    injected = holdsTag(c);
  } else if (Array.isArray(c)) {
    if (c.some((b) => b?.type === 'tool_result')) return null;
    const blocks = c.filter((b) => b?.type === 'text' && typeof b.text === 'string').map((b) => b.text);
    // A slash command or local command record keeps being no prompt, as before.
    if (blocks.length && /^\s*(<local-command-|<command-name>|<command-message>)/i.test(blocks[0])) return null;
    const kept = blocks.filter((t) => !isInjectedBlock(t));
    if (kept.length) {
      text = kept.join('\n');
      injected = kept.some(holdsTag);
    }
  }
  // Whitespace alone is no prompt text.
  if (text == null || text.trim() === '' || NOT_A_PROMPT.test(text) || HARNESS_TEXT.test(text)) return null;
  return { text, injected };
}

// Every text of a record (string content or text blocks) is one or more whole
// local command or shell-mode elements, or the local-command caveat.
function isLocalEcho(r) {
  const c = r.message?.content;
  const texts = typeof c === 'string' ? [c] : Array.isArray(c) ? c.map((b) => (b?.type === 'text' && typeof b.text === 'string' ? b.text : null)) : [];
  if (!texts.length || texts.some((t) => t === null)) return false;
  return texts.every((t) => {
    if (CAVEAT.test(t)) return true;
    let rest = t;
    let n = 0;
    for (let m = LOCAL_ELEMENT.exec(rest); m; m = LOCAL_ELEMENT.exec(rest)) {
      rest = rest.slice(m[0].length);
      n += 1;
    }
    return n > 0 && rest.trim() === '';
  });
}

// How a user record that gives no prompt text (promptFromRecord null) bears
// on turns (see "Turn starts" in the header):
//   'skip'   meta, sidechain or compaction summary: no effect
//   'tool'   holds a tool result: continues the open turn
//   'interrupt'  continues the open turn and marks it interrupted
//   'local'  local slash-command or shell-mode echo
//   'input'  any other user input (images, documents, only injected
//            context, typed text that begins with an injected tag, empty)
function userKind(r) {
  if (r.isMeta || r.isCompactSummary || r.isSidechain) return 'skip';
  const c = r.message?.content;
  if (r.toolUseResult !== undefined || (Array.isArray(c) && c.some((b) => b?.type === 'tool_result'))) return 'tool';
  if (isInterrupt(r)) return 'interrupt';
  if (isLocalEcho(r)) return 'local';
  return 'input';
}

// A user record that carries an interrupt marker (as string content or a
// text block).
function isInterrupt(r) {
  if (r.type !== 'user' || r.isMeta || r.isSidechain) return false;
  const c = r.message?.content;
  if (typeof c === 'string') return INTERRUPT.test(c);
  return Array.isArray(c) && c.some((b) => b?.type === 'text' && typeof b.text === 'string' && INTERRUPT.test(b.text));
}

const isApiError = (r) => r.isApiErrorMessage === true || r.message?.model === '<synthetic>';

// toolUseResult = {query, results:[{tool_use_id:"srvtoolu_…", content:[{title,url}]}, "<summary>"], durationSeconds, searchCount}
// The summary strings are skipped, never kept.
function parseSearchResult(tur, skip) {
  const results = [];
  const inner = [];
  let rank = 0;
  for (const entry of tur.results) {
    if (typeof entry === 'string') continue;
    if (!entry || !Array.isArray(entry.content)) continue;
    inner.push(entry.tool_use_id || null);
    for (const r of entry.content) {
      if (!r?.url) continue;
      if (typeof r.url !== 'string') {
        skip();
        continue;
      }
      rank += 1;
      results.push({
        rank,
        inner_search: inner.length,
        title: typeof r.title === 'string' ? r.title : null,
        url: r.url,
        host: hostOf(r.url),
        snippet: null,
        page_age: null
      });
    }
  }
  return { results, inner_search_ids: inner };
}

function emptyOrphans() {
  return { agents: 0, searches: 0, fetches: 0 };
}

// Parse one flat list of transcript records. Returns {meta, turns}.
export function readRecords(records, opts = {}) {
  return readCore(records, opts).result;
}

// Bad line positions that are not the half-written tail, in record order.
const midFileBad = (badAt) =>
  (Array.isArray(badAt) ? badAt : [])
    .filter((b) => isPlainObject(b) && Number.isInteger(b.before) && b.tail !== true)
    .map((b) => b.before)
    .sort((a, b) => a - b);

// readRecords plus the count of web calls still waiting for a result.
function readCore(records, { badAt } = {}) {
  if (!Array.isArray(records)) throw new TypeError('readRecords: records must be an array');
  const meta = {
    session_id: null,
    cli_version: null,
    entrypoint: null,
    format: 'transcript',
    search_models: [],
    skipped: 0,
    orphan_subagents: emptyOrphans()
  };
  const turns = [];
  let cur = null;
  // The turn a damaged line or skipped record counts against: the open turn,
  // or, after a local echo closed it, that closed turn until the next starts.
  let sink = null;
  const toolIndex = new Map(); // tool_use_id -> {kind, obj}
  const pending = new Set(); // search and fetch objects with no tool_result yet
  const bad = midFileBad(badAt);
  let badNext = 0;
  // A damaged line between records counts against the open turn.
  const takeBad = (upTo) => {
    while (badNext < bad.length && bad[badNext] <= upTo) {
      if (sink) sink.skipped += 1;
      badNext += 1;
    }
  };
  const skip = () => {
    meta.skipped += 1;
    if (cur ?? sink) (cur ?? sink).skipped += 1;
  };

  // The open turn is in flight: it has made a tool call and has no answer
  // text after its last one, it ended on a message that stopped for a tool
  // call, or a web call of it still waits for a result. An interrupt or an
  // API error ends a turn, so such a turn is not in flight.
  const inFlight = (t) => {
    if (!t || t.interrupted || t.endedOnError) return false;
    if ([...t.searches, ...t.fetches].some((o) => pending.has(o))) return true;
    if (t.lastToolSeq < 0) return false;
    if (t.lastStop === 'tool_use') return true;
    return !t.texts.some((x) => x.seq > t.lastToolSeq && x.text.trim() !== '');
  };

  // The open turn has its final answer: answer text after its last tool call,
  // its last message did not stop for a tool call, and no web call waits.
  const answered = (t) =>
    t.lastStop !== 'tool_use' &&
    ![...t.searches, ...t.fetches].some((o) => pending.has(o)) &&
    t.texts.some((x) => x.seq > t.lastToolSeq && x.text.trim() !== '');

  const startTurn = (prompt, r, injected = false, origin = null) => {
    // A turn that starts while the open one is in flight (a message queued or
    // typed mid-turn): what follows may answer either prompt, so both are
    // marked and neither can upload (U11, turnToDetail 'mixed-turn').
    const mixed = inFlight(cur);
    if (mixed) cur.cut_off = true;
    cur = {
      index: turns.length,
      prompt,
      injected,
      prompt_uuid: r?.uuid ?? null,
      prompt_id: r?.promptId ?? null,
      started_at: r?.timestamp ?? null,
      ended_at: r?.timestamp ?? null,
      models: [],
      request_ids: [],
      message_ids: [],
      searches: [],
      fetches: [],
      subagents: [],
      skipped: 0,
      texts: [], // {seq, text, message_id}
      lastToolSeq: -1,
      endedOnError: false,
      interrupted: false,
      lastStop: null,
      seq: 0,
      hasOutput: false,
      toolIds: new Set(), // watched tool_use ids seen in this turn
      queued: false,
      duplicate: false
    };
    if (mixed) cur.continues_previous = true;
    const from = origin ?? (r && prompt === null ? originOf(r) : null);
    if (from) cur.prompt_origin = from;
    turns.push(cur);
    sink = cur;
  };

  for (let i = 0; i < records.length; i++) {
    takeBad(i);
    const r = records[i];
    if (!isPlainObject(r)) {
      skip();
      continue;
    }
    if (r.type === 'system' && r.subtype === 'init') {
      meta.format = 'stream-json';
      return { result: { unsupported: 'stream-json', meta, turns: [] }, pending: 0 };
    }
    meta.session_id ??= r.sessionId ?? null;
    meta.cli_version ??= r.version ?? null;
    meta.entrypoint ??= r.entrypoint ?? null;
    // Search model: transcript `cost-state`. Cost figures are not kept.
    const mu = r.type === 'cost-state' ? r.modelUsage ?? r.state?.modelUsage : null;
    if (isPlainObject(mu)) {
      meta.search_models = Object.entries(mu)
        .filter(([, v]) => v && v.webSearchRequests > 0)
        .map(([k, v]) => ({ model: k, web_search_requests: v.webSearchRequests }));
    }
    // A queued message stored as an attachment while the open turn has no
    // final answer yet: the answer may be for either text (see the header).
    if (isQueuedAttachment(r) && !r.isSidechain && cur && !answered(cur)) {
      // A hand-back of this turn's own subagent is its result, not a message.
      if (!isOwnHandback(r, cur)) cur.queued = true;
      continue;
    }
    if (r.type !== 'user' && r.type !== 'assistant') continue;
    if (r.type === 'assistant' && r.isSidechain) continue;

    // A record not typed by a person, with a new prompt id: its own turn with
    // no prompt (see "Turn starts").
    if (
      r.type === 'user' &&
      !r.isSidechain &&
      !r.isCompactSummary &&
      (r.isMeta === true || hasNonHumanOrigin(r)) &&
      r.promptId != null &&
      r.promptId !== cur?.prompt_id &&
      !isToolResultRecord(r)
    ) {
      startTurn(null, r, false, originOf(r));
      continue;
    }

    const p = promptFromRecord(r);
    if (p != null) {
      // Same prompt id as the open turn: a follow-up inside that turn.
      if (cur && cur.prompt_id != null && r.promptId != null && r.promptId === cur.prompt_id) {
        // An isMeta record of this prompt id came first: this is its prompt.
        if (cur.prompt === null && cur.prompt_origin === 'meta' && !cur.hasOutput) {
          cur.prompt = p.text;
          cur.injected = p.injected;
          cur.prompt_uuid = r.uuid ?? null;
          delete cur.prompt_origin;
          continue;
        }
        // The same prompt again after the turn has output: repeated records.
        if (cur.hasOutput && p.text === cur.prompt) cur.duplicate = true;
        continue;
      }
      startTurn(p.text, r, p.injected);
      continue;
    }
    if (r.type === 'user') {
      const kind = userKind(r);
      if (kind === 'local' || kind === 'input') {
        const hasId = r.promptId != null;
        // The same prompt id as the open turn: still that turn.
        if (hasId && cur && r.promptId === cur.prompt_id) continue;
        if (hasId || kind === 'input') {
          // A new prompt with no usable text: its own turn, with no prompt
          // (unreadable 'no-prompt'), so its answer never joins the turn before.
          startTurn(null, r);
        } else {
          // A local echo with no prompt id is no turn start, but whatever
          // follows it is not the open turn's either.
          if (inFlight(cur)) cur.cut_off = true;
          cur = null;
        }
        continue;
      }
    }
    if (cur && isInterrupt(r)) cur.interrupted = true;
    const content = r.message?.content;
    if (r.type === 'user') {
      // A tool result must carry its blocks in an array.
      if (r.toolUseResult !== undefined && !Array.isArray(content)) {
        skip();
        continue;
      }
      // User records that are neither prompts nor tool results (local command
      // output, meta, interrupts) carry no web data.
      if (!Array.isArray(content) || !content.some((b) => b?.type === 'tool_result')) continue;
    } else if (!Array.isArray(content)) {
      skip();
      continue;
    }
    if (!cur) startTurn(null, null);
    if (r.timestamp) {
      cur.started_at ??= r.timestamp;
      cur.ended_at = r.timestamp;
    }

    if (r.type === 'assistant') cur.hasOutput = true;
    if (r.type === 'assistant' && isApiError(r)) {
      // An API error is never answer text and carries no web data.
      cur.endedOnError = true;
      continue;
    }

    if (r.type === 'assistant') {
      cur.endedOnError = false;
      const m = r.message;
      cur.lastStop = typeof m.stop_reason === 'string' ? m.stop_reason : null;
      if (m.model && m.model !== '<synthetic>' && !cur.models.includes(m.model)) cur.models.push(m.model);
      const rid = r.requestId;
      if (rid && !cur.request_ids.includes(rid)) cur.request_ids.push(rid);
      if (m.id && !cur.message_ids.includes(m.id)) cur.message_ids.push(m.id);
      for (const b of content) {
        cur.seq += 1;
        if (b?.type === 'text' && b.text) cur.texts.push({ seq: cur.seq, text: b.text, message_id: m.id ?? null });
        if (b?.type !== 'tool_use') continue;
        cur.lastToolSeq = cur.seq;
        const watched = b.name === 'WebSearch' || b.name === 'WebFetch' || AGENT_TOOLS.has(b.name);
        if (watched && !isToolUseId(b.id)) {
          skip();
          continue;
        }
        if (watched) {
          // The same call a second time in this turn: repeated records.
          if (cur.toolIds.has(b.id)) {
            cur.duplicate = true;
            continue;
          }
          cur.toolIds.add(b.id);
        }
        const inp = isPlainObject(b.input) ? b.input : {};
        if (b.name === 'WebSearch') {
          if (typeof inp.query !== 'string') {
            skip();
            continue;
          }
          const s = {
            tool_use_id: b.id,
            batch_id: m.id ?? null,
            query: inp.query,
            mode: inp.mode ?? null,
            allowed_domains: inp.allowed_domains ?? null,
            blocked_domains: inp.blocked_domains ?? null,
            max_results: inp.max_results ?? null,
            issued_at: r.timestamp ?? null,
            results: [],
            inner_search_ids: [],
            search_count: null,
            duration_s: null,
            status: 'pending'
          };
          cur.searches.push(s);
          pending.add(s);
          toolIndex.set(b.id, { kind: 'search', obj: s });
        } else if (b.name === 'WebFetch') {
          if (typeof inp.url !== 'string') {
            skip();
            continue;
          }
          const f = {
            tool_use_id: b.id,
            batch_id: m.id ?? null,
            url: inp.url,
            issued_at: r.timestamp ?? null,
            final_url: null,
            status: null,
            status_text: null,
            bytes: null,
            duration_ms: null,
            errored: false
          };
          cur.fetches.push(f);
          pending.add(f);
          toolIndex.set(b.id, { kind: 'fetch', obj: f });
        } else if (AGENT_TOOLS.has(b.name)) {
          const a = {
            tool_use_id: b.id,
            agent_type: inp.subagent_type ?? null,
            agent_id: null,
            model: null,
            status: null,
            searches: [],
            fetches: []
          };
          cur.subagents.push(a);
          toolIndex.set(b.id, { kind: 'agent', obj: a });
        }
      }
      continue;
    }

    // user record with tool results
    // The record-level toolUseResult belongs to one block; with several
    // blocks it cannot be told which, so it is applied to none.
    const tur = r.toolUseResult;
    const ambiguous = content.filter((b) => b?.type === 'tool_result').length > 1 && tur !== undefined;
    for (const b of content) {
      if (b?.type !== 'tool_result') continue;
      const hit = toolIndex.get(b.tool_use_id);
      if (!hit) continue;
      const o = hit.obj;
      pending.delete(o);
      if (ambiguous && b.is_error !== true) {
        if (hit.kind === 'search') o.status = 'unreadable';
        skip();
        continue;
      }
      const isErr = b.is_error === true || tur === undefined || typeof tur === 'string';
      if (hit.kind === 'search') {
        if (isErr || !isPlainObject(tur)) {
          o.status = 'error';
        } else if (!Array.isArray(tur.results)) {
          o.status = 'unreadable';
          skip();
        } else {
          Object.assign(o, parseSearchResult(tur, skip));
          o.search_count = tur.searchCount ?? null;
          o.duration_s = tur.durationSeconds ?? null;
          o.status = 'ok';
        }
      } else if (hit.kind === 'fetch') {
        if (!isErr && isPlainObject(tur)) {
          o.final_url = tur.url ?? null;
          o.status = tur.code ?? null;
          o.status_text = tur.codeText ?? null;
          o.bytes = tur.bytes ?? null;
          o.duration_ms = tur.durationMs ?? null;
        } else {
          o.errored = true;
        }
      } else if (hit.kind === 'agent') {
        if (isPlainObject(tur)) {
          o.agent_id = tur.agentId ?? null;
          o.model = tur.resolvedModel ?? null;
          o.status = tur.status ?? null;
          o.agent_type ??= tur.agentType ?? null;
          // Seen in O1: a background launch returns at once with this.
          if (tur.isAsync === true || tur.status === 'async_launched') o.background = true;
        }
      }
    }
  }

  takeBad(Infinity);
  const pendingIn = (t) => [...t.searches, ...t.fetches].filter((o) => pending.has(o)).length;
  const pendingAll = turns.reduce((n, t) => n + pendingIn(t), 0);
  return { result: { meta, turns: turns.map((t) => finishTurn(t, pendingIn(t))) }, pending: pendingAll };
}

function finishTurn(t, missing = 0) {
  // Final answer = assistant text after the last tool call. When the turn
  // ended on a tool call (an interrupted run), on an API error, or holds an
  // interrupt marker, there is no answer: the last text is interim narration
  // and is not kept. Whitespace-only text is not an answer.
  const after = t.texts.filter((x) => x.seq > t.lastToolSeq);
  const answerAfterTools = !t.endedOnError && !t.interrupted && after.some((x) => x.text.trim() !== '');
  const answer = answerAfterTools ? after.map((x) => x.text).join('\n\n') || null : null;
  const { texts, lastToolSeq, seq, endedOnError, interrupted, injected, lastStop, cut_off, continues_previous, hasOutput, toolIds, queued, duplicate, ...rest } = t;
  const out = { ...rest, answer_markdown: answer, answer_after_tools: answerAfterTools, cited: answerAfterTools ? deriveCited(answer, rest) : [] };
  // Present only when they apply, so ordinary turns keep their shape.
  if (injected) out.prompt_injected = true;
  if (continues_previous) out.continues_previous = true;
  if (cut_off) out.cut_off = true;
  if (queued) out.queued_message = true;
  if (duplicate) out.duplicate_records = true;
  if (answerAfterTools && missing > 0) out.missing_results = missing;
  return out;
}

// Heuristic citations: markdown links in the final answer, matched back to
// search results and fetches by normalized URL.
function deriveCited(answer, turn) {
  const byUrl = new Map();
  const allSearches = [...turn.searches, ...turn.subagents.flatMap((a) => a.searches)];
  allSearches.forEach((s, si) => {
    for (const r of s.results) {
      const k = normalizeUrl(r.url);
      if (k && !byUrl.has(k)) byUrl.set(k, { search_index: si, rank: r.rank });
    }
  });
  const fetched = new Set(
    [...turn.fetches, ...turn.subagents.flatMap((a) => a.fetches)].flatMap((f) => [normalizeUrl(f.url), normalizeUrl(f.final_url)]).filter(Boolean)
  );
  const seen = new Set();
  const out = [];
  for (const l of extractLinks(answer)) {
    const k = normalizeUrl(l.url);
    if (!k || seen.has(k)) continue;
    seen.add(k);
    const match = byUrl.get(k) || null;
    out.push({
      url: l.url,
      host: hostOf(l.url),
      anchor: l.anchor,
      position: out.length + 1,
      context: l.context,
      in_sources_list: l.in_sources_list,
      in_results: !!match,
      result_search_index: match?.search_index ?? null,
      result_rank: match?.rank ?? null,
      fetched: fetched.has(k),
      provenance: 'heuristic'
    });
  }
  return out;
}

// Attach subagent searches/fetches to the Agent call that spawned them.
// `subagents` = output of readSubagents(). Records skipped inside a joined
// subagent count toward its turn's `skipped`.
export function attachSubagents(result, subagents) {
  if (!Array.isArray(subagents)) throw new TypeError('attachSubagents: subagents must be an array');
  const byToolUse = new Map();
  const byAgentId = new Map();
  for (const t of result.turns) {
    for (const a of t.subagents) {
      byToolUse.set(a.tool_use_id, { a, t });
      if (a.agent_id) byAgentId.set(a.agent_id, { a, t });
    }
  }
  // A subagent file is one conversation: read it as a single turn, ignoring
  // the isSidechain flag its records carry.
  const parsed = subagents.map((sa) => {
    const recs = sa.records.map((r) => (isPlainObject(r) ? { ...r, isSidechain: false } : r));
    const { result: sub, pending: subPending } = readCore(recs);
    // Every damaged line in a joined subagent file counts against its turn,
    // except a half-written tail: the subagent may still be writing it.
    const subBad = midFileBad(sa.badAt).length;
    return {
      sa,
      searches: sub.turns.flatMap((x) => x.searches),
      fetches: sub.turns.flatMap((x) => x.fetches),
      model: sub.turns.flatMap((x) => x.models)[0] ?? null,
      duplicate: sub.turns.some((x) => x.duplicate_records === true),
      skipped: sub.meta.skipped,
      bad: subBad,
      pending: subPending
    };
  });
  let subBadLines = 0;
  for (const p of parsed) {
    subBadLines += p.sa.badLines || 0;
    result.meta.skipped = (result.meta.skipped || 0) + p.skipped;
  }
  // agentId -> the top-level Agent entry its work rolls up to. Nested
  // subagents (meta.parentAgentId) roll up to their root ancestor's entry.
  const owner = new Map();
  let pending = parsed;
  for (let pass = 0; pass < 8 && pending.length; pass++) {
    const next = [];
    for (const p of pending) {
      const m = p.sa.meta || {};
      let hit = byToolUse.get(m.toolUseId) || byAgentId.get(p.sa.agentId);
      let nested = false;
      if (!hit && m.parentAgentId && owner.has(m.parentAgentId)) {
        hit = owner.get(m.parentAgentId);
        nested = true;
      }
      if (!hit) {
        next.push(p);
        continue;
      }
      owner.set(p.sa.agentId, hit);
      if (!nested) {
        hit.a.agent_id ??= p.sa.agentId;
        hit.a.agent_type ??= m.agentType ?? null;
        hit.a.model ??= p.model;
        if (m.requestShape === 'background') hit.a.background = true;
      }
      const tag = nested ? { via_agent_id: p.sa.agentId, via_agent_type: m.agentType ?? null } : {};
      hit.a.searches.push(...p.searches.map((s) => ({ ...s, ...tag })));
      hit.a.fetches.push(...p.fetches.map((f) => ({ ...f, ...tag })));
      hit.t.skipped += p.skipped + p.bad;
      if (p.duplicate) hit.t.duplicate_records = true;
      if (p.pending > 0 && hit.t.answer_after_tools) hit.t.missing_results = (hit.t.missing_results || 0) + p.pending;
    }
    if (next.length === pending.length) {
      pending = next;
      break;
    }
    pending = next;
  }
  // Teammates and other agents with no link back to a parent call: counts only.
  const orphans = pending.filter((p) => p.searches.length || p.fetches.length);
  result.meta.orphan_subagents = {
    agents: orphans.length,
    searches: orphans.reduce((n, p) => n + p.searches.length, 0),
    fetches: orphans.reduce((n, p) => n + p.fetches.length, 0)
  };
  result.meta.subagent_bad_lines = subBadLines;
  // Re-derive citations now that subagent results are known.
  for (const t of result.turns) t.cited = t.answer_after_tools ? deriveCited(t.answer_markdown, t) : [];
  return result;
}

// target: a session id (UUID) or a path to a .jsonl transcript.
export function readSession(target, opts = {}) {
  if (typeof target !== 'string') throw new TypeError('readSession: target must be a session id or a transcript path');
  let transcriptPath = null;
  if (target.endsWith('.jsonl')) {
    transcriptPath = existsSync(target) ? target : null;
  } else if (isSessionId(target)) {
    const found = findTranscripts(target, opts.root ?? projectsRoot(process.env));
    if (found.length > 1) throw new Error('readSession: ambiguous session id (more than one project folder holds it)');
    transcriptPath = found[0] ?? null;
  } else {
    throw new Error('readSession: not a session id or a .jsonl transcript path');
  }
  if (!transcriptPath) throw new Error('readSession: no transcript found');
  const { records, badLines, badAt } = readJsonl(transcriptPath);
  const result = readRecords(records, { badAt });
  result.meta.bad_lines = badLines;
  if (result.unsupported) return result;
  return attachSubagents(result, readSubagents(transcriptPath));
}

// S1 for Claude Code: some WebSearch (main thread or joined subagent)
// returned at least one result. Fetches and answer links do not count.
export function turnIsSearch(turn) {
  return [...turn.searches, ...turn.subagents.flatMap((a) => a.searches)].some(
    (s) => s.status === 'ok' && Array.isArray(s.results) && s.results.length > 0
  );
}

// An unfinished turn is never offered for upload.
export function turnIsFinished(turn) {
  return turn?.answer_after_tools === true;
}
