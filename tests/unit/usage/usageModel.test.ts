import { describe, expect, it } from 'vitest';
import { groupUsage, type UsageSeries } from '@/renderer/components/Usage/usageModel';
const rows: UsageSeries[] = [
  {
    period: '2026-10-19',
    provider: 'p1',
    provider_name: 'Local',
    model: 'qwen',
    input_tokens: 100,
    output_tokens: 20,
    cache_read_tokens: 40,
    cache_creation_tokens: 0,
    requests: 1,
  },
  {
    period: '2026-10-18',
    provider: 'p1',
    provider_name: 'Local',
    model: 'other',
    input_tokens: 50,
    output_tokens: 10,
    cache_read_tokens: 0,
    cache_creation_tokens: 0,
    requests: 1,
  },
];
describe('usage aggregation', () => {
  it('keeps cached input as a subset and combines models by provider', () => {
    expect(groupUsage(rows, 'provider')).toEqual([
      {
        key: 'p1',
        label: 'Local',
        input_tokens: 150,
        output_tokens: 30,
        cache_read_tokens: 40,
        cache_creation_tokens: 0,
        requests: 2,
      },
    ]);
  });
  it('keeps model groups independent', () => {
    expect(groupUsage(rows, 'model').map((row) => row.input_tokens)).toEqual([100, 50]);
  });
  it('handles empty history without inventing measurements', () => {
    expect(groupUsage([], 'period')).toEqual([]);
  });
  it('sorts periods newest first', () => {
    expect(groupUsage(rows.toReversed(), 'period').map((row) => row.key)).toEqual(['2026-10-19', '2026-10-18']);
  });
});
