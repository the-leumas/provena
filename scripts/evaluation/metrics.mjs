/** Document-level evaluation: first occurrence wins; duplicate chunks are reported separately. */
export function uniqueDocuments(hits) { return [...new Set(hits.map(hit => typeof hit === 'string' ? hit : hit.documentId))]; }
export function metrics(hits, relevance) {
    const ids = uniqueDocuments(hits);
    const relevant = Object.values(relevance).filter(grade => grade > 0).length;
    const result = {};
    for (const k of [5, 10]) {
        const selected = ids.slice(0, k);
        const found = selected.filter(id => (relevance[id] ?? 0) > 0).length;
        result[`precisionAt${k}`] = found / k;
        result[`recallAt${k}`] = relevant ? found / relevant : null;
        const gain = (grade, index) => (2 ** grade - 1) / Math.log2(index + 2);
        const dcg = selected.reduce((sum, id, i) => sum + gain(relevance[id] ?? 0, i), 0);
        const ideal = Object.values(relevance).sort((a, b) => b - a).slice(0, k).reduce((sum, grade, i) => sum + gain(grade, i), 0);
        result[`ndcgAt${k}`] = ideal ? dcg / ideal : null;
    }
    const first = ids.findIndex(id => (relevance[id] ?? 0) > 0);
    result.mrr = relevant ? (first < 0 ? 0 : 1 / (first + 1)) : null;
    result.returnedDocuments = ids.length;
    return result;
}
export function average(rows) {
    return Object.fromEntries(['precisionAt5', 'precisionAt10', 'recallAt5', 'recallAt10', 'mrr', 'ndcgAt5', 'ndcgAt10'].map(key => {
        const values = rows.map(row => row[key]).filter(value => value !== null);
        return [key, values.length ? values.reduce((a, b) => a + b, 0) / values.length : null];
    }));
}
export function distribution(values) {
    const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
    const at = q => sorted.length ? sorted[Math.floor((sorted.length - 1) * q)] : null;
    return { count: sorted.length, min: at(0), p25: at(.25), median: at(.5), p75: at(.75), max: at(1) };
}
export function cosine(a, b) {
    let dot = 0, aa = 0, bb = 0;
    for (let i = 0; i < a.length; i++) {
        dot += a[i] * b[i];
        aa += a[i] * a[i];
        bb += b[i] * b[i];
    }
    return dot / Math.sqrt(aa * bb);
}
