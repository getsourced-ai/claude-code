// Where the plugin keeps its files. Every function takes the environment as
// an argument so tests never touch the real one. Naming a path creates
// nothing; ensurePrivateDir and writePrivateFile create with 0700 and 0600,
// and ensureDataDir and writeDataFile, which every writer under the data
// folder uses, also make the data folder and the folders below it 0700.
import { mkdirSync, chmodSync, writeFileSync, renameSync, rmSync, statSync } from 'node:fs';
import { join, dirname, isAbsolute, relative } from 'node:path';
import { homedir } from 'node:os';
import { randomBytes } from 'node:crypto';
import { isSessionId } from './ids.mjs';

const DIR_MODE = 0o700;
const FILE_MODE = 0o600;

export function configDir(env = {}) {
  return env.CLAUDE_CONFIG_DIR ? env.CLAUDE_CONFIG_DIR : join(homedir(), '.claude');
}

// The folder used when Claude Code names no plugin data folder.
export const FALLBACK_DATA_NAME = 'sourced-data';
export function fallbackDataDir(env = {}) {
  return join(configDir(env), FALLBACK_DATA_NAME);
}

// A data folder value that names nothing: missing, blank, or a
// `${CLAUDE_PLUGIN_DATA}` (or `$CLAUDE_PLUGIN_DATA`) that nobody filled in.
export function isUnsetDataDir(v) {
  if (typeof v !== 'string' || v.trim() === '') return true;
  return v.includes('${') || /\$[A-Za-z_]/.test(v);
}

export function dataDir(env = {}) {
  return isUnsetDataDir(env.CLAUDE_PLUGIN_DATA) ? fallbackDataDir(env) : env.CLAUDE_PLUGIN_DATA;
}

// Which data folder a command uses, and why. Claude Code sets
// CLAUDE_PLUGIN_DATA inside a hook (seen in O1, 2026-11-15), but its plugins
// reference says the variable is not set for commands Claude runs through the
// Bash tool, so every command file passes the folder as `--data-dir
// "${CLAUDE_PLUGIN_DATA}"` for Claude Code to fill in. It does fill it in a
// command body (seen in O2, 2026-11-15).
//
// argument: the --data-dir value, or undefined when none was given.
// -> { ok: true, env, source: 'argument' | 'environment' | 'fallback',
//      argumentIgnored }   env is a copy, with CLAUDE_PLUGIN_DATA set to the
//                          folder in use or removed for the fallback
//  | { ok: false, error }  a --data-dir that is filled in but not absolute
export const BAD_DATA_DIR = '--data-dir takes the absolute path of a folder.';
export function resolveDataDir(env = {}, argument) {
  const out = { ...env };
  const given = argument !== undefined;
  if (given && !isUnsetDataDir(argument)) {
    if (!isAbsolute(argument)) return { ok: false, error: BAD_DATA_DIR };
    out.CLAUDE_PLUGIN_DATA = argument;
    return { ok: true, env: out, source: 'argument', argumentIgnored: false };
  }
  if (!isUnsetDataDir(env.CLAUDE_PLUGIN_DATA)) {
    return { ok: true, env: out, source: 'environment', argumentIgnored: given };
  }
  delete out.CLAUDE_PLUGIN_DATA;
  return { ok: true, env: out, source: 'fallback', argumentIgnored: given };
}

// As the prototype's jsonl.mjs projectsRoot, with the environment passed in.
export function projectsRoot(env = {}) {
  return join(configDir(env), 'projects');
}

// The projects folder name Claude Code gives a working directory: every
// character other than an ASCII letter or digit becomes '-'. O2 (2026-11-15)
// saw a run folder whose path ended in scratchpad/phase-3-o2-run stored under
// a name ending in -scratchpad-phase-3-o2-run. How Claude Code names a
// folder for a very long path is not checked; such a path finds no folder
// here, and the commands then say they can't tell the project.
export function projectFolderName(dir) {
  return typeof dir === 'string' ? dir.replace(/[^A-Za-z0-9]/g, '-') : '';
}

// The current project's folder name under the projects root, or null when no
// folder matches. A command runs through Claude's Bash tool in the session's
// working directory, which is the project folder unless Claude changed
// directory during the session, so the folder is looked for under, in order,
// CLAUDE_PROJECT_DIR (when it is set), the working directory, and then each
// folder above the working directory, stopping before the home folder and
// the file system root, so a stray parent such as the home folder is never
// taken for the project.
// -> { ok: true, name } | { ok: false }
export function currentProject({ env = {}, root, cwd } = {}) {
  const projects = root ?? projectsRoot(env);
  const home = homedir();
  const isDir = (p) => {
    try {
      return statSync(p).isDirectory();
    } catch {
      return false;
    }
  };
  const tries = [];
  const pd = env.CLAUDE_PROJECT_DIR;
  if (typeof pd === 'string' && isAbsolute(pd) && !isUnsetDataDir(pd)) tries.push(pd);
  if (typeof cwd === 'string' && isAbsolute(cwd)) {
    tries.push(cwd);
    let p = dirname(cwd);
    while (p !== dirname(p) && !within(home, p)) {
      tries.push(p);
      p = dirname(p);
    }
  }
  for (const dir of tries) {
    const name = projectFolderName(dir);
    if (name && name !== '-' && isDir(join(projects, name))) return { ok: true, name };
  }
  return { ok: false };
}

// queue/, or queue/<sessionId>/ when a session id is given. A session id
// that is not a UUID gives null.
export function queueDir(env = {}, sessionId) {
  const base = join(dataDir(env), 'queue');
  if (sessionId === undefined) return base;
  return isSessionId(sessionId) ? join(base, sessionId) : null;
}

export function pendingDir(env = {}) {
  return join(dataDir(env), 'pending');
}

// The sign-in session (tokens), not a Claude Code session.
export function sessionFile(env = {}) {
  return join(dataDir(env), 'session.json');
}

export function uploadedFile(env = {}) {
  return join(dataDir(env), 'uploaded.json');
}

export function installFile(env = {}) {
  return join(dataDir(env), 'install.json');
}

// The plugin's own settings (today only the nudge switch).
export function settingsFile(env = {}) {
  return join(dataDir(env), 'settings.json');
}

// True when `dir` is `root` or inside it.
function within(dir, root) {
  const rel = relative(root, dir);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

// mkdir -p, then 0700 on each directory this call created (and the target).
// Directories that already existed above the first created one keep their mode,
// except that with `root` (the data folder) every directory from `root` down
// to `dir` is made 0700 too, whoever made it. O2 (2026-11-15) saw why: after
// the uninstall deleted the data folder, a running session's hook wrote into
// it again and the folder came back 0755. The plugin's own mkdir gives 0700,
// so another program (most likely Claude Code, which makes the folder it names
// in CLAUDE_PLUGIN_DATA) had made it first, and this function left it as it was.
export function ensurePrivateDir(dir, { root } = {}) {
  const first = mkdirSync(dir, { recursive: true, mode: DIR_MODE });
  const created = [];
  if (first === undefined) {
    chmodSync(dir, DIR_MODE);
    created.push(dir);
  } else {
    let p = dir;
    while (p.length >= first.length) {
      created.push(p);
      if (p === first) break;
      p = dirname(p);
    }
    for (const d of created) chmodSync(d, DIR_MODE);
  }
  if (typeof root === 'string' && root && within(dir, root)) {
    let p = dir;
    for (;;) {
      if (!created.includes(p)) {
        try {
          chmodSync(p, DIR_MODE);
        } catch {
          // A folder this user does not own: the write below says whether it matters.
        }
      }
      if (p === root || dirname(p) === p) break;
      p = dirname(p);
    }
  }
  return dir;
}

// ensurePrivateDir with the data folder as root: the folder, every folder
// between it and `dir`, and `dir` end 0700.
export function ensureDataDir(env, dir) {
  return ensurePrivateDir(dir, { root: dataDir(env) });
}

// writePrivateFile for a file under the data folder, with every folder from
// the data folder down made 0700 (see ensurePrivateDir).
export function writeDataFile(env, file, data) {
  return writePrivateFile(file, data, { root: dataDir(env) });
}

// Write through a temp file in the same folder and rename, so a reader never
// sees half a file. The result is 0600 whether or not the file existed.
// `root`: as for ensurePrivateDir.
export function writePrivateFile(file, data, { root } = {}) {
  ensurePrivateDir(dirname(file), { root });
  const tmp = `${file}.${randomBytes(6).toString('hex')}.tmp`;
  try {
    writeFileSync(tmp, data, { mode: FILE_MODE, flag: 'wx' });
    chmodSync(tmp, FILE_MODE);
    renameSync(tmp, file);
  } catch (err) {
    rmSync(tmp, { force: true });
    throw err;
  }
  return file;
}
