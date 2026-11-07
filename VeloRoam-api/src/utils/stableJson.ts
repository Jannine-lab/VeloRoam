/** Stable object key ordering lets database JSON round-trip without changing hashes. */
export function stableJson(value: unknown): string {
  const normalize = (item: unknown): unknown => {
    if (Array.isArray(item)) return item.map(normalize);
    if (item && typeof item === 'object') {
      return Object.fromEntries(Object.keys(item as Record<string, unknown>).sort()
        .map(key => [key, normalize((item as Record<string, unknown>)[key])]));
    }
    return item;
  };
  const result = JSON.stringify(normalize(value));
  if (result === undefined) throw new Error('Cannot hash undefined JSON value');
  return result;
}
