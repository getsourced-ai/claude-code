// Heuristic citation extraction from answer markdown.
//
// Ported unchanged from the capture prototype
// `tools/capture/claude-code/src/links.mjs` at commit be14c87.
//
// Exports:
//   normalizeUrl(raw) -> matching key (host without www, path without
//                        trailing slash, query without tracking params) | null
//   hostOf(raw)       -> lowercase host without www | null
//   extractLinks(md)  -> [{ url, anchor, start, in_sources_list, context, position }]
//
// `context` is the sentence around a link (local-only "citedText"); it is
// kept here and stripped before upload by a later step.
//
// Claude Code has no citation objects on disk: the WebSearch tool result ends
// with "REMINDER: You MUST include the sources above ... using markdown
// hyperlinks", so the answer cites through ordinary markdown links. Everything
// produced here is provenance "heuristic".

const MD_LINK = /\[((?:[^\[\]]|\[[^\]]*\])*)\]\((https?:\/\/[^\s)]+(?:\([^\s)]*\)[^\s)]*)*)(?:\s+"[^"]*")?\)/g;
const AUTOLINK = /<(https?:\/\/[^>\s]+)>/g;
const BARE = /(?<![(<\[="'])\bhttps?:\/\/[^\s<>()\[\]"'`]+/g;

const TRACKING = /^(utm_[a-z]+|gclid|fbclid|msclkid|ref|ref_src|srsltid)$/i;

// Normalize for matching only (the record keeps the original URL).
export function normalizeUrl(raw) {
  if (!raw) return null;
  let u;
  try {
    u = new URL(String(raw).trim());
  } catch {
    return null;
  }
  u.hash = '';
  for (const k of [...u.searchParams.keys()]) if (TRACKING.test(k)) u.searchParams.delete(k);
  const host = u.hostname.toLowerCase().replace(/^www\./, '');
  let path = u.pathname.replace(/\/+$/, '');
  const qs = u.searchParams.toString();
  return `${host}${path}${qs ? `?${qs}` : ''}`;
}

export function hostOf(raw) {
  try {
    return new URL(raw).hostname.toLowerCase().replace(/^www\./, '');
  } catch {
    return null;
  }
}

function trimTrailingPunct(url) {
  return url.replace(/[.,;:!?*_]+$/, '');
}

// The sentence (or list item / table row) around a link, with markdown links
// reduced to their labels. Heuristic "cited next to" text.
function contextAround(text, start, end) {
  const left = text.lastIndexOf('\n', start - 1) + 1;
  let right = text.indexOf('\n', end);
  if (right === -1) right = text.length;
  let line = text.slice(left, right);
  const rel = start - left;
  // Narrow to the sentence when the line is long prose.
  if (line.length > 280) {
    const before = line.slice(0, rel);
    const sStart = Math.max(before.lastIndexOf('. '), before.lastIndexOf('? '), before.lastIndexOf('! '));
    const after = line.slice(rel);
    const m = after.search(/[.?!](\s|$)/);
    line = line.slice(sStart >= 0 ? sStart + 2 : 0, m >= 0 ? rel + m + 1 : line.length);
  }
  return line
    .replace(MD_LINK, '$1')
    .replace(/^\s*(?:[-*+]|\d+\.)\s+/, '')
    .replace(/\*\*|__/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

// Whether a link sits in a trailing "Sources:" style list (no claim next to it).
function sourcesHeadingIndex(text) {
  const re = /^(?:#{1,6}\s*|\*\*)?(?:sources|references|citations)\b[^\n]*$/gim;
  let idx = -1;
  let m;
  while ((m = re.exec(text))) idx = m.index;
  return idx;
}

export function extractLinks(markdown) {
  const text = markdown || '';
  const out = [];
  const taken = [];
  const sourcesAt = sourcesHeadingIndex(text);
  const push = (url, anchor, start, end) => {
    url = trimTrailingPunct(url);
    if (taken.some(([s, e]) => start < e && end > s)) return;
    taken.push([start, end]);
    out.push({
      url,
      anchor,
      start,
      in_sources_list: sourcesAt >= 0 && start > sourcesAt,
      context: contextAround(text, start, end),
    });
  };
  for (const m of text.matchAll(MD_LINK)) push(m[2], m[1].trim() || null, m.index, m.index + m[0].length);
  for (const m of text.matchAll(AUTOLINK)) push(m[1], null, m.index, m.index + m[0].length);
  for (const m of text.matchAll(BARE)) push(m[0], null, m.index, m.index + m[0].length);
  out.sort((a, b) => a.start - b.start);
  return out.map((l, i) => ({ ...l, position: i + 1 }));
}
