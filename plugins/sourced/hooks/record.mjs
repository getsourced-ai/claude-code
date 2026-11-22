// PostToolUse (WebSearch, WebFetch) and Stop hook. Reads the hook payload on
// stdin and writes at most one file under the plugin data folder's queue/.
// It never makes a network call and always exits 0: any error leaves the
// queue as it was. It prints only one thing: for a Stop that ends a
// main-thread turn that searched, one JSON line {"systemMessage": "..."} with
// the nudge (lib/nudge.mjs), and nothing at all otherwise. It never prints
// decision or additionalContext, which would make Claude continue.
import { writeSync } from 'node:fs';
import { handleHookEvent } from '../lib/queue-write.mjs';

// Larger input is not a payload this hook records; it is dropped unread.
const MAX_INPUT_BYTES = 8 * 1024 * 1024;
// Claude Code kills the hook at 5 s (hooks.json timeout). The hook ends itself
// first, so it exits 0 even when stdin is never closed.
const DEADLINE_MS = 4000;

let finished = false;
function done() {
  finished = true;
  process.exit(0);
}

process.on('uncaughtException', done);
process.on('unhandledRejection', done);

const chunks = [];

function handle() {
  if (finished) return;
  finished = true;
  try {
    const payload = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    const { nudge } = handleHookEvent(payload, { env: process.env });
    // Written synchronously, so it is out before the exit below.
    if (nudge) writeSync(1, `${JSON.stringify({ systemMessage: nudge })}\n`);
  } catch {
    // Malformed or partial payload, or a failed write: nothing to report, by design.
  }
  done();
}

try {
  // At the deadline, record what arrived if it is a whole payload; half a
  // payload fails to parse and writes nothing.
  setTimeout(handle, DEADLINE_MS).unref();
  if (process.stdin.isTTY) done();
  let size = 0;
  process.stdin.on('data', (chunk) => {
    if (finished) return;
    size += chunk.length;
    if (size > MAX_INPUT_BYTES) done();
    chunks.push(chunk);
  });
  process.stdin.on('end', handle);
  process.stdin.on('error', done);
} catch {
  done();
}
