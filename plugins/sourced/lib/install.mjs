// The plugin's install id: a UUID made once and kept in installFile(env)
// (0600). collect stores it beside a signed-in save so "Delete my data" and
// row inspection work as for the extension. A missing or corrupt file is
// replaced with a new id.
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { installFile, writeDataFile } from './paths.mjs';
import { isSessionId } from './ids.mjs';

function readInstallId(file) {
  let text;
  try {
    text = readFileSync(file, 'utf8');
  } catch (err) {
    if (err?.code === 'ENOENT') return null;
    throw err;
  }
  try {
    const parsed = JSON.parse(text);
    return isSessionId(parsed?.installId) ? parsed.installId.toLowerCase() : null;
  } catch (err) {
    if (err instanceof SyntaxError) return null;
    throw err;
  }
}

export function getInstallId({ env = process.env } = {}) {
  const file = installFile(env);
  const existing = readInstallId(file);
  if (existing) return existing;
  const installId = randomUUID();
  writeDataFile(env, file, `${JSON.stringify({ installId })}\n`);
  return installId;
}
