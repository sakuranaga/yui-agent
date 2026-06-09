/**
 * 並列数を制限した map (= 軽量な concurrency pool)。
 *
 * Promise.all で 100 件を一気に投げると外部 API / DB / LLM の rate limit を踏むので、
 * worker N 人で work-stealing する形にする。順序は items の入力順を維持。
 *
 * 使い方:
 *   const results = await mapPool(items, 3, async (it) => await classify(it));
 *
 * - fn が throw した場合: その slot の Promise が reject し、外側の Promise.all も reject。
 *   item ごとに失敗を握り潰したい場合は呼び出し側で try/catch して null 等に倒す。
 * - 個別 item の AbortController は持たない (= callsite で signal を fn に渡す設計)。
 */
export async function mapPool<T, R>(
  items: readonly T[],
  concurrency: number,
  fn: (item: T, index: number) => Promise<R>
): Promise<R[]> {
  const n = items.length;
  if (n === 0) return [];
  const pool = Math.max(1, Math.min(concurrency, n));
  const results: R[] = new Array(n);
  let next = 0;
  const workers = Array.from({ length: pool }, async () => {
    while (true) {
      const i = next++;
      if (i >= n) return;
      results[i] = await fn(items[i], i);
    }
  });
  await Promise.all(workers);
  return results;
}
