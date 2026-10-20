export type UsageTotals = {
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_creation_tokens: number;
  requests: number;
};
export type UsageSeries = UsageTotals & {
  period: string;
  provider: string;
  provider_name?: string;
  model: string;
};
export type UsageContext = {
  provider?: string;
  provider_name?: string;
  model?: string;
  conversation_id: string;
  conversation_name: string;
  context_tokens: number;
  context_window: number;
  created_at: number;
  breakdown: Record<string, number>;
  request_metrics?: Record<string, number>;
};
export type UsageData = {
  start: number;
  end: number;
  totals: UsageTotals;
  series: UsageSeries[];
  contexts: UsageContext[];
};
export type UsageGroup = 'period' | 'provider' | 'model';

/** Group disjoint request counters; context snapshots never enter these sums. */
export function groupUsage(rows: UsageSeries[], group: UsageGroup) {
  const result = new Map<string, UsageTotals & { key: string; label: string }>();
  for (const row of rows) {
    const key = row[group];
    const entry = result.get(key) ?? {
      key,
      label: group === 'provider' ? row.provider_name || key : key,
      input_tokens: 0,
      output_tokens: 0,
      cache_read_tokens: 0,
      cache_creation_tokens: 0,
      requests: 0,
    };
    for (const field of [
      'input_tokens',
      'output_tokens',
      'cache_read_tokens',
      'cache_creation_tokens',
      'requests',
    ] as const)
      entry[field] += row[field];
    result.set(key, entry);
  }
  return [...result.values()].toSorted((a, b) =>
    group === 'period'
      ? b.key.localeCompare(a.key)
      : b.input_tokens + b.output_tokens - (a.input_tokens + a.output_tokens)
  );
}
