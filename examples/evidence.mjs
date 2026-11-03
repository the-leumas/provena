/**
 * Host-side example, not a new package API or an answerability evaluator.
 * Empty and nonempty searches both leave support for the task unassessed.
 * @param {import('@theleumas/provena').SemanticSearchEngine} engine
 * @param {import('@theleumas/provena').SearchRequest} request
 */
export async function retrieveUnassessedEvidence(engine, request) {
  request.signal?.throwIfAborted();
  const startedRevision = engine.revision;
  // Do not convert failure/cancellation into an apparently successful empty search.
  const candidates = await engine.search(request);
  request.signal?.throwIfAborted();
  return {
    retrieval: candidates.length ? 'retrieved' : 'no-results',
    answerability: 'not-assessed',
    candidates,
    // False is NOT a freshness guarantee: sources can change without an index refresh.
    indexChangedDuringSearch: engine.revision !== startedRevision,
  };
}
