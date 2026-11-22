// Tolerant, read-only JSONL reading for Claude Code transcripts.
//
// Ported from the capture prototype `tools/capture/claude-code/src/jsonl.mjs`
// at commit be14c87. Claude Code appends transcripts live and does not lock
// them, so the last line can be half-written: bad lines are counted and
// skipped, never thrown. Nothing here writes.
//
// Exports:
//   parseJsonl(text)              -> { records, badLines, badAt }
//   readJsonl(path)               -> { records, badLines, badAt }
//                                    badAt: one { line, before, tail } per bad
//                                    line: its index among the lines, the
//                                    number of records parsed before it (so a
//                                    reader can tell which turn it fell in),
//                                    and whether it is the final line with no
//                                    newline after it (the normal half-written
//                                    tail of a live file).
//   findTranscripts(sessionId, root) -> [path] every <root>/<project>/<id>.jsonl
//   findTranscript(sessionId, root) -> path | null. The id must be a UUID
//                                    (isSessionId); anything else is refused
//                                    with null before the disk is touched.
//                                    null too when more than one project
//                                    folder holds the id (ambiguous).
//   readSubagents(transcriptPath) -> [{ agentId, meta, records, badLines, badAt }]
//   AGENT_FILE                    the agent-<id>.jsonl name pattern
//
// Changes from the prototype: findTranscript validates the id and takes the
// root explicitly (projectsRoot lives in paths.mjs); readSubagents accepts only
// agent-<id>.jsonl with id ^[A-Za-z0-9_-]{1,100}$, keeps meta only when it is
// a plain object, and returns files in name order.
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { isSessionId } from './ids.mjs';

export const AGENT_FILE = /^agent-([A-Za-z0-9_-]{1,100})\.jsonl$/;

const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

export function parseJsonl(text) {
  const records = [];
  const badAt = [];
  const lines = text.split('\n');
  lines.forEach((line, i) => {
    if (!line.trim()) return;
    try {
      records.push(JSON.parse(line));
    } catch {
      // The last split piece has no newline after it.
      badAt.push({ line: i, before: records.length, tail: i === lines.length - 1 });
    }
  });
  return { records, badLines: badAt.length, badAt };
}

export function readJsonl(path) {
  return parseJsonl(readFileSync(path, 'utf8'));
}

// <root>/<any project>/<sessionId>.jsonl. Read-only directory scan.
export function findTranscripts(sessionId, root) {
  if (!isSessionId(sessionId)) return [];
  if (typeof root !== 'string' || !existsSync(root)) return [];
  const out = [];
  for (const dir of readdirSync(root).sort()) {
    const p = join(root, dir, `${sessionId}.jsonl`);
    if (existsSync(p)) out.push(p);
  }
  return out;
}

// One session id in two project folders cannot be told apart: neither is used.
export function findTranscript(sessionId, root) {
  const found = findTranscripts(sessionId, root);
  return found.length === 1 ? found[0] : null;
}

function readMeta(path) {
  if (!existsSync(path)) return {};
  let meta;
  try {
    meta = JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return {};
  }
  return isPlainObject(meta) ? meta : {};
}

// Subagent files live next to the session:
// <dir>/<sessionId>/subagents/agent-<id>.jsonl, with agent-<id>.meta.json
// ({agentType, toolUseId, parentAgentId, ...}).
export function readSubagents(transcriptPath) {
  const subDir = join(transcriptPath.replace(/\.jsonl$/, ''), 'subagents');
  if (!existsSync(subDir)) return [];
  const out = [];
  for (const fn of readdirSync(subDir).sort()) {
    const m = AGENT_FILE.exec(fn);
    if (!m) continue;
    const agentId = m[1];
    const meta = readMeta(join(subDir, `agent-${agentId}.meta.json`));
    const { records, badLines, badAt } = readJsonl(join(subDir, fn));
    out.push({ agentId, meta, records, badLines, badAt });
  }
  return out;
}
