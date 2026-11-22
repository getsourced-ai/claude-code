// ChatGPT Search Insights - Records to stages (MAIN world, classic script)
// Normalized capture records (one chat turn each) -> stages, search data and
// entity data, in the shapes stage-parser.js parseStages and interceptor.js
// produce. Used by optional AI sites such as Perplexity.
//
// Ported verbatim from the capture prototype, tools/capture/lib/stages.mjs and
// lib/record.mjs at commit be14c87656f3b53e5defbf4b8aebcd3b904f5f27. The one
// intentional omission is detailFromRecords, which the surface adapter owns.
// URL, domain, snippet and entity-type handling call the stage parser's own
// helpers (CSIStageParser) so they cannot drift.

(function() {
  'use strict';

  const SP = (typeof module !== 'undefined' && module.exports)
    ? require('./stage-parser.js')
    : (typeof window !== 'undefined' ? window.CSIStageParser : undefined);

  /** Epoch seconds from seconds, ms or an ISO string. */
  function toEpochSeconds(value) {
    if (value == null) return null;
    if (typeof value === 'number') return value > 1e12 ? value / 1000 : value;
    const ms = Date.parse(value);
    return Number.isNaN(ms) ? null : ms / 1000;
  }

  /**
   * A source's publish date as epoch seconds. Perplexity sends zone-less ISO
   * times ("2026-07-16T00:00:00"), which Date.parse reads in the machine's zone.
   * Read them as UTC instead, so the date is the same for every user.
   */
  function publishedToEpochSeconds(value) {
    const zoneless = typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?$/.test(value);
    return toEpochSeconds(zoneless ? `${value}Z` : value);
  }

  /** Epoch ms from ms, seconds or an ISO string. */
  function toEpochMs(value) {
    if (value == null) return null;
    if (typeof value === 'number') return value < 1e12 ? Math.round(value * 1000) : value;
    const ms = Date.parse(value);
    return Number.isNaN(ms) ? null : ms;
  }

  const text = (v) => (typeof v === 'string' ? v : '');

  function provenanceOf(items) {
    const kinds = new Set(items.map((i) => i.provenance).filter(Boolean));
    if (kinds.size === 0) return null;
    return kinds.size === 1 ? [...kinds][0] : 'mixed';
  }

  /** One record (one turn) -> a StageAnalysis like parseTurn returns. */
  function stageFromRecord(record, index = 0) {
    const results = Array.isArray(record.results) ? record.results : [];
    const opened = Array.isArray(record.opened) ? record.opened : [];
    const citations = Array.isArray(record.citations) ? record.citations : [];
    // Nameless entities are skipped here and in entityDataFromRecords alike. A
    // place card the answer does not name (named_in_answer false) is kept in
    // entity_data but is not something the answer recommended.
    const entities = (Array.isArray(record.entities) ? record.entities : [])
      .filter((e) => e && typeof e.name === 'string' && e.name.trim() && e.named_in_answer !== false);
    const queriesIn = Array.isArray(record.queries) ? record.queries : [];

    // retrieved: one entry per normalized URL, best (lowest) rank kept.
    const retrieved = [];
    const byUrl = new Map();
    const roundRefs = new Map();
    const roundDomains = new Map();
    for (const r of results) {
      const normalizedUrl = SP.normalizeUrl(r.url);
      const domain = SP.domainOf(r.url);
      const round = Number.isInteger(r.round) ? r.round : null;
      const rank = Number.isInteger(r.rank) ? r.rank : null;
      if (!roundRefs.has(round)) roundRefs.set(round, new Set());
      if (rank !== null) roundRefs.get(round).add(rank);
      if (!roundDomains.has(round)) roundDomains.set(round, []);
      if (domain && !roundDomains.get(round).includes(domain)) roundDomains.get(round).push(domain);

      const prior = byUrl.get(normalizedUrl);
      if (prior) {
        if (rank !== null && (prior.bestRank === null || rank < prior.bestRank.refIndex)) {
          prior.bestRank = { roundIndex: round, refIndex: rank };
        }
        continue;
      }
      const entry = {
        url: r.url,
        normalizedUrl,
        domain,
        title: text(r.title),
        snippet: SP.cleanSnippet(r.snippet),
        pubDate: publishedToEpochSeconds(r.published),
        roundIndex: round,
        refIndex: rank,
        bestRank: rank === null ? null : { roundIndex: round, refIndex: rank },
      };
      byUrl.set(normalizedUrl, entry);
      retrieved.push(entry);
    }
    const roundSizes = {};
    for (const [round, refs] of roundRefs) roundSizes[round] = refs.size;

    const accessed = [];
    const openedSeen = new Set();
    for (const o of opened) {
      const normalizedUrl = SP.normalizeUrl(o.url);
      if (openedSeen.has(normalizedUrl)) continue;
      openedSeen.add(normalizedUrl);
      // o.reason (why a page was fetched) is deliberately not carried: it is
      // model- or user-written text, not a captured field of the page.
      accessed.push({ url: o.url, normalizedUrl, domain: SP.domainOf(o.url), title: text(o.title), roundIndex: null, refIndex: null });
    }

    const quoted = [];
    const quotedSeen = new Map();
    for (const c of citations) {
      const normalizedUrl = SP.normalizeUrl(c.url);
      const prior = quotedSeen.get(normalizedUrl);
      if (prior) {
        prior.citeCount += Number.isInteger(c.cite_count) ? c.cite_count : 1;
        continue;
      }
      const entry = {
        url: c.url,
        normalizedUrl,
        domain: SP.domainOf(c.url),
        title: text(c.title),
        snippet: SP.cleanSnippet(c.snippet),
        refId: '',
        viaStage: openedSeen.has(normalizedUrl) ? 'accessed' : 'retrieved',
        citeWidgetId: '',
        sourceLabel: text(c.source_label),
        citeCount: Number.isInteger(c.cite_count) ? c.cite_count : 1,
        // Local only, like the extension: data-client.js strips it before upload.
        citedText: Array.isArray(c.cited_text) ? c.cited_text.filter((t) => typeof t === 'string') : [],
        provenance: c.provenance,
      };
      quotedSeen.set(normalizedUrl, entry);
      quoted.push(entry);
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

    const recommended = entities.map((e) => {
      const linkDomain = e.official_url ? SP.domainOf(e.official_url) : null;
      if (linkDomain) bump(linkDomain, 'recommended');
      const entry = {
        name: e.name,
        category: typeof e.type === 'string' ? e.type : null,
        disambiguation: typeof e.disambiguation === 'string' ? e.disambiguation : null,
        officialLink: e.official_url ? { url: e.official_url, domain: linkDomain } : null,
        imageQuery: null,
        imageUrl: null,
        tracedDomain: null,
        provenance: e.provenance,
      };
      if (e.via === 'place_card') Object.assign(entry, { via: e.via, namedInAnswer: true });
      return entry;
    });
    for (const r of recommended) {
      const d = r.officialLink && r.officialLink.domain;
      r.tracedDomain = d && byDomain[d] && (byDomain[d].retrieved > 0 || byDomain[d].accessed > 0) ? d : null;
    }

    // Query text when the surface gives it; otherwise rounds with their domains,
    // as the extension shows logged-out ChatGPT (S3: query text is never invented).
    const texts = queriesIn.filter((q) => typeof q.text === 'string' && q.text.trim());
    const queries = texts.length > 0
      ? texts.map((q) => ({ text: q.text, roundIndex: Number.isInteger(q.round) ? q.round : null, domains: [] }))
      : queriesIn.filter((q) => Number.isInteger(q.round)).map((q) => ({ text: null, roundIndex: q.round, domains: roundDomains.get(q.round) || [] }));

    return {
      turnExchangeId: record.turn_id || `turn-${index}`,
      userQuery: record.prompt,
      finalMessageId: record.turn_id || null,
      queries,
      retrieved,
      roundSizes,
      accessed,
      quoted,
      recommended,
      byDomain,
      answerMarkdown: typeof record.answer_markdown === 'string' ? record.answer_markdown : null,
    };
  }

  // The UTC calendar date in the en-US shape (M/D/YYYY), so it does not depend on
  // the machine's time zone or locale. Only Perplexity records reach this code.
  const legacyDate = (seconds) => (seconds ? new Date(seconds * 1000).toLocaleDateString('en-US', { timeZone: 'UTC' }) : null);

  /** The search_data top-level fields parseSearchData produces, over all turns. */
  function searchDataFromStages(records, stages) {
    const result = { hasSearch: false, userQueries: [], searchQueries: [], results: [], citations: [] };
    let searchQueryIdx = 0;
    stages.forEach((stage, userQueryIdx) => {
      const record = records[userQueryIdx];
      const searched = stage.queries.length > 0 || stage.retrieved.length > 0 || stage.quoted.length > 0;
      if (!searched) {
        result.citations.push(...stage.quoted.map((q) => ({ title: q.title, url: q.url, snippet: q.snippet, attribution: q.sourceLabel })));
        return;
      }
      result.hasSearch = true;
      result.userQueries.push({ text: stage.userQuery, nodeId: stage.finalMessageId, timestamp: toEpochSeconds(record.asked_at), turnExchangeId: stage.turnExchangeId });
      const indexes = [];
      for (const q of stage.queries) {
        if (!q.text) continue;
        result.searchQueries.push({ text: q.text, userQueryIdx, searchQueryIdx });
        indexes.push(searchQueryIdx++);
      }
      for (const r of stage.retrieved) {
        result.results.push({
          domain: r.domain || 'unknown',
          url: r.url,
          title: r.title || 'No title',
          snippet: r.snippet,
          pubDate: legacyDate(r.pubDate),
          refType: 'search',
          userQueryIdx,
          searchQueryIndexes: indexes,
          searchQueryIdx: indexes[0],
        });
      }
      for (const q of stage.quoted) {
        result.citations.push({ title: q.title, url: q.url, snippet: q.snippet, attribution: q.sourceLabel, userQueryIdx });
      }
    });
    return result;
  }

  /** entity_data in parseEntities' shape. */
  function entityDataFromRecords(records) {
    const entities = new Map();
    const types = new Set();
    for (const record of records) {
      for (const e of Array.isArray(record.entities) ? record.entities : []) {
        // An entity with no name cannot be keyed or shown, so it is skipped.
        if (!e || typeof e.name !== 'string' || !e.name.trim()) continue;
        const type = SP.normalizeEntityType(e.type, 'entity');
        const key = `${type}:${e.name.toLowerCase()}`;
        const metadata = {
          disambiguation: typeof e.disambiguation === 'string' ? e.disambiguation : null,
          officialLink: e.official_url || null,
        };
        for (const field of ['website', 'rating', 'address', 'description', 'price', 'currency']) {
          if (e[field] != null) metadata[field] = e[field];
        }
        if (Number.isInteger(e.review_count)) metadata.reviewCount = e.review_count;
        // Shopping offers (Gemini, Google AI Mode, AI Overviews): named fields only.
        if (Array.isArray(e.merchants) && e.merchants.length) {
          metadata.merchants = e.merchants.map((m) => ({
            name: m.name,
            url: typeof m.url === 'string' ? m.url : null,
            price: m.price ?? null,
            currency: typeof m.currency === 'string' ? m.currency : null,
          }));
        }
        const card = e.via === 'place_card';
        if (entities.has(key)) {
          const existing = entities.get(key);
          // Named in any turn's answer counts as named in the chat.
          if (card && existing.via === 'place_card') existing.namedInAnswer = existing.namedInAnswer || e.named_in_answer === true;
          existing.metadata = { ...existing.metadata, ...Object.fromEntries(Object.entries(metadata).filter(([, v]) => v != null)) };
          if (e.official_url && !existing.safeUrls.includes(e.official_url)) existing.safeUrls.push(e.official_url);
          continue;
        }
        const entity = {
          type,
          name: e.name,
          id: typeof e.id === 'string' ? e.id : null,
          metadata,
          refs: [],
          safeUrls: e.official_url ? [e.official_url] : [],
          provenance: e.provenance,
        };
        if (card) Object.assign(entity, { via: 'place_card', namedInAnswer: e.named_in_answer === true });
        entities.set(key, entity);
        types.add(type);
      }
    }
    const list = [...entities.values()].sort((a, b) => (a.type !== b.type ? a.type.localeCompare(b.type) : a.name.localeCompare(b.name)));
    return { hasEntities: list.length > 0, entities: list, entityTypes: [...types].sort(), entityPositions: [] };
  }


  const api = { stageFromRecord, searchDataFromStages, entityDataFromRecords, provenanceOf, toEpochSeconds, toEpochMs };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  } else {
    window.CSIRecordStages = api;
  }

})();
