/** Development evaluation only. No inferred truth labels or production answerability policy. */
export function evidenceMetrics(keys, judgment) {
  if (new Set(keys).size !== keys.length) throw new Error('Duplicate chunk in evidence ranking');
  const grades = judgment.grades;
  const relevant = Object.values(grades).filter(grade => grade > 0).length;
  const supported = judgment.answerability === 'supported';
  const result = { returned: keys.length, topGrade: keys.length ? grades[keys[0]] ?? 0 : null };
  for (const k of [5, 10]) {
    const top = keys.slice(0, k);
    const found = top.filter(key => grades[key] > 0).length;
    result[`relevancePrecisionAt${k}`] = found / k;
    result[`relevanceRecallAt${k}`] = relevant ? found / relevant : null;
    const gain = (grade, i) => (2 ** grade - 1) / Math.log2(i + 2);
    const dcg = top.reduce((sum, key, i) => sum + gain(grades[key] ?? 0, i), 0);
    const ideal = Object.values(grades).sort((a, b) => b - a).slice(0, k).reduce((sum, grade, i) => sum + gain(grade, i), 0);
    result[`relevanceNdcgAt${k}`] = ideal ? dcg / ideal : null;
    result[`sufficientSetHitAt${k}`] = supported ? Number(judgment.sufficientSets.some(set => set.every(key => top.includes(key)))) : null;
    result[`bestSetCoverageAt${k}`] = supported ? Math.max(...judgment.sufficientSets.map(set => set.filter(key => top.includes(key)).length / set.length)) : null;
  }
  const positions = judgment.sufficientSets.map(set => set.every(key => keys.includes(key)) ? Math.max(...set.map(key => keys.indexOf(key) + 1)) : Infinity);
  const firstComplete = Math.min(...positions);
  result.sufficientSetReciprocalRank = supported ? (Number.isFinite(firstComplete) ? 1 / firstComplete : 0) : null;
  return result;
}
export function evidenceAverage(rows) {
  const keys = Object.keys(rows[0] ?? {}).filter(key => /At\d+$|ReciprocalRank$/.test(key));
  return Object.fromEntries(keys.map(key => { const values = rows.map(row => row[key]).filter(value => value !== null); return [key, values.length ? values.reduce((a, b) => a + b, 0) / values.length : null]; }));
}
