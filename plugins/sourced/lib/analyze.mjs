// `list` and `analyze` (plan Task 13). Built to owner gates G1 (answered
// 2026-11-15, option A: analyze prints the preview and a six-character code
// and sends nothing; the turn uploads only through `upload <code>`) and G9
// (answered 2026-11-15: the preview shows the title, the model and the turn's
// two times).
//
// Neither command makes a network call or needs an account (U1). Imports only
// node:fs and plugin/lib files that import no network module: no node:http,
// node:https, node:net, node:dns, no child process, and not auth.mjs or
// upload.mjs. Everything printed goes through `print`.
//
// Exports:
//   CONFIRM_LINE      the locked confirm line (spec section 3)
//   ANALYZE_TEXT      every other user-facing string here ({prefix}, {code},
//                     {path}, {n} ... are filled in)
//   RULE_LINE
//   listCommand({ since, anyTime, scope, scopeArgs, env, root, now, print,
//                 prefix })                                    -> exit code
//   analyzeCommand({ sessionId, turnKey, index, since, anyTime, scope, env,
//                    root, now, print, prefix })               -> exit code
//   pickTurn({ sessionId, turnKey, index, since, anyTime, scope, env, root,
//              now })
//       -> { ok: true, sessionId, turnKey, lastNoSearch? } | { ok: false, text }
//
// scope: { all: true } (every project, `--all`), { project: <folder name> }
// (the current project, the default), or {} when the current project is not
// known; then list and analyze by number or --last say so and show nothing.
// O2 (2026-11-15) saw list show the start of prompts from every project, and
// Claude repeats the output, so other projects' prompts entered the session.
// A list number resolves in analyze only with the same --all and --since the
// list was given, which the list's last line repeats.
//   hasLocalSignIn(env) -> boolean (a session file with a non-connector
//                          access token; read locally, no refresh)
//   captureTurn({ sessionId, turnKey, env, root })
//       -> { resolved, result } (result null unless resolveTurn gave 'ok')
//   rebuildPayloadBytes({ sessionId, turnKey, installId, env, root })
//       -> the payload bytes analyze would build for that turn now, or null
//          when the turn no longer gives a capture. upload compares these to
//          the pending bytes before it sends (U11).
//
// A turn counts as saved by its conversation_id alone (U6, uploaded.mjs).
import { readFileSync } from 'node:fs';
import { listTurns, resolveTurn, turnKeyOf, markDuplicateKeys, newestWebOnlyTurn, DEFAULT_SINCE_MS } from './turns.mjs';
import { turnToDetail } from './turn.mjs';
import { buildPayload, payloadBytes, payloadHash } from './payload.mjs';
import { getInstallId } from './install.mjs';
import { renderTurn, renderPreview } from './view.mjs';
import { sessionFile, projectsRoot } from './paths.mjs';
import { findTranscript } from './jsonl.mjs';
import { readSession, turnIsSearch, turnIsFinished } from './reader.mjs';
import { newPendingCode, writePending } from './pending.mjs';
import { savedState, savedConversationIds } from './uploaded.mjs';

export const CONFIRM_LINE =
  'Upload this turn? This sends the prompt and answer shown above, with the searches and pages, to your account. Nothing else from this session is sent.';

export const RULE_LINE = '-'.repeat(60);

export const ANALYZE_TEXT = Object.freeze({
  instruction: 'To upload this turn, type: {prefix}upload {code}',
  previewSaved: 'The full upload preview, with everything this upload holds as JSON, is saved in {path}',
  fingerprint: 'Upload fingerprint (SHA-256): {hash}',
  codeLasts: 'The code works for 15 minutes. To drop it now: {prefix}cancel {code}',
  signInFirst: 'Sign in first: {prefix}signin',
  // G4 and G7 (owner, 2026-11-15): one quiet line at the end of list while
  // signed out, and none once signed in. Everything else works signed out.
  signedOutMore: 'This plugin is part of Sourced. With an account, you can save the turns you choose to a dashboard and read them back in Claude. To sign in: {prefix}signin',
  nothingUploads: 'Nothing from this turn can upload.',
  alreadySaved: 'This turn is already saved.',
  savedUnreadable: "The record of saved turns can't be read. Run {prefix}doctor.",
  transcriptGone: "The transcript for this turn is gone, so the prompt can't be shown.",
  // Seen in O1 (2026-11-15): a print-mode run with --no-session-persistence
  // fires the hooks, but its transcript file never exists.
  noTranscript: "Claude Code has no transcript for this session, so the prompt can't be shown. A session run with --no-session-persistence keeps none, and a transcript can also have been deleted.",
  reasonBackground: 'This turn started a subagent in the background. Its searches ran after the answer was written, so the answer is not matched to them.',
  reasonNotTyped: 'This turn was started by a subagent report or a task notice, not by a prompt you typed.',
  mismatchAnswer: "The answer the hooks recorded is not the end of the transcript's answer.",
  unreadable: "Couldn't read this turn",
  mismatch: 'The recorded searches and the transcript disagree.',
  mismatchCounts: 'Searches in the transcript: {t}. Recorded by the hooks: {q}. Matching: {m}. Different: {d}. Only in the hooks: {o}.',
  hookCounts: 'Recorded by the hooks: {s} searches, {r} results, {f} page fetches.',
  notFound: 'No such turn.',
  noFinishedTurn: 'No finished search turn {where}{when}. To see recent turns: {prefix}list{args}',
  noRow: 'There is no turn {n} in the list. To see the list: {prefix}list{args}',
  listEmpty: 'No search turns {where}{when}.',
  whereProject: 'in this project',
  whereAll: 'in any project',
  whenDefault: ' in the last 7 days',
  whenSince: ' since {time} UTC',
  noProject:
    "Sourced can't tell which project this is, because no Claude Code project folder matches the working directory, so it shows nothing. To list turns from every project, including the start of prompts from other projects: {prefix}list --all",
  allProjects: 'This list includes turns from every project on this computer, not only this one.',
  lastNoSearch: 'The last turn that used the web ran no web search: it only opened pages. It is shown below. To pick a search turn instead: {prefix}list{args}',
  listHeading: 'Search turns, newest first:',
  listFooter: 'To see one turn and its upload preview: {prefix}analyze <number>{args}',
  listSaved: 'saved',
  listRunning: 'still running',
  listUnreadable: "can't be read",
  listNoPrompt: '(prompt not available)',
  listNoTranscriptPrompt: '(prompt not available: no transcript holds this turn)',
  countSearches: '{n} searches',
  countSearch: '1 search',
  countResults: '{n} results',
  countResult: '1 result',
  countFetches: '{n} pages opened',
  countFetch: '1 page opened'
});

const fill = (template, vars) => template.replace(/\{(\w+)\}/g, (m, k) => (k in vars ? String(vars[k]) : m));
const nowMsOf = (now) => (typeof now === 'function' ? now() : typeof now === 'number' ? now : Date.now());

// ANSI sequences, then any other control character, for text read from a file.
const ANSI = /\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][\s\S]*?(?:\x07|\x1b\\|$)|\x1b[@-Z\\-_]|\x9b[0-?]*[ -/]*[@-~]/g;
export function cleanLine(value) {
  return String(value).replace(ANSI, '').replace(/[\p{Cc}\u2028\u2029]+/gu, ' ').trim();
}

// ---- sign-in, read locally -----------------------------------------------------

function jwtClaims(token) {
  try {
    const part = token.split('.')[1] || '';
    const claims = JSON.parse(Buffer.from(part, 'base64url').toString('utf8'));
    return claims && typeof claims === 'object' ? claims : null;
  } catch {
    return null;
  }
}

export function hasLocalSignIn(env) {
  let s;
  try {
    s = JSON.parse(readFileSync(sessionFile(env), 'utf8'));
  } catch {
    return false;
  }
  if (!s || typeof s.access_token !== 'string' || !s.access_token) return false;
  // A connector token (client_id claim) is read-only (A6) and can't upload.
  return typeof jwtClaims(s.access_token)?.client_id !== 'string';
}

// ---- list ----------------------------------------------------------------------

function plural(n, one, many) {
  return n === 1 ? one : fill(many, { n });
}

function countsText(c) {
  const parts = [plural(c?.searches ?? 0, ANALYZE_TEXT.countSearch, ANALYZE_TEXT.countSearches), plural(c?.results ?? 0, ANALYZE_TEXT.countResult, ANALYZE_TEXT.countResults)];
  if (c?.fetches) parts.push(plural(c.fetches, ANALYZE_TEXT.countFetch, ANALYZE_TEXT.countFetches));
  return parts.join(', ');
}

function timeText(iso) {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return '----------';
  const s = new Date(t).toISOString();
  return `${s.slice(0, 10)} ${s.slice(11, 16)}`;
}

// The rows `list` shows and `analyze <n>` picks from: the same call with the
// same scope and window, so the numbers agree.
function listRows({ since, anyTime, scope, env, root, now }) {
  return listTurns({ since, all: anyTime === true, project: scope?.all ? undefined : scope?.project, env, root, now: nowMsOf(now) }).turns;
}

const scopeKnown = (scope) => scope?.all === true || (typeof scope?.project === 'string' && scope.project !== '');

function whereWhen({ since, anyTime, scope }) {
  const where = scope?.all ? ANALYZE_TEXT.whereAll : ANALYZE_TEXT.whereProject;
  const when = anyTime ? '' : since !== undefined ? fill(ANALYZE_TEXT.whenSince, { time: timeText(new Date(since).toISOString()) }) : ANALYZE_TEXT.whenDefault;
  return { where, when };
}

export function listCommand({ since, anyTime = false, scope = {}, scopeArgs = '', env, root, now, print, prefix }) {
  const code = listBody({ since, anyTime, scope, scopeArgs, env, root, now, print, prefix });
  if (!hasLocalSignIn(env)) {
    print('');
    print(fill(ANALYZE_TEXT.signedOutMore, { prefix }));
  }
  return code;
}

function listBody({ since, anyTime, scope, scopeArgs, env, root, now, print, prefix }) {
  if (!scopeKnown(scope)) {
    print(fill(ANALYZE_TEXT.noProject, { prefix }));
    return 1;
  }
  const rows = listRows({ since, anyTime, scope, env, root, now });
  if (!rows.length) {
    print(fill(ANALYZE_TEXT.listEmpty, whereWhen({ since, anyTime, scope })));
    return 0;
  }
  const saved = savedConversationIds(env);
  if (scope.all) print(ANALYZE_TEXT.allProjects);
  print(ANALYZE_TEXT.listHeading);
  rows.forEach((row, i) => {
    const preview =
      typeof row.prompt_preview === 'string' && row.prompt_preview
        ? cleanLine(row.prompt_preview)
        : row.source === 'hooks'
          ? ANALYZE_TEXT.listNoTranscriptPrompt
          : ANALYZE_TEXT.listNoPrompt;
    const tags = [];
    // A turn that can't be read is never shown as running: it can't upload either way.
    if (row.unreadable) tags.push(ANALYZE_TEXT.listUnreadable);
    else if (!row.finished) tags.push(ANALYZE_TEXT.listRunning);
    if (saved.has(`${row.session_id}.${row.turn_key}`)) tags.push(ANALYZE_TEXT.listSaved);
    const tagText = tags.length ? ` [${tags.join(', ')}]` : '';
    print(`${String(i + 1).padStart(3)}. ${timeText(row.time)} UTC · ${countsText(row.counts)}${tagText}`);
    print(`     ${preview}`);
  });
  print('');
  print(fill(ANALYZE_TEXT.listFooter, { prefix, args: scopeArgs }));
  return 0;
}

// ---- analyze ---------------------------------------------------------------------

export function pickTurn({ sessionId, turnKey, index, since, anyTime = false, scope = {}, scopeArgs = '', env, root, now, prefix = '' }) {
  if (sessionId && turnKey) return { ok: true, sessionId, turnKey };
  if (!sessionId && !scopeKnown(scope)) return { ok: false, text: fill(ANALYZE_TEXT.noProject, { prefix }) };
  const rowsOpts = { since, anyTime, scope, env, root, now };
  if (Number.isInteger(index)) {
    const rows = listRows(rowsOpts);
    const row = rows[index - 1];
    if (!row) return { ok: false, text: fill(ANALYZE_TEXT.noRow, { n: index, prefix, args: scopeArgs }) };
    return { ok: true, sessionId: row.session_id, turnKey: row.turn_key };
  }
  // The newest finished search turn: in one session when one is named (only
  // that session's transcript is read), otherwise in the list's default window.
  if (sessionId) {
    const turnKey = newestFinishedInSession(sessionId, root ?? projectsRoot(env));
    if (!turnKey) return { ok: false, text: ANALYZE_TEXT.notFound };
    return { ok: true, sessionId, turnKey };
  }
  const row = listRows(rowsOpts).find((r) => r.finished === true && !r.unreadable);
  // A newer turn that used the web but ran no search (WebFetch only) is the
  // last web turn: --last says so and shows it, rather than an older search
  // turn. It is not a search (S1) and shows "No web search" (U7).
  const webOnly = newestWebOnlyTurn({ env, root, project: scope.all ? undefined : scope.project, after: row ? Date.parse(row.time) : undefined, since, anyTime, now: nowMsOf(now) });
  if (webOnly) return { ok: true, sessionId: webOnly.session_id, turnKey: webOnly.turn_key, lastNoSearch: true };
  if (!row) return { ok: false, text: fill(ANALYZE_TEXT.noFinishedTurn, { prefix, args: scopeArgs, ...whereWhen({ since, anyTime, scope }) }) };
  return { ok: true, sessionId: row.session_id, turnKey: row.turn_key };
}

function newestFinishedInSession(sessionId, projects) {
  const path = findTranscript(sessionId, projects);
  if (!path) return null;
  const read = readSession(path);
  if (read.unsupported) return null;
  markDuplicateKeys(read.turns);
  let best = null;
  for (const t of read.turns) {
    const key = turnKeyOf(t);
    if (!key || !turnIsSearch(t) || !turnIsFinished(t)) continue;
    // A turn that can't be read is not offered as the newest one.
    if (turnToDetail(t, read.meta).kind === 'unreadable') continue;
    const at = Date.parse(t.started_at) || 0;
    // Later in the file wins a tie, as the newer turn.
    if (!best || at >= best.at) best = { key, at };
  }
  return best ? best.key : null;
}

export function captureTurn({ sessionId, turnKey, env, root }) {
  const resolved = resolveTurn({ sessionId, turnKey, env, root });
  if (resolved.status !== 'ok') return { resolved, result: null };
  return { resolved, result: turnToDetail(resolved.turn, resolved.meta, { capturedVia: 'transcript' }) };
}

export function rebuildPayloadBytes({ sessionId, turnKey, installId, env, root }) {
  try {
    const { result } = captureTurn({ sessionId, turnKey, env, root });
    if (!result || result.kind !== 'capture') return null;
    return payloadBytes(buildPayload(result.detail, { installId }));
  } catch {
    return null;
  }
}

const is2xx = (s) => Number.isInteger(s) && s >= 200 && s < 300;
const fetchedUrls = (turn) =>
  [...turn.fetches, ...turn.subagents.flatMap((a) => a.fetches)].filter((f) => typeof f.url === 'string' && is2xx(f.status)).map((f) => f.url);

function hookCounts(turn) {
  const searches = [...turn.searches, ...turn.subagents.flatMap((a) => a.searches)];
  return {
    s: searches.length,
    r: searches.reduce((n, x) => n + (Array.isArray(x.results) ? x.results.length : 0), 0),
    f: [...turn.fetches, ...turn.subagents.flatMap((a) => a.fetches)].length
  };
}

export function analyzeCommand({ sessionId, turnKey, index, since, anyTime, scope, scopeArgs = '', env, root, now, print, prefix }) {
  const picked = pickTurn({ sessionId, turnKey, index, since, anyTime, scope, scopeArgs, env, root, now, prefix });
  if (!picked.ok) {
    print(picked.text);
    return 1;
  }
  if (picked.lastNoSearch) print(fill(ANALYZE_TEXT.lastNoSearch, { prefix, args: scopeArgs }));
  const { resolved, result } = captureTurn({ sessionId: picked.sessionId, turnKey: picked.turnKey, env, root });

  if (resolved.status === 'not-found') {
    print(ANALYZE_TEXT.notFound);
    return 1;
  }
  if (resolved.status === 'mismatch') {
    const c = resolved.mismatch || {};
    print(renderTurn({ kind: 'unreadable' }));
    print(ANALYZE_TEXT.mismatch);
    print(fill(ANALYZE_TEXT.mismatchCounts, { t: c.transcript_searches ?? 0, q: c.queue_searches ?? 0, m: c.matched ?? 0, d: c.different ?? 0, o: c.queue_only ?? 0 }));
    if (c.answer_differs) print(ANALYZE_TEXT.mismatchAnswer);
    print(ANALYZE_TEXT.nothingUploads);
    return 0;
  }
  if (resolved.status === 'no-prompt') {
    print(fill(ANALYZE_TEXT.hookCounts, hookCounts(resolved.turn)));
    print(resolved.meta?.transcript === 'missing' ? ANALYZE_TEXT.noTranscript : ANALYZE_TEXT.transcriptGone);
    print(ANALYZE_TEXT.nothingUploads);
    return 0;
  }

  if (result.kind !== 'capture') {
    // The short view, with the prompt when the turn has one (cut short: none
    // of it can upload). A prompt that holds editor context is not shown.
    const prompt = resolved.turn?.prompt_injected === true ? null : resolved.turn?.prompt;
    print(renderTurn(result, { opened: result.kind === 'no-search' ? fetchedUrls(resolved.turn) : [], prompt }));
    if (result.reason === 'background-agent') print(ANALYZE_TEXT.reasonBackground);
    if (result.reason === 'not-typed-prompt') print(ANALYZE_TEXT.reasonNotTyped);
    print(ANALYZE_TEXT.nothingUploads);
    return 0;
  }

  const payload = buildPayload(result.detail, { installId: getInstallId({ env }) });
  const bytes = payloadBytes(payload);
  const hash = payloadHash(bytes);
  const saved = savedState(env, payload.conversation_id);
  if (saved === 'saved' || saved === 'unreadable') {
    print(renderTurn(result));
    print('');
    if (saved === 'saved') {
      print(ANALYZE_TEXT.alreadySaved);
      return 0;
    }
    print(fill(ANALYZE_TEXT.savedUnreadable, { prefix }));
    return 1;
  }

  // The prompt and answer come first and the confirm line last, so a cut-off
  // terminal hides the JSON, which is only in the saved file.
  const preview = renderPreview(result.detail, payload, { fingerprint: hash });
  const code = newPendingCode(env);
  const paths = writePending(
    env,
    {
      code,
      created_at: new Date(nowMsOf(now)).toISOString(),
      conversation_id: payload.conversation_id,
      // conversation_id is <session uuid>.<turn key> (G2); a UUID has no dot.
      session_id: payload.conversation_id.slice(0, payload.conversation_id.indexOf('.')),
      turn_key: payload.conversation_id.slice(payload.conversation_id.indexOf('.') + 1),
      payload_hash: hash,
      payload_bytes: bytes
    },
    preview.file
  );

  print(preview.screen);
  print(RULE_LINE);
  print(fill(ANALYZE_TEXT.previewSaved, { path: paths.txt }));
  print(fill(ANALYZE_TEXT.fingerprint, { hash }));
  print(CONFIRM_LINE);
  if (!hasLocalSignIn(env)) print(fill(ANALYZE_TEXT.signInFirst, { prefix }));
  print(fill(ANALYZE_TEXT.instruction, { prefix, code }));
  print(fill(ANALYZE_TEXT.codeLasts, { prefix, code }));
  return 0;
}

export { DEFAULT_SINCE_MS };
