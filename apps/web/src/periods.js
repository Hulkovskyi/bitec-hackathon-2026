export function halfYears(start, end) {
  const periods = [];
  for (let year = Number(start.slice(0, 4)); year <= Number(end.slice(0, 4)); year++) {
    for (const [half, first, last] of [
      [1, `${year}-01-01`, `${year}-06-30`],
      [2, `${year}-07-01`, `${year}-12-31`],
    ]) {
      if (first <= end && last >= start) {
        periods.push({
          key: `${year}-H${half}`,
          label: `${year} · ${half === 1 ? "І" : "ІІ"} півріччя`,
          start: first > start ? first : start,
          end: last < end ? last : end,
        });
      }
    }
  }
  return periods;
}
