export async function runSingleFlight<K, V>(
  inFlight: Map<K, Promise<V>>,
  key: K,
  operation: () => Promise<V>
): Promise<V> {
  const existing = inFlight.get(key);
  if (existing) return await existing;

  const current = Promise.resolve().then(operation);
  inFlight.set(key, current);
  try {
    return await current;
  } finally {
    if (inFlight.get(key) === current) inFlight.delete(key);
  }
}
