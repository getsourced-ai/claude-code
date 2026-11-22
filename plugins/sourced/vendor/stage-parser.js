// ChatGPT Search Insights - Stage parser foundations
// URL normalization, messages[] -> mapping shim, and DIL widget extraction.

(function() {
  'use strict';

  // Drops every utm_* parameter (ChatGPT adds utm_source=chatgpt.com to the
  // links it shows) and keeps the rest, so one page has one key.
  function normalizeUrl(url) {
    try {
      const u = new URL(url);
      for (const key of [...u.searchParams.keys()]) {
        if (/^utm_/i.test(key)) u.searchParams.delete(key);
      }
      return u.toString();
    } catch (e) {
      return url;
    }
  }

  function domainOf(url) {
    try {
      return new URL(url).hostname.toLowerCase().replace(/^www\./, '');
    } catch (e) {
      return null;
    }
  }

  // The logged-in conversation endpoint returns a flat messages[] instead of
  // a mapping. Build a mapping so one parser handles both shapes.
  function messagesToMapping(data) {
    if (!data || data.mapping || !Array.isArray(data.messages)) return data;
    const mapping = {};
    data.messages.forEach((message, i) => {
      const id = (message && message.id) || ('msg-' + i);
      mapping[id] = { id, message, parent: null, children: [] };
    });
    data.mapping = mapping;
    return data;
  }

  // A regenerated or edited answer forks the mapping, and only the branch ending
  // at current_node is the conversation the user sees. Returns a copy holding
  // that branch, or the input itself when there is no usable tree: no
  // current_node, a broken chain, or the parentless mapping messagesToMapping builds.
  function activeMapping(data) {
    const mapping = data && data.mapping;
    if (!isObject(mapping) || !isObject(mapping[data.current_node])) return data;
    if (!Object.values(mapping).some((node) => isObject(node) && node.parent)) return data;

    const branch = new Set();
    for (let id = data.current_node; id; id = mapping[id].parent) {
      if (branch.has(id) || !isObject(mapping[id])) return data;
      branch.add(id);
    }
    const active = Object.entries(mapping).filter(([id]) => branch.has(id));
    return Object.assign({}, data, { mapping: Object.fromEntries(active) });
  }

  // A regenerated answer gets its own turn_exchange_id while the prompt keeps
  // the original one. Such a turn adopts the prompt's turn so that it has one.
  function adoptOrphanTurns(data) {
    const mapping = data && data.mapping;
    if (!isObject(mapping)) return data;
    const turns = new Map();
    const prompts = [];
    for (const node of Object.values(mapping)) {
      const message = isObject(node) ? node.message : null;
      const turnId = isObject(message) && isObject(message.metadata) ? message.metadata.turn_exchange_id : null;
      if (typeof turnId !== 'string' || !turnId) continue;
      if (!turns.has(turnId)) turns.set(turnId, { hasUser: false, earliest: Infinity });
      const turn = turns.get(turnId);
      const time = typeof message.create_time === 'number' ? message.create_time : Infinity;
      if (message.author && message.author.role === 'user') {
        turn.hasUser = true;
        if (messageText(message)) prompts.push({ turnId, time });
      } else if (time < turn.earliest) {
        turn.earliest = time;
      }
    }

    const adopted = new Map();
    for (const [turnId, turn] of turns) {
      if (turn.hasUser) continue;
      const before = prompts.filter((p) => p.time <= turn.earliest && p.time !== Infinity);
      const prompt = before.length > 0
        ? before.reduce((a, b) => (b.time >= a.time ? b : a))
        : (prompts.length === 1 ? prompts[0] : null);
      if (prompt) adopted.set(turnId, prompt.turnId);
    }
    if (adopted.size === 0) return data;

    const next = {};
    for (const [key, node] of Object.entries(mapping)) {
      const metadata = isObject(node) && isObject(node.message) ? node.message.metadata : null;
      const target = isObject(metadata) ? adopted.get(metadata.turn_exchange_id) : undefined;
      next[key] = target
        ? Object.assign({}, node, { message: Object.assign({}, node.message, { metadata: Object.assign({}, metadata, { turn_exchange_id: target }) }) })
        : node;
    }
    return Object.assign({}, data, { mapping: next });
  }

  // The messages behind the answer on screen: one branch, every turn with its prompt.
  function answerView(data) {
    return adoptOrphanTurns(activeMapping(data));
  }

  // fallbackMarkdown carries render markers between private-use delimiters:
  // U+E200 kind U+E202 args... U+E201. Entities and links keep their visible
  // text; citations and image groups render nothing.
  function cleanAnswerMarkdown(text) {
    return text.replace(/\ue200([^\ue201]*)\ue201/g, (_, body) => {
      const [kind, ...args] = body.split('\ue202');
      if (kind === 'url') {
        return /^https?:/.test(args[1] || '') ? `[${args[0]}](${args[1]})` : (args[0] || '');
      }
      if (kind === 'entity') {
        try {
          const name = JSON.parse(args[0])[1];
          return typeof name === 'string' ? name : '';
        } catch (e) {
          return '';
        }
      }
      return '';
    }).replace(/[\ue200-\ue202]/g, '');
  }

  const WIDGET_BUCKETS = { Cite: 'cite', Entity: 'entity', Link: 'link', AsyncImage: 'image' };

  function extractDilWidgets(message) {
    const out = { cite: [], entity: [], link: [], image: [] };
    const dil = message && message.metadata && message.metadata.model_dil_v2;
    if (!dil) return out;

    const results = (dil.appData && dil.appData.opGenui && dil.appData.opGenui.componentResults) || {};
    const constants = dil.constants || {};
    const code = typeof dil.code === 'string' ? dil.code : '';

    const orderById = {};
    let count = 0;
    const re = /__resolutionId":__dilConstants\["(\d+)"\]/g;
    let m;
    while ((m = re.exec(code)) !== null) {
      const id = constants[m[1]];
      if (typeof id === 'string' && !(id in orderById)) orderById[id] = count++;
    }

    // Widgets never referenced in code sort after every scanned one.
    for (const id of Object.keys(results)) {
      const result = results[id];
      const bucket = result && WIDGET_BUCKETS[result.componentName];
      if (!bucket) continue;
      const order = id in orderById ? orderById[id] : count++;
      out[bucket].push({ id, order, state: result.state || {} });
    }
    for (const key of Object.keys(out)) out[key].sort((a, b) => a.order - b.order);
    return out;
  }

  // A search means a query, a result entry or a Cite widget. An empty
  // search_result_groups or query list is ChatGPT's placeholder, not a search.
  function hasSearchEvidence(message) {
    const md = message.metadata;
    const queries = md.search_model_queries && md.search_model_queries.queries;
    if (Array.isArray(queries) && queries.length > 0) return true;
    if (resultGroupsOf(message).some((group) => group && Array.isArray(group.entries) && group.entries.length > 0)) return true;
    return hasSearchInvocation(message) || extractDilWidgets(message).cite.length > 0;
  }

  // Single-query searches omit search_model_queries; the query is only in the
  // search("...") call.
  function hasSearchInvocation(message) {
    const content = message.content;
    return Boolean(content) && content.content_type === 'code' && typeof content.text === 'string' &&
      /search\(\s*"[^"]+"\s*\)/.test(content.text);
  }

  function hasSearchContent(data) {
    if (!data) return false;
    const view = data.mapping ? data : messagesToMapping(Object.assign({}, data));
    for (const node of Object.values(view.mapping || {})) {
      const message = node && node.message;
      const md = message && message.metadata;
      if (!md || typeof md !== 'object') continue;
      if (hasSearchEvidence(message)) return true;
    }
    return false;
  }

  // The user's visible prompt is the first string part; multimodal messages
  // put attachment pointers (objects) ahead of the text.
  function firstStringPart(parts) {
    if (!Array.isArray(parts)) return '';
    for (const part of parts) {
      if (typeof part === 'string' && part.trim()) return part;
    }
    return '';
  }

  function isObject(value) {
    return !!value && typeof value === 'object';
  }

  function messageText(message) {
    const parts = message && message.content && message.content.parts;
    return firstStringPart(parts);
  }

  function hasLegacyCitations(md) {
    const refs = md && md.content_references;
    return Array.isArray(refs) && refs.some((r) => isObject(r) && r.type === 'grouped_webpages');
  }

  function turnHasSearch(messages) {
    return messages.some((message) => {
      const md = message.metadata;
      if (!isObject(md)) return false;
      return hasLegacyCitations(md) || hasSearchEvidence(message);
    });
  }

  // Positions of each __resolutionId reference in the DIL code, keyed by the
  // widget id, plus the literal query prop of each AsyncImage.
  function scanDilCode(dil) {
    const positions = {};
    const imageQueries = {};
    const code = dil && typeof dil.code === 'string' ? dil.code : '';
    const constants = (dil && dil.constants) || {};
    const re = /"__resolutionId":__dilConstants\["(\d+)"\]/g;
    let m;
    while ((m = re.exec(code)) !== null) {
      const id = constants[m[1]];
      if (typeof id === 'string' && !(id in positions)) positions[id] = m.index;
    }
    const imgRe = /AsyncImage,\{([^{}]*?)"__resolutionId":__dilConstants\["(\d+)"\]/g;
    while ((m = imgRe.exec(code)) !== null) {
      const id = constants[m[2]];
      const q = /"query":("(?:[^"\\]|\\.)*"|__dilConstants\["(\d+)"\])/.exec(m[1]);
      if (typeof id !== 'string' || !q) continue;
      let query = null;
      if (q[2] !== undefined) {
        query = typeof constants[q[2]] === 'string' ? constants[q[2]] : null;
      } else {
        try { query = JSON.parse(q[1]); } catch (e) { query = null; }
      }
      imageQueries[id] = query;
    }
    return { positions, imageQueries };
  }

  function entityName(state) {
    return typeof state.value === 'string' ? state.value : '';
  }

  function entityDisambiguation(state) {
    const payload = isObject(state.action_payload) ? state.action_payload : {};
    const extra = isObject(payload.extraParams) ? payload.extraParams : {};
    return typeof extra.disambiguation === 'string' ? extra.disambiguation : null;
  }

  function entityCategory(state) {
    const payload = isObject(state.action_payload) ? state.action_payload : {};
    return typeof payload.category === 'string' ? payload.category : null;
  }

  function linkDomain(link) {
    if (typeof link.state.url === 'string' && domainOf(link.state.url)) return domainOf(link.state.url);
    return typeof link.state.domain === 'string' ? link.state.domain.toLowerCase() : '';
  }

  const squash = (text) => String(text).toLowerCase().replace(/[^a-z0-9]/g, '');

  // Pairing, in order: (a) a link whose domain holds the entity's squashed whole
  // name; (b) the first free link inside the entity's card, which runs from the
  // entity's reference in the DIL code to the next entity's; (c) a domain match on
  // the name's first token; (d) null. A link is never given to two different
  // companies, and a second link to a page already claimed is a reference, such
  // as "Comparison: Jobber pricing" in another card, not a site. The same company
  // named twice, as a summary paragraph before the cards does, shares one link, and
  // a name that starts with another entity's whole name (UpGuard Vendor Risk after
  // UpGuard) may share that entity's link in step (c). The name match goes first
  // because an answer that opens with a summary table names every entity before
  // any card, which makes the last card's range run over every other card's links.
  // Index pairing is only a fallback when the code gives no positions: equal
  // counts can be a coincidence, such as three summary mentions and three Source
  // links (2026-11-04, "best vendor risk management platform").
  function pairLinks(entities, links, positions) {
    const placed = (w) => positions[w.id] !== undefined;
    if (entities.length === links.length && !(entities.every(placed) && links.every(placed))) return links.slice();
    const claimed = new Set();
    const urlOf = (l) => (typeof l.state.url === 'string' ? normalizeUrl(l.state.url) : null);
    const taken = (l) => claimed.has(l) || (urlOf(l) !== null && [...claimed].some((c) => urlOf(c) === urlOf(l)));
    const names = entities.map((entity) => squash(entityName(entity.state)));
    const out = entities.map(() => null);
    const give = (i, link) => {
      claimed.add(link);
      names.forEach((name, j) => { if (!out[j] && name && name === names[i]) out[j] = link; });
      out[i] = link;
    };
    const byDomain = (i, needle) => {
      if (out[i] || !needle) return;
      const hit = links.find((l) => !taken(l) && squash(linkDomain(l)).includes(needle));
      if (hit) give(i, hit);
    };
    entities.forEach((entity, i) => byDomain(i, names[i]));
    entities.forEach((entity, i) => {
      if (out[i]) return;
      const start = positions[entity.id];
      if (start === undefined) return;
      let end = Infinity;
      for (const other of entities) {
        const at = positions[other.id];
        if (at !== undefined && at > start && at < end) end = at;
      }
      const hit = links.find((l) => !taken(l) && placed(l) && positions[l.id] > start && positions[l.id] < end);
      if (hit) give(i, hit);
    });
    entities.forEach((entity, i) => {
      const token = squash(entityName(entity.state).split(/\s+/)[0] || '');
      if (out[i] || !token) return;
      byDomain(i, token);
      if (out[i]) return;
      // The parent company's site: an entity whose whole name starts this one's.
      const parent = names.findIndex((name, j) => j !== i && out[j] && name && names[i].startsWith(name) && squash(linkDomain(out[j])).includes(token));
      if (parent >= 0) out[i] = out[parent];
    });
    return out;
  }

  // Each entity card in the observed answers opens with its AsyncImage, so the
  // image belongs to the nearest one before the entity, after the prior entity.
  function pairImages(entities, images, positions) {
    let floor = -1;
    return entities.map((entity) => {
      const at = positions[entity.id];
      if (at === undefined) return null;
      let best = null;
      for (const image of images) {
        const pos = positions[image.id];
        if (pos === undefined || pos >= at || pos <= floor) continue;
        if (!best || pos > positions[best.id]) best = image;
      }
      floor = at;
      return best;
    });
  }

  function refTypeOf(entry) {
    return isObject(entry.ref_id) ? entry.ref_id.ref_type : null;
  }

  function turnIndexOf(entry) {
    const ref = isObject(entry) && isObject(entry.ref_id) ? entry.ref_id : null;
    return ref && typeof ref.turn_index === 'number' ? ref.turn_index : null;
  }

  // A message's search result groups: its own list, then the copy in the
  // reasoning section. Today the reasoning copy repeats the main list, and every
  // reader skips a URL it has already seen, so it only adds results the main list
  // lacks, in case ChatGPT stops repeating them there.
  function resultGroupsOf(message) {
    const md = isObject(message.metadata) ? message.metadata : {};
    const own = Array.isArray(md.search_result_groups) ? md.search_result_groups : [];
    const cot = isObject(md.inline_cot_expandable_content) ? md.inline_cot_expandable_content.search_result_groups : null;
    return Array.isArray(cot) && cot.length > 0 ? own.concat(cot) : own;
  }

  function turnIndexesIn(message) {
    const out = [];
    for (const group of resultGroupsOf(message)) {
      const entries = isObject(group) && Array.isArray(group.entries) ? group.entries : [];
      for (const entry of entries) {
        const index = turnIndexOf(entry);
        if (index !== null && !out.includes(index)) out.push(index);
      }
    }
    return out;
  }

  // Each web.run call is one round, and its tool message tags entries with an
  // opaque turn_index such as 415515. The final answer re-lists the whole pool
  // tagged by the call's position instead: 0 for the first call, counting the
  // calls that open pages. Every round index this parser emits is that
  // position, so a turn's distinct retrieved roundIndex values are its search
  // rounds. Returns a function from a message to its entry-index mapper.
  function roundNumbering(messages) {
    const order = [];
    const timeOf = (m) => (typeof m.create_time === 'number' ? m.create_time : Infinity);
    messages
      .map((message, i) => ({ message, i }))
      .filter(({ message }) => message.author && message.author.role === 'tool')
      .sort((a, b) => (timeOf(a.message) - timeOf(b.message)) || (a.i - b.i))
      .forEach(({ message }) => {
        for (const index of turnIndexesIn(message)) if (!order.includes(index)) order.push(index);
      });
    const position = new Map(order.map((index, i) => [index, i]));
    const keep = (index) => index;
    const mapOpaque = (index) => (position.has(index) ? position.get(index) : index);
    return (message) => {
      if (position.size === 0) return keep;
      if (message.author && message.author.role === 'tool') return mapOpaque;
      // Another message's list is in tool-message numbering only when every
      // index in it is one; otherwise it already counts calls by position.
      const indexes = turnIndexesIn(message);
      return indexes.length > 0 && indexes.every((index) => position.has(index)) ? mapOpaque : keep;
    };
  }

  function refKey(turnIndex, type, refIndex) {
    return `turn${turnIndex}${type}${refIndex}`;
  }

  // "turn991136search0" names a tool message's turn_index, ref type and index.
  function refKeyOf(refId) {
    const m = /^turn(\d+)(search|view)(\d+)$/.exec(refId);
    return m ? refKey(Number(m[1]), m[2], Number(m[3])) : '';
  }

  const CITE_MARKER_RE = /\ue200cite\ue202([^\ue201]*)\ue201|<Cite\s+refs=\{(\[[^\]]*\])\}\s*\/?>/g;
  const MAX_CITED_TEXT = 240;

  // Answer text as a reader sees it: no render markers, link syntax, tags,
  // emphasis or Markdown escapes.
  function plainAnswerText(text) {
    return decodeEscapedEntities(cleanAnswerMarkdown(text.replace(CITE_MARKER_RE, ' ')))
      .replace(/<[^>\n]*>/g, ' ')
      .replace(/!?\[([^\]\n]*)\]\([^)\n]*\)/g, '$1')
      .replace(/\\([\\`*_{}\[\]()#+\-.!:$|>~])/g, '$1')
      .trim()
      .replace(/^(?:#{1,6}\s+|>\s*|[-*+]\s+|\d+[.)]\s+)/, '')
      .replace(/\*\*|__/g, '')
      .replace(/(^|\s)[*_](?=\S)|(\S)[*_](?=\s|$)/g, '$1$2')
      .replace(/\s+/g, ' ')
      .trim();
  }

  const LABEL_ONLY_RE = /^(?:sources?|citations?|references?|via|see)\s*:?$/i;
  // A short lead-in such as "Comparison:" or "Pricing and features:".
  const LEAD_LABEL_RE = /^\s*(?:\*\*)?[A-Za-z][\w '’&/-]{0,38}?\\?:(?:\*\*)?\s*/;
  // A line that describes the sources, such as "Sources: vendor pricing pages."
  const SOURCES_LINE_RE = /^(?:sources?|citations?|references?)\s*:/i;

  // Text that reads as words, not a row of links, a rule, a lone label or a
  // note about the sources.
  function isProse(plain) {
    if (!plain || LABEL_ONLY_RE.test(plain) || SOURCES_LINE_RE.test(plain)) return false;
    if (plain.replace(LEAD_LABEL_RE, '') === '') return false;
    return /[A-Za-z]{3,}/.test(plain);
  }

  // A line made only of links, such as "[Website](...) · [About](...)", or a
  // short label and links, such as "Pricing: [Jobber official pricing](...) ·".
  function isLinkLine(line) {
    const rest = line
      .replace(/\ue200url\ue202[^\ue201]*\ue201/g, '')
      .replace(/!?\[[^\]\n]*\]\([^)\n]*\)/g, '')
      .replace(/<Link\b[^>]*>[^<]*<\/Link>|<Link\b[^>]*\/>/g, '')
      .replace(/<[^>\n]*>/g, '');
    return rest !== line && /^[\s·•|,\-–—/]*$/.test(rest.replace(LEAD_LABEL_RE, ''));
  }

  function lastSentence(plain) {
    const text = plain.replace(/\s*(?:sources?|citations?)\s*:\s*$/i, '').trim();
    const pieces = text.split(/(?<=[.!?])\s+(?=[A-Z0-9"“(])/).filter((piece) => piece.trim());
    const sentence = (pieces[pieces.length - 1] || '').trim();
    return sentence.length > MAX_CITED_TEXT ? sentence.slice(0, MAX_CITED_TEXT - 1).trimEnd() + '…' : sentence;
  }

  // The sentence each citation marker in the answer supports: the text before it
  // on its line, or the nearest prose line above when the marker stands alone or
  // follows a row of links. A marker under a heading, a rule or nothing gets null,
  // since a guess would put words next to a page that never supported them.
  function citationContexts(message) {
    if (!isObject(message)) return [];
    const dil = isObject(message.metadata) ? message.metadata.model_dil_v2 : null;
    const source = dil && typeof dil.fallbackMarkdown === 'string' ? dil.fallbackMarkdown : messageText(message);
    if (!source) return [];
    const out = [];
    for (const match of source.matchAll(CITE_MARKER_RE)) {
      let refs = [];
      if (match[1] !== undefined) {
        refs = match[1].split('\ue202');
      } else {
        try { refs = JSON.parse(match[2]); } catch (e) { refs = []; }
      }
      refs = refs.filter((ref) => typeof ref === 'string' && ref);
      out.push({ refs, text: textBeforeMarker(source, match.index) });
    }
    return out;
  }

  function textBeforeMarker(source, index) {
    const lineStart = source.lastIndexOf('\n', index - 1) + 1;
    let line = source.slice(lineStart, index);
    // In a table row, the marker belongs to its cell.
    if (/^\s*\|/.test(line)) line = line.slice(line.lastIndexOf('|') + 1);
    const own = plainAnswerText(line);
    if (isProse(own) && !isLinkLine(line)) return lastSentence(own) || null;

    const above = source.slice(0, lineStart).split('\n');
    for (let i = above.length - 1, looked = 0; i >= 0 && looked < 4; i--) {
      const raw = above[i];
      if (!raw.trim()) continue;
      looked++;
      if (/^\s*(?:#{1,6}\s|-{3,}\s*$|\*{3,}\s*$|_{3,}\s*$|\|)/.test(raw)) return null;
      if (CITE_MARKER_RE.test(raw)) { CITE_MARKER_RE.lastIndex = 0; return null; }
      CITE_MARKER_RE.lastIndex = 0;
      if (isLinkLine(raw)) continue;
      const plain = plainAnswerText(raw);
      if (!isProse(plain)) continue;
      return lastSentence(plain) || null;
    }
    return null;
  }

  function parseTurn(turnExchangeId, messages, ids) {
    const retrieved = [];
    const accessed = [];
    const seen = { search: new Set(), view: new Set() };
    const queryTexts = [];
    const rounds = new Map();

    const numberingFor = roundNumbering(messages);
    // Every raw search entry counts toward its round's size and its URL's best
    // rank, though retrieved keeps one entry per URL.
    const roundRefs = new Map();
    const bestRank = new Map();
    // Cite refs name the opaque tool-message numbering, so they resolve by the
    // raw ref_id, never by a round position.
    const refUrls = new Map();
    for (const message of messages) {
      const md = isObject(message.metadata) ? message.metadata : {};
      const roundOf = numberingFor(message);
      const sq = md.search_model_queries;
      if (isObject(sq) && Array.isArray(sq.queries)) {
        for (const q of sq.queries) if (typeof q === 'string') queryTexts.push(q);
      }
      for (const group of resultGroupsOf(message)) {
        const entries = isObject(group) && Array.isArray(group.entries) ? group.entries : [];
        for (const entry of entries) {
          if (!isObject(entry) || typeof entry.url !== 'string') continue;
          const type = refTypeOf(entry);
          if (type !== 'search' && type !== 'view') continue;
          const rawIndex = turnIndexOf(entry);
          if (rawIndex !== null && typeof entry.ref_id.ref_index === 'number') {
            const key = refKey(rawIndex, type, entry.ref_id.ref_index);
            if (!refUrls.has(key)) refUrls.set(key, entry.url);
          }
          if (type === 'search') {
            const round = rawIndex === null ? null : roundOf(rawIndex);
            const refIndex = typeof entry.ref_id.ref_index === 'number' ? entry.ref_id.ref_index : null;
            if (!roundRefs.has(round)) roundRefs.set(round, new Set());
            if (refIndex !== null) roundRefs.get(round).add(refIndex);
            const key = normalizeUrl(entry.url);
            const prior = bestRank.get(key);
            const earlier = prior && refIndex === prior.refIndex && round !== null && (prior.roundIndex === null || round < prior.roundIndex);
            if (refIndex !== null && (!prior || refIndex < prior.refIndex || earlier)) bestRank.set(key, { roundIndex: round, refIndex });
          }
          if (type === 'search') {
            // Rounds come from raw entries: a URL repeated in a later round
            // still shows that round searched its domain.
            const round = turnIndexOf(entry) === null ? null : roundOf(turnIndexOf(entry));
            if (!rounds.has(round)) rounds.set(round, []);
            const roundDomains = rounds.get(round);
            const d = domainOf(entry.url);
            if (d && !roundDomains.includes(d)) roundDomains.push(d);
          }
          const normalizedUrl = normalizeUrl(entry.url);
          if (seen[type].has(normalizedUrl)) continue;
          seen[type].add(normalizedUrl);
          const base = {
            url: entry.url,
            normalizedUrl,
            domain: domainOf(entry.url),
            title: typeof entry.title === 'string' ? entry.title : '',
          };
          const pos = { roundIndex: turnIndexOf(entry) === null ? null : roundOf(turnIndexOf(entry)), refIndex: entry.ref_id.ref_index == null ? null : entry.ref_id.ref_index };
          if (type === 'search') {
            retrieved.push(Object.assign(base, {
              snippet: cleanSnippet(entry.snippet),
              pubDate: typeof entry.pub_date === 'number' ? entry.pub_date : null,
            }, pos));
          } else {
            accessed.push(Object.assign(base, pos));
          }
        }
      }
    }

    for (const entry of retrieved) {
      entry.bestRank = bestRank.get(entry.normalizedUrl) || null;
    }
    const roundSizes = {};
    for (const [round, refs] of roundRefs) roundSizes[round] = refs.size;

    let queries;
    if (queryTexts.length > 0) {
      queries = queryTexts.map((text) => ({ text, roundIndex: null, domains: [] }));
    } else {
      queries = Array.from(rounds, ([roundIndex, domains]) => ({ text: null, roundIndex, domains }));
    }

    // The last model_dil_v2 message carries the final answer and its widgets.
    let answer = null;
    for (const message of messages) {
      if (isObject(message.metadata) && isObject(message.metadata.model_dil_v2)) answer = message;
    }
    const widgets = extractDilWidgets(answer);
    const dil = answer ? answer.metadata.model_dil_v2 : null;

    const quoted = [];
    const quotedSeen = new Map();
    for (const widget of widgets.cite) {
      const items = Array.isArray(widget.state.items) ? widget.state.items : [];
      const inWidget = new Set();
      for (const item of items) {
        if (!isObject(item) || typeof item.url !== 'string') continue;
        const normalizedUrl = normalizeUrl(item.url);
        const refId = typeof item.ref_id === 'string' ? item.ref_id : '';
        if (refId && !refUrls.has('id:' + refId)) refUrls.set('id:' + refId, item.url);
        if (quotedSeen.has(normalizedUrl)) {
          if (!inWidget.has(normalizedUrl)) quotedSeen.get(normalizedUrl).citeCount++;
          inWidget.add(normalizedUrl);
          continue;
        }
        inWidget.add(normalizedUrl);
        const entry = {
          url: item.url,
          normalizedUrl,
          domain: domainOf(item.url),
          title: typeof item.title === 'string' ? item.title : '',
          snippet: cleanSnippet(item.snippet),
          refId,
          viaStage: /view/.test(refId) ? 'accessed' : 'retrieved',
          citeWidgetId: widget.id,
          sourceLabel: typeof item.source_label === 'string' ? item.source_label : '',
          citeCount: 1,
          citedText: [],
        };
        quotedSeen.set(normalizedUrl, entry);
        quoted.push(entry);
      }
    }
    for (const message of messages) {
      const refs = isObject(message.metadata) && Array.isArray(message.metadata.content_references) ? message.metadata.content_references : [];
      for (const ref of refs) {
        if (!isObject(ref) || ref.type !== 'grouped_webpages' || !Array.isArray(ref.items)) continue;
        for (const item of ref.items) {
          if (!isObject(item) || typeof item.url !== 'string') continue;
          const normalizedUrl = normalizeUrl(item.url);
          if (quotedSeen.has(normalizedUrl)) continue;
          const entry = {
            url: item.url,
            normalizedUrl,
            domain: domainOf(item.url),
            title: typeof item.title === 'string' ? item.title : '',
            snippet: cleanSnippet(item.snippet),
            refId: '',
            viaStage: 'retrieved',
            citeWidgetId: '',
            sourceLabel: typeof item.attribution === 'string' ? item.attribution : '',
            citeCount: 1,
            citedText: [],
          };
          quotedSeen.set(normalizedUrl, entry);
          quoted.push(entry);
        }
      }
    }

    // No prototype: a domain comes from page data, and a host named __proto__ or
    // constructor must be an ordinary key, never a write to Object.prototype.
    const byDomain = Object.create(null);
    const bump = (domain, stage) => {
      if (!domain) return;
      if (!byDomain[domain]) byDomain[domain] = { retrieved: 0, accessed: 0, quoted: 0, recommended: 0 };
      byDomain[domain][stage]++;
    };
    retrieved.forEach((r) => bump(r.domain, 'retrieved'));
    accessed.forEach((r) => bump(r.domain, 'accessed'));
    quoted.forEach((r) => bump(r.domain, 'quoted'));
    widgets.link.forEach((l) => bump(typeof l.state.url === 'string' ? domainOf(l.state.url) : null, 'recommended'));

    const { positions, imageQueries } = scanDilCode(dil);
    const links = pairLinks(widgets.entity, widgets.link, positions);
    const images = pairImages(widgets.entity, widgets.image, positions);
    const recommended = widgets.entity.map((entity, i) => {
      const link = links[i];
      const linkDomain = link && typeof link.state.url === 'string' ? domainOf(link.state.url) : null;
      const image = images[i];
      const first = image && Array.isArray(image.state.images) ? image.state.images[0] : null;
      const imageUrl = first && (first.content_url || first.thumbnail_url);
      return {
        name: entityName(entity.state),
        category: entityCategory(entity.state),
        disambiguation: entityDisambiguation(entity.state),
        officialLink: link && typeof link.state.url === 'string' ? { url: link.state.url, domain: linkDomain } : null,
        imageQuery: image && typeof imageQueries[image.id] === 'string' ? imageQueries[image.id] : null,
        imageUrl: typeof imageUrl === 'string' ? imageUrl : null,
        tracedDomain: linkDomain && byDomain[linkDomain] && (byDomain[linkDomain].retrieved > 0 || byDomain[linkDomain].accessed > 0) ? linkDomain : null,
      };
    });

    let finalMessage = answer;
    let answerMarkdown = answer && typeof answer.metadata.model_dil_v2.fallbackMarkdown === 'string'
      ? cleanFallbackMarkdown(answer.metadata.model_dil_v2.fallbackMarkdown, answer)
      : null;
    if (answerMarkdown === null) {
      finalMessage = null;
      for (const message of messages) {
        if (message.author && message.author.role === 'assistant' && message.content && message.content.content_type === 'text') {
          const text = messageText(message);
          if (text) { finalMessage = message; answerMarkdown = cleanAnswerMarkdown(stripQuizMarkup(text)); }
        }
      }
    }

    // What each citation sits next to in the answer. Local only: data-client
    // strips citedText before an upload.
    for (const cite of citationContexts(finalMessage)) {
      if (!cite.text) continue;
      for (const ref of cite.refs) {
        const url = refUrls.get('id:' + ref) || refUrls.get(refKeyOf(ref));
        const entry = url ? quotedSeen.get(normalizeUrl(url)) : null;
        if (entry && !entry.citedText.includes(cite.text)) entry.citedText.push(cite.text);
      }
    }

    const userMessage = messages.find((m) => m.author && m.author.role === 'user');
    return {
      turnExchangeId,
      userQuery: userMessage ? messageText(userMessage) : '',
      finalMessageId: finalMessage ? ids.get(finalMessage) : null,
      queries,
      retrieved,
      roundSizes,
      accessed,
      quoted,
      recommended,
      byDomain,
      answerMarkdown,
    };
  }

  // One StageAnalysis per turn_exchange_id that has search content, ordered by
  // the turn's earliest create_time. Never throws on an unknown shape.
  function parseStages(data) {
    try {
      if (!isObject(data)) return [];
      const view = data.mapping ? data : messagesToMapping(Object.assign({}, data));
      const turns = new Map();
      const ids = new Map();
      let seq = 0;
      for (const [key, node] of Object.entries(view.mapping || {})) {
        const message = isObject(node) ? node.message : null;
        if (!isObject(message) || !isObject(message.metadata)) continue;
        const turnId = message.metadata.turn_exchange_id;
        if (typeof turnId !== 'string' || !turnId) continue;
        if (!turns.has(turnId)) turns.set(turnId, { first: seq++, earliest: Infinity, messages: [] });
        const turn = turns.get(turnId);
        const time = typeof message.create_time === 'number' ? message.create_time : Infinity;
        if (time < turn.earliest) turn.earliest = time;
        turn.messages.push(message);
        ids.set(message, (node && node.id) || message.id || key);
      }
      return Array.from(turns, ([id, turn]) => Object.assign({ id }, turn))
        .sort((a, b) => (a.earliest - b.earliest) || (a.first - b.first) || 0)
        .filter((turn) => turnHasSearch(turn.messages))
        .map((turn) => parseTurn(turn.id, turn.messages, ids));
    } catch (e) {
      return [];
    }
  }

  const JS_STRING = '"(?:[^"\\\\]|\\\\.)*"';
  // A control in the answer's markup or in the compiled DIL code. Both forms
  // pass through one scan, once constants in the code are resolved to literals.
  const QUIZ_CONTROL_RE = new RegExp(`<(radio-group|input)\\b((?:${JS_STRING}|[^>"])*)>|__dil\\.jsx\\("(radio-group|input)",(\\{(?:${JS_STRING}|[^{}"])*\\})`, 'g');
  const QUIZ_VARIABLE_RE = /(?:\bvalue=\{|"value":)([\w$]+)/;
  const QUIZ_PLACEHOLDER_RE = new RegExp(`(?:\\bplaceholder=|"placeholder":)(${JS_STRING})`);
  const QUIZ_STATE_RE = new RegExp(`const\\s*\\[\\s*([\\w$]+)\\s*,\\s*[\\w$]+\\s*\\]\\s*=\\s*DIL\\.useState\\((${JS_STRING})`, 'g');
  const QUIZ_OPTION_LIST_RE = new RegExp(`(\\[\\s*${JS_STRING}(?:\\s*,\\s*${JS_STRING})*\\s*\\])\\)?(?:\\.map\\(|\\s+as\\s)`);
  const QUIZ_OPTION_RE = new RegExp(`(?:<radio\\s+value=|__dil\\.jsx\\("radio",\\{"value":)(${JS_STRING})`, 'g');
  const QUIZ_HEADING_RE = new RegExp(`^[ \\t]*\\*\\*(.+?)\\*\\*[ \\t]*$|__dil\\.jsx\\("text",null,__dil\\.jsx\\("bold",null,(${JS_STRING})\\)\\)`, 'gm');
  const QUIZ_TITLE_RE = new RegExp(`^#{2,}[ \\t]+(.+)$|__dil\\.jsx\\("title",\\{[^{}]*\\},(${JS_STRING})\\)`, 'gm');
  const QUIZ_SUBMIT_RE = new RegExp(`GenUI\\.issueNewTurn\\(((?:${JS_STRING}|[^)"])*)\\)`, 'g');
  const QUIZ_TEMPLATE_RE = new RegExp(`^\\s*(?:${JS_STRING}|[\\w$]+)(?:\\s*\\+\\s*(?:${JS_STRING}|[\\w$]+))*\\s*$`);
  const QUIZ_TEMPLATE_TOKEN_RE = new RegExp(`${JS_STRING}|[\\w$]+`, 'g');
  const QUIZ_LAYOUT_RE = new RegExp(`\\{@[^\\n]*\\}|<[^>]*>|__dil\\.jsx\\("(?:box|row|divider)",(?:\\{(?:${JS_STRING}|[^{}"])*\\}|null),?|__dilSafe\\(\\(\\)=>\\(|[\\s,()]`, 'g');

  function jsString(literal) {
    try {
      const value = JSON.parse(literal);
      return typeof value === 'string' ? value : null;
    } catch (e) {
      return null;
    }
  }

  function lastMatch(re, text) {
    let last = null;
    for (const match of text.matchAll(re)) last = match;
    return last;
  }

  function resolvedDilCode(dil) {
    if (!isObject(dil) || typeof dil.code !== 'string') return '';
    const constants = isObject(dil.constants) ? dil.constants : {};
    return dil.code.replace(/__dilConstants\["(\d+)"\]/g, (reference, key) => {
      const literal = JSON.stringify(constants[key]);
      return literal === undefined ? reference : literal;
    });
  }

  // The bold line right above a control. Text after it means it headed something else.
  function quizHeading(before) {
    const match = lastMatch(QUIZ_HEADING_RE, before);
    if (!match) return '';
    if (before.slice(match.index + match[0].length).replace(QUIZ_LAYOUT_RE, '') !== '') return '';
    const text = match[1] !== undefined ? match[1] : jsString(match[2]);
    return (text || '').replace(/^\d+\\?[.)]\s+/, '').trim();
  }

  function quizOptions(block) {
    const list = QUIZ_OPTION_LIST_RE.exec(block);
    if (list) {
      try {
        return JSON.parse(list[1]);
      } catch (e) {
        return [];
      }
    }
    return Array.from(block.matchAll(QUIZ_OPTION_RE), (match) => jsString(match[1])).filter((option) => option !== null);
  }

  // ChatGPT runs this code in the page. Here it is only read as text, never run.
  function readQuizSource(source) {
    const preselected = {};
    for (const match of source.matchAll(QUIZ_STATE_RE)) preselected[match[1]] = jsString(match[2]);

    const controls = Array.from(source.matchAll(QUIZ_CONTROL_RE));
    const questions = [];
    controls.forEach((control, i) => {
      const end = control.index + control[0].length;
      const previousEnd = i > 0 ? controls[i - 1].index + controls[i - 1][0].length : 0;
      const next = i + 1 < controls.length ? controls[i + 1].index : source.length;
      const attributes = control[2] !== undefined ? control[2] : control[4];
      const variable = (QUIZ_VARIABLE_RE.exec(attributes) || [])[1] || null;
      const isChoice = (control[1] || control[3]) === 'radio-group';
      const options = isChoice ? quizOptions(source.slice(end, next)) : [];
      if (isChoice && options.length === 0) return;
      const placeholder = QUIZ_PLACEHOLDER_RE.exec(attributes);
      questions.push({
        variable,
        text: quizHeading(source.slice(previousEnd, control.index)),
        kind: isChoice ? 'choice' : 'text',
        options,
        preselected: variable && typeof preselected[variable] === 'string' ? preselected[variable] : null,
        placeholder: placeholder ? jsString(placeholder[1]) : null,
        chosen: null,
      });
    });

    const templates = Array.from(source.matchAll(QUIZ_SUBMIT_RE), (match) => match[1]);
    const isQuiz = questions.some((q) => q.kind === 'choice') || (questions.length > 0 && templates.length > 0);
    if (!isQuiz) return null;
    const firstControl = controls[0].index;
    const title = lastMatch(QUIZ_TITLE_RE, source.slice(0, firstControl));
    return {
      title: title ? (title[1] !== undefined ? title[1].trim() : jsString(title[2])) : null,
      questions,
      templates,
    };
  }

  // When ChatGPT opens a page, the entry's snippet is the page tool's line count
  // ("Total lines: 118\n"), not text from the page.
  const PAGE_LINE_COUNT_RE = /^\s*Total lines:\s*\d+\s*$/;

  function cleanSnippet(snippet) {
    return typeof snippet === 'string' && !PAGE_LINE_COUNT_RE.test(snippet) ? snippet : '';
  }

  const CODE_FENCE_RE = /^[ \t]*(`{3,}|~{3,})[^\n]*\n[\s\S]*?(?:^[ \t]*\1[ \t]*$|$(?![\s\S]))/gm;

  // Applies a change to the text around fenced code, which stays literal.
  function outsideCodeFences(text, change) {
    let out = '';
    let last = 0;
    for (const fence of text.matchAll(CODE_FENCE_RE)) {
      out += change(text.slice(last, fence.index)) + fence[0];
      last = fence.index + fence[0].length;
    }
    return out + change(text.slice(last));
  }

  // Removed lines leave their blank lines behind. Unchanged text stays as it was.
  function tidyAfterRemoval(before, after) {
    if (before === after) return before;
    return after.replace(/^[ \t]+$/gm, '').replace(/\n{3,}/g, '\n\n').trim();
  }

  // The DIL fallback renders a form's controls as text: "[Input placeholder: x]
  // (Current value unavailable.)" for a field and "[Label]" for a button.
  const FORM_FIELD_LINE_RE = /^[ \t]*\[(?:(?:Input|Textarea|Select) placeholder: [^\]\n]*\](?:[ \t]*\(Current value[^\n]*\))?|(?:Input|Textarea|Select)\][ \t]*\(Current value[^\n]*\))[ \t]*$/;
  const BRACKET_LINE_RE = /^[ \t]*\[([^\[\]\n]+)\][ \t]*$/;

  // A "[Label]" line is a button only if the answer's own markup has that button,
  // so a bracketed line the model wrote stays.
  function hasFormButton(label, message) {
    const parts = isObject(message) && isObject(message.content) && Array.isArray(message.content.parts) ? message.content.parts : [];
    const source = parts.filter((part) => typeof part === 'string').join('\n');
    if (source.includes(`>${label}</button>`)) return true;
    const code = resolvedDilCode(isObject(message) && isObject(message.metadata) ? message.metadata.model_dil_v2 : null);
    return code.includes('__dil.jsx("button"') && code.includes(`,${JSON.stringify(label)})`);
  }

  function stripFormLines(text, message) {
    return text.split('\n').filter((line) => {
      if (FORM_FIELD_LINE_RE.test(line)) return false;
      const button = BRACKET_LINE_RE.exec(line);
      return !(button && hasFormButton(button[1].replace(/\\(.)/g, '$1'), message));
    }).join('\n');
  }

  // Only the characters an HTML escaper writes. Each decodes once, and none of
  // them is Markdown link or emphasis syntax. Whatever shows this text must treat
  // it as text, as it must any other answer text: "<" can be in an answer anyway.
  const ESCAPED_ENTITIES = { '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&apos;': "'", '&#39;': "'", '&#x27;': "'" };

  function decodeEscapedEntities(text) {
    return text.split(/(`[^`\n]*`)/).map((piece, i) => (
      i % 2 === 1 ? piece : piece.replace(/&(?:amp|lt|gt|quot|apos|#39|#x27);/g, (entity) => ESCAPED_ENTITIES[entity])
    )).join('');
  }

  // fallbackMarkdown is a rendering of the answer, and the only source that
  // HTML-escapes it: the same answer's parts say "P&L" where it says "P&amp;L".
  function cleanFallbackMarkdown(text, message) {
    const clean = cleanAnswerMarkdown(text);
    const withoutForms = outsideCodeFences(clean, (piece) => stripFormLines(piece, message));
    const decoded = outsideCodeFences(tidyAfterRemoval(clean, withoutForms), decodeEscapedEntities);
    // Markers that render nothing (product cards, image groups) leave their
    // line behind; drop the resulting runs of blank lines outside code.
    return outsideCodeFences(decoded, collapseBlankLines).trim();
  }

  function collapseBlankLines(text) {
    return text.replace(/^[ \t]+$/gm, '').replace(/\n{3,}/g, '\n\n');
  }

  // ChatGPT names a new chat during the answer stream ("title_generation", sent
  // first as a draft and then refined). The conversation fetched right after the
  // answer can still say "New chat", so the last streamed title is kept.
  const STREAM_TITLE_RE = /"type"\s*:\s*"title_generation"\s*,\s*"title"\s*:\s*("(?:[^"\\]|\\.)*")/g;

  function streamTitle(text) {
    if (typeof text !== 'string' || !text) return null;
    let title = null;
    for (const match of text.matchAll(STREAM_TITLE_RE)) {
      try {
        const value = JSON.parse(match[1]);
        if (typeof value === 'string' && value.trim()) title = value.trim();
      } catch (e) {
        // a malformed event is skipped
      }
    }
    return title;
  }

  const PLACEHOLDER_TITLE = 'New chat';

  // The conversation's own title, unless it is still ChatGPT's placeholder.
  function chatTitle(conversationTitle, streamed) {
    const own = typeof conversationTitle === 'string' ? conversationTitle.trim() : '';
    if (own && own !== PLACEHOLDER_TITLE) return conversationTitle;
    if (typeof streamed === 'string' && streamed.trim()) return streamed.trim();
    return own || null;
  }

  const QUIZ_MARKUP_RE = /<(radio-group|checkbox-group|select|textarea|button|input|radio|checkbox|option)\b|\{#each\b|\{@/g;
  const QUIZ_RUNTIME_LINE_RE = /^.*(?:GenUI\.issueNewTurn|DIL\.useState|__dil\.jsx\("(?:radio|checkbox|select|input|textarea)).*(?:\n|$)/gm;

  // The index just past the tag or {...} block opening at `start`, reading quoted
  // strings and nested braces whole, since "=>" sits inside handlers. -1 if unclosed.
  function markupEnd(text, start, closer) {
    let depth = 0;
    let inString = false;
    for (let i = start; i < text.length; i++) {
      const char = text[i];
      if (inString) {
        if (char === '\\') i++;
        else if (char === '"') inString = false;
      } else if (char === '"') inString = true;
      else if (char === '{') depth++;
      else if (char === '}') {
        depth--;
        if (closer === '}' && depth === 0) return i + 1;
      } else if (char === '>' && closer === '>' && depth === 0) return i + 1;
    }
    return -1;
  }

  // Where the control starting at this match ends, or -1 if it never does.
  function quizMarkupEnd(text, match) {
    if (match[0] === '{@') return markupEnd(text, match.index, '}');
    if (match[0] === '{#each') {
      const close = text.indexOf('{/each}', match.index);
      return close === -1 ? -1 : close + '{/each}'.length;
    }
    const open = markupEnd(text, match.index, '>');
    if (open === -1 || match[1] === 'input' || text[open - 2] === '/') return open;
    const close = text.indexOf(`</${match[1]}`, open);
    return close === -1 ? -1 : markupEnd(text, close, '>');
  }

  // A quiz's options must never leave the browser (spec P2). This walks the raw
  // answer markup and removes each control whole. A control that never closes,
  // as in a partial capture, takes the rest of the text with it: losing the end
  // of an answer is better than uploading its options.
  function removeQuizControls(text) {
    let out = '';
    let last = 0;
    const scan = new RegExp(QUIZ_MARKUP_RE);
    for (let match = scan.exec(text); match; match = scan.exec(text)) {
      const end = quizMarkupEnd(text, match);
      out += text.slice(last, match.index);
      if (end === -1) return out;
      last = end;
      scan.lastIndex = end;
    }
    return out + text.slice(last);
  }

  function stripQuizMarkup(text) {
    const stripped = outsideCodeFences(text, (piece) => removeQuizControls(piece).replace(QUIZ_RUNTIME_LINE_RE, ''));
    return tidyAfterRemoval(text, stripped);
  }

  function readQuiz(message) {
    const parts = isObject(message.content) && Array.isArray(message.content.parts) ? message.content.parts : [];
    return readQuizSource(parts.filter((part) => typeof part === 'string').join('\n')) ||
      readQuizSource(resolvedDilCode(isObject(message.metadata) ? message.metadata.model_dil_v2 : null));
  }

  const escapeRegExp = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

  // The answers in a prompt that is ChatGPT's own button text with every value
  // filled in and every option a real one. Anything else gives null: a quiz's
  // pre-selected values say nothing about what the user picked.
  function answersFromPrompt(template, questions, prompt) {
    if (!QUIZ_TEMPLATE_RE.test(template)) return null;
    const byVariable = new Map(questions.map((q) => [q.variable, q]));
    const variables = [];
    let pattern = '';
    for (const [token] of template.matchAll(QUIZ_TEMPLATE_TOKEN_RE)) {
      if (token[0] === '"') {
        const literal = jsString(token);
        if (literal === null) return null;
        pattern += escapeRegExp(literal);
        continue;
      }
      const question = byVariable.get(token);
      if (!question) return null;
      variables.push(token);
      pattern += question.kind === 'choice'
        ? `(${[...question.options].sort((a, b) => b.length - a.length).map(escapeRegExp).join('|')})`
        : '([\\s\\S]*?)';
    }
    if (variables.length === 0) return null;
    const match = new RegExp(`^${pattern}$`).exec(prompt.trim());
    if (!match) return null;
    const answers = new Map();
    for (let i = 0; i < variables.length; i++) {
      if (answers.has(variables[i]) && answers.get(variables[i]) !== match[i + 1]) return null;
      answers.set(variables[i], match[i + 1]);
    }
    return answers;
  }

  // The quizzes ChatGPT asked in the answer on screen, one per turn. Read in the
  // panel from the local capture: parseStages output uploads, so this stays out
  // of it. Never throws on an unknown shape.
  function parseQuizzes(data) {
    try {
      if (!isObject(data)) return [];
      const view = answerView(messagesToMapping(data.mapping ? data : Object.assign({}, data)));
      const messages = Object.entries(view.mapping || {})
        .filter(([, node]) => isObject(node) && isObject(node.message))
        .map(([key, node]) => ({ key, message: node.message, time: typeof node.message.create_time === 'number' ? node.message.create_time : Infinity }))
        .sort((a, b) => (a.time === b.time ? 0 : a.time - b.time));

      const turns = new Map();
      messages.forEach(({ key, message }, index) => {
        if (!message.author || message.author.role !== 'assistant') return;
        const quiz = readQuiz(message);
        if (!quiz) return;
        const metadata = isObject(message.metadata) ? message.metadata : {};
        // A turn can repeat its quiz in a later message. The last one is the one on screen.
        turns.set(metadata.turn_exchange_id || key, { quiz, index, messageId: message.id || key, turnExchangeId: metadata.turn_exchange_id || null });
      });

      return Array.from(turns.values(), ({ quiz, index, messageId, turnExchangeId }) => {
        const nextUser = messages.slice(index + 1).find(({ message }) => message.author && message.author.role === 'user' && messageText(message));
        if (nextUser) {
          for (const template of quiz.templates) {
            const answers = answersFromPrompt(template, quiz.questions, messageText(nextUser.message));
            if (!answers) continue;
            for (const question of quiz.questions) {
              if (answers.has(question.variable)) question.chosen = answers.get(question.variable);
            }
            break;
          }
        }
        return {
          turnExchangeId,
          messageId,
          title: quiz.title,
          questions: quiz.questions.map(({ variable, ...question }) => question),
        };
      });
    } catch (e) {
      return [];
    }
  }

  // Keys here are ids or come from the chat, so the shape never names them.
  const DYNAMIC_MAPS = new Set(['mapping', 'componentResults', 'constants', 'modelDataBindings']);
  const FIELD_NAME_RE = /^[a-z][a-zA-Z0-9_]{0,40}$/;
  const COMPONENT_NAME_RE = /^[A-Z][A-Za-z0-9]{0,40}$/;
  const DIL_TAG_RE = /__dil\.jsx\("([a-z][a-z-]{0,30})"/g;
  const MAX_SHAPE_PATHS = 1000;
  const MAX_SHAPE_DEPTH = 14;
  const MAX_SHAPE_NODES = 50000;

  function hashText(text) {
    let hash = 0x811c9dc5;
    for (let i = 0; i < text.length; i++) {
      hash ^= text.charCodeAt(i);
      hash = Math.imul(hash, 0x01000193);
    }
    return (hash >>> 0).toString(16).padStart(8, '0');
  }

  // The field names and types of a response, for diagnostics: what ChatGPT sent,
  // never what it said. Strings, numbers and chat-derived keys stay out.
  function responseShape(data) {
    const paths = new Set();
    const components = new Set();
    const seen = new WeakSet();
    let nodes = 0;

    const walk = (value, path, depth) => {
      if (++nodes > MAX_SHAPE_NODES || depth > MAX_SHAPE_DEPTH) return;
      if (value === null || typeof value !== 'object') {
        if (path) paths.add(`${path}:${value === null ? 'null' : typeof value}`);
        return;
      }
      if (seen.has(value)) return;
      seen.add(value);
      if (Array.isArray(value)) {
        if (value.length === 0) paths.add(`${path}:array`);
        for (const item of value) walk(item, `${path}[]`, depth + 1);
        return;
      }
      const keys = Object.keys(value);
      if (keys.length === 0 && path) paths.add(`${path}:object`);
      const parentKey = path.split('.').pop();
      // Native tags such as radio-group, which quizzes use, appear only in the DIL code
      if (parentKey === 'model_dil_v2' && typeof value.code === 'string') {
        for (const match of value.code.matchAll(DIL_TAG_RE)) {
          components.add(match[1].split('-').map((part) => part[0].toUpperCase() + part.slice(1)).join(''));
        }
      }
      if (typeof value.componentName === 'string' && COMPONENT_NAME_RE.test(value.componentName)) {
        components.add(value.componentName);
      }
      for (const key of keys) {
        const name = !DYNAMIC_MAPS.has(parentKey) && FIELD_NAME_RE.test(key) ? key : '*';
        walk(value[key], path ? `${path}.${name}` : name, depth + 1);
      }
    };

    try {
      walk(data, '', 0);
    } catch (e) {
      // A shape is best effort; the capture must not depend on it
    }
    const all = [...paths].sort((a, b) => a.split('.').length - b.split('.').length || a.localeCompare(b));
    return { hash: hashText(all.join('\n')), paths: all.slice(0, MAX_SHAPE_PATHS), components: [...components].sort() };
  }

  const ENTITY_TYPE_MAP = {
    organization: 'organization',
    org: 'organization',
    company: 'organization',
    corporation: 'organization',
    brand: 'brand',
    product: 'product',
    products: 'product',
    product_entity: 'product',
    service: 'product',
    software: 'software',
    tool: 'software',
    app: 'software',
    application: 'software',
    place: 'place',
    location: 'place',
    city: 'place',
    country: 'place',
    person: 'person',
    people: 'person',
    individual: 'person',
    author: 'person',
    unknown: 'entity',
    entity: 'entity',
    local_business: 'place'
  };

  function normalizeEntityType(rawType, fallback = 'entity') {
    if (rawType === null || rawType === undefined) {
      return fallback;
    }

    let str = String(rawType).trim();
    if (!str) {
      return fallback;
    }

    let lower = str.toLowerCase();

    const turnMatch = lower.match(/^turn\d*([a-z]+)/);
    if (turnMatch && turnMatch[1]) {
      lower = turnMatch[1];
    }

    const mapped = ENTITY_TYPE_MAP[lower];
    if (mapped) {
      return mapped;
    }

    return lower || fallback;
  }

  // A resolved Entity widget inside componentResults, as both clients send it:
  // the state opens with the name, then action_payload with the category and
  // an optional disambiguation. Link and Cite widgets have no action_payload.
  const LIVE_ENTITY_RE = /"status":"resolved","state":\{"value":("(?:[^"\\]|\\.)*"),"action_payload":\{"query":"(?:[^"\\]|\\.)*","category":("(?:[^"\\]|\\.)*")(?:,"extraParams":\{"disambiguation":("(?:[^"\\]|\\.)*"))?/g;
  const MAX_LIVE_ENTITIES = 20;

  const LIVE_QUERIES_RE = /"search_model_queries"\s*:\s*\{[^{}]*?"queries"\s*:\s*(\[(?:[^\]"\\]|"(?:[^"\\]|\\.)*")*\])/g;
  const LIVE_SITE_RE = /favicons\?domain=([a-z0-9.-]+)(?=[&\\"])/gi;
  // The logged-out client's own status record is "text":"Searching the web";
  // inside answer text the quotes would be escaped, so that form can't match.
  const LIVE_SEARCHING_RE = /"recipient"\s*:\s*"web\.run"|"reasoning_titles?"\s*:\s*\[?\s*"Searching|"text":"Searching the web"/;
  const LIVE_OVERLAP = 4096; // a value can straddle two chunks

  // Reads a running answer's stream for what it has searched so far. It sees
  // chunks, not messages, so it holds the end of each chunk for the next.
  function createLiveTracker() {
    const queries = new Set();
    const sites = new Set();
    const entities = [];
    let searching = false;
    let tail = '';
    let lastKey = '';

    const status = () => ({ searching, queries: [...queries], sites: sites.size, entities: entities.map((e) => ({ ...e })) });

    const decode = (json) => {
      if (json === undefined) return null;
      try { return JSON.parse(json); } catch (e) { return undefined; }
    };

    function feed(chunk) {
      const text = tail + chunk;
      tail = text.slice(-LIVE_OVERLAP);
      for (const match of text.matchAll(LIVE_QUERIES_RE)) {
        try {
          for (const query of JSON.parse(match[1])) {
            if (typeof query === 'string') queries.add(query);
          }
        } catch (e) {
          // A cut-off array comes round again in the next chunk
        }
      }
      for (const match of text.matchAll(LIVE_SITE_RE)) {
        sites.add(match[1].toLowerCase().replace(/^www\./, ''));
      }
      for (const match of text.matchAll(LIVE_ENTITY_RE)) {
        const name = decode(match[1]);
        const category = decode(match[2]);
        const disambiguation = decode(match[3]);
        if (typeof name !== 'string' || !name || typeof category !== 'string' || disambiguation === undefined) continue;
        const known = entities.find((e) => e.name === name);
        if (known) {
          // A chunk can end inside the optional disambiguation; the whole widget comes round again.
          if (known.disambiguation === null && typeof disambiguation === 'string') known.disambiguation = disambiguation;
          continue;
        }
        if (entities.length >= MAX_LIVE_ENTITIES) continue;
        entities.push({ name, type: normalizeEntityType(category), disambiguation: typeof disambiguation === 'string' ? disambiguation : null });
      }
      if (LIVE_SEARCHING_RE.test(text)) searching = true;
      if (queries.size > 0 || sites.size > 0) searching = true;

      const key = JSON.stringify(status());
      const changed = key !== lastKey && searching;
      lastKey = key;
      return changed;
    }

    return { feed, status };
  }

  const api = { citationContexts, createLiveTracker, streamTitle, chatTitle, normalizeEntityType, responseShape, normalizeUrl, domainOf, messagesToMapping, activeMapping, answerView, cleanAnswerMarkdown, cleanFallbackMarkdown, stripQuizMarkup, cleanSnippet, extractDilWidgets, hasSearchContent, firstStringPart, parseStages, parseQuizzes, resultGroupsOf };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  } else {
    window.CSIStageParser = api;
  }

})();
