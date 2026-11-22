// ChatGPT Search Insights - Capture detail contract
// Runs in the ISOLATED world. A capture detail sent by the page-world tap is
// checked here before it is stored. Reasons are short codes, never input values (D1).

(function() {
  'use strict';

  const MAX_ID_LENGTH = 200;
  const STAGE_ARRAYS = ['queries', 'retrieved', 'accessed', 'quoted', 'recommended'];

  const fail = (reason) => ({ ok: false, reason });
  const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
  const isCapturedOrHeuristic = (v) => isObject(v) && (v.provenance === 'captured' || v.provenance === 'heuristic');

  // @surface perplexity
  // Place cards (docs/SURFACE_SCHEMA.md section 3.2): `via`, when present, is
  // "place_card" and comes with a boolean `namedInAnswer`. A recommended entry
  // that is a card must be one the answer names.
  function placeCardOk(entry, mustBeNamed) {
    if (!('via' in entry) && !('namedInAnswer' in entry)) return true;
    if (entry.via !== 'place_card' || typeof entry.namedInAnswer !== 'boolean') return false;
    return !mustBeNamed || entry.namedInAnswer === true;
  }

  // Only Perplexity sends place cards; any other surface carrying the fields is refused.
  const hasCardKey = (e) => isObject(e) && ('via' in e || 'namedInAnswer' in e);
  function carriesPlaceCard(detail) {
    const entities = isObject(detail.entityData) && Array.isArray(detail.entityData.entities) ? detail.entityData.entities : [];
    const stages = Array.isArray(detail.stages) ? detail.stages : [];
    return entities.some(hasCardKey) || stages.some((s) => isObject(s) && Array.isArray(s.recommended) && s.recommended.some(hasCardKey));
  }
  // @end surface

  // Keys that only a non-ChatGPT parser sets on an entity or a recommended entry.
  const SURFACE_MARK_KEYS = ['via', 'namedInAnswer'];
  const hasMarkKey = (e) => isObject(e) && SURFACE_MARK_KEYS.some((k) => k in e);
  function carriesSurfaceMarks(detail) {
    const entities = isObject(detail.entityData) && Array.isArray(detail.entityData.entities) ? detail.entityData.entities : [];
    const stages = Array.isArray(detail.stages) ? detail.stages : [];
    return entities.some(hasMarkKey) || stages.some((s) => isObject(s) && Array.isArray(s.recommended) && s.recommended.some(hasMarkKey));
  }

  function validateStage(stage) {
    if (!isObject(stage)) return fail('bad_stage');
    for (const key of STAGE_ARRAYS) {
      if (!Array.isArray(stage[key])) return fail('bad_stage');
    }
    for (const q of stage.queries) {
      if (!isObject(q) || !(typeof q.text === 'string' || q.text === null)) return fail('bad_stage');
    }
    if (!stage.quoted.every(isCapturedOrHeuristic)) return fail('bad_provenance');
    if (!stage.recommended.every((r) => isObject(r) && r.provenance === 'captured')) return fail('bad_provenance');
    // @surface perplexity
    if (!stage.recommended.every((r) => placeCardOk(r, true))) return fail('bad_place_card');
    // @end surface
    return null;
  }

  function validateCaptureDetail(detail, surfaceId) {
    if (!isObject(detail)) return fail('not_object');
    if (typeof detail.conversationId !== 'string' || !detail.conversationId) return fail('no_conversation_id');

    // @surface perplexity
    if (surfaceId !== 'perplexity' && carriesPlaceCard(detail)) return fail('bad_place_card');
    // @end surface
    // A ChatGPT detail never carries the keys that only another surface's
    // parser sets. This stays in every build, so a product that ships ChatGPT
    // alone still refuses them (the check above is cut from that build).
    if (surfaceId === 'chatgpt' && carriesSurfaceMarks(detail)) return fail('bad_marks');
    if (surfaceId === 'chatgpt') {
      // Exactly what processCapture needs today; nothing stricter.
      return isObject(detail.searchData) ? { ok: true } : fail('no_search');
    }

    if (detail.conversationId.length > MAX_ID_LENGTH) return fail('id_too_long');
    if (!isObject(detail.searchData) || detail.searchData.hasSearch !== true) return fail('no_search');
    if (!Array.isArray(detail.stages) || detail.stages.length === 0) return fail('no_stages');
    for (const stage of detail.stages) {
      const bad = validateStage(stage);
      if (bad) return bad;
    }
    const entities = isObject(detail.entityData) ? detail.entityData.entities : undefined;
    if (entities !== undefined && (!Array.isArray(entities) || !entities.every(isCapturedOrHeuristic))) {
      return fail('bad_provenance');
    }
    // @surface perplexity
    if (entities !== undefined && !entities.every((e) => placeCardOk(e, false))) return fail('bad_place_card');
    // @end surface
    if (detail.answerMarkdown !== null && typeof detail.answerMarkdown !== 'string') {
      return fail('bad_answer');
    }
    if (detail.client !== null && detail.client !== 'logged-in' && detail.client !== 'anonymous') {
      return fail('bad_client');
    }
    return { ok: true };
  }

  const api = { validateCaptureDetail };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  } else {
    globalThis.CSICaptureContract = api;
  }

})();
