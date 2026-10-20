import React, { useMemo, useState } from 'react';
import { Alert, Button, DatePicker, Empty, Select, Spin, Table, Tooltip } from '@arco-design/web-react';
import { Refresh } from '@icon-park/react';
import { useTranslation } from 'react-i18next';
import useSWR from 'swr';
import { httpRequest } from '@/common/adapter/httpBridge';
import { groupUsage, type UsageData, type UsageGroup } from './usageModel';
import styles from './Usage.module.css';
import SettingsPageHeader from '@/renderer/pages/settings/components/SettingsPageHeader';

const palette = [
  'var(--primary)',
  'var(--success)',
  'var(--warning)',
  'var(--purple)',
  'var(--muted)',
  'var(--subtle)',
];
type Slice = { label: string; value: number };
function Donut({ slices, label, format }: { slices: Slice[]; label: string; format: (n: number) => string }) {
  const total = slices.reduce((sum, slice) => sum + slice.value, 0);
  let offset = 0;
  return (
    <div className={styles.chart}>
      <svg viewBox='0 0 180 180' role='img' aria-label={`${label}: ${format(total)}`}>
        <circle cx='90' cy='90' r='68' fill='none' stroke='var(--color-fill-3)' strokeWidth='16' />
        {slices.map((slice, index) => {
          const length = total ? (slice.value / total) * 100 : 0;
          const start = offset;
          offset += length;
          return (
            <circle
              key={slice.label}
              cx='90'
              cy='90'
              r='68'
              fill='none'
              stroke={palette[index % palette.length]}
              strokeWidth='16'
              pathLength='100'
              strokeDasharray={`${length} ${100 - length}`}
              strokeDashoffset={-start}
              transform='rotate(-90 90 90)'
            >
              <title>
                {slice.label}: {format(slice.value)}
              </title>
            </circle>
          );
        })}
        <text x='90' y='89' textAnchor='middle' className={styles.chartTotal}>
          {format(total)}
        </text>
        <text x='90' y='111' textAnchor='middle' className={styles.chartLabel}>
          {label}
        </text>
      </svg>
      <div className={styles.legend}>
        {slices.map((slice, index) => (
          <div key={slice.label}>
            <span className={styles.dot} style={{ background: palette[index % palette.length] }} />
            <span>{slice.label}</span>
            <strong>{format(slice.value)}</strong>
          </div>
        ))}
      </div>
    </div>
  );
}

/** Shared chat and account usage view. Data comes from durable backend request telemetry. */
export default function Usage({ conversationId }: { conversationId?: string }) {
  const { t, i18n } = useTranslation();
  const [days, setDays] = useState(30);
  const [range, setRange] = useState<string[]>([]);
  const [provider, setProvider] = useState<string>();
  const [model, setModel] = useState<string>();
  const [contextId, setContextId] = useState<string>();
  const [group, setGroup] = useState<UsageGroup>('period');
  const clock = Date.now();
  const end =
    days === 0 && range[1]
      ? new Date(new Date(`${range[1]}T00:00:00`).setDate(new Date(`${range[1]}T00:00:00`).getDate() + 1)).getTime()
      : clock;
  const start = days === 0 && range[0] ? new Date(`${range[0]}T00:00:00`).getTime() : end - (days || 30) * 86400000;
  const query = conversationId
    ? new URLSearchParams()
    : days === 0 && range.length === 2
      ? new URLSearchParams({ start: String(start), end: String(end) })
      : new URLSearchParams({ days: String(days || 30) });
  if (conversationId) query.set('conversation_id', conversationId);
  const { data, error, isLoading, isValidating, mutate } = useSWR(
    `/api/usage?${query}`,
    (url: string) => httpRequest<UsageData>('GET', url),
    { refreshInterval: 15000, revalidateOnFocus: true }
  );
  const format = (value: number) => new Intl.NumberFormat(i18n.language).format(value);
  const series = useMemo(
    () =>
      (data?.series ?? []).filter(
        (row) => !!conversationId || ((!provider || row.provider === provider) && (!model || row.model === model))
      ),
    [data, provider, model, conversationId]
  );
  const totals = useMemo(
    () =>
      series.reduce(
        (sum, row) => ({
          input: sum.input + row.input_tokens,
          output: sum.output + row.output_tokens,
          cache: sum.cache + row.cache_read_tokens,
          requests: sum.requests + row.requests,
        }),
        { input: 0, output: 0, cache: 0, requests: 0 }
      ),
    [series]
  );
  const rows = useMemo(() => groupUsage(series, group), [series, group]);
  const filteredQuery = new URLSearchParams(query);
  if (!conversationId && provider) filteredQuery.set('provider', provider);
  if (!conversationId && model) filteredQuery.set('model', model);
  const { data: filteredData, mutate: refreshFiltered } = useSWR(
    `/api/usage?${filteredQuery}`,
    (url: string) => httpRequest<UsageData>('GET', url),
    { refreshInterval: 15000 }
  );
  const latest = conversationId
    ? filteredData?.contexts.find((context) => context.conversation_id === conversationId)
    : (filteredData?.contexts.find((context) => context.conversation_id === contextId) ?? filteredData?.contexts[0]);
  const contextKeys = ['system', 'memory', 'skills', 'tools', 'messages', 'unattributed'] as const;
  const title = t('settings.usage.title');
  return (
    <section className={conversationId ? `${styles.page} ${styles.chat}` : styles.page}>
      <SettingsPageHeader
        sticky={false}
        title={title}
        description={conversationId ? t('settings.usage.chatAllTime') : t('settings.usage.description')}
        actions={
          <Tooltip content={t('settings.usage.refresh')}>
            <Button
              aria-label={t('settings.usage.refresh')}
              icon={<Refresh />}
              loading={isValidating}
              onClick={() => {
                void Promise.all([mutate(), ...(provider || model ? [refreshFiltered()] : [])]).catch(
                  (): undefined => undefined
                );
              }}
            />
          </Tooltip>
        }
      />
      {!conversationId && (
        <div className={styles.filters}>
          <Select
            aria-label={t('settings.usage.period')}
            value={days}
            onChange={setDays}
            style={{ width: 170 }}
            options={[1, 7, 30, 90, 365]
              .map((value) => ({ value, label: t('settings.usage.days', { count: value }) }))
              .concat([{ value: 0, label: t('settings.usage.custom') }])}
          />
          {days === 0 && <DatePicker.RangePicker value={range} onChange={setRange} style={{ width: 260 }} />}
          <Select
            allowClear
            placeholder={t('settings.usage.providers')}
            aria-label={t('settings.usage.providers')}
            value={provider}
            onChange={(value) => {
              setProvider(value);
              setModel(undefined);
            }}
            style={{ width: 190 }}
            options={[
              ...new Map(
                [...(data?.series ?? []), ...(data?.contexts ?? []).filter((row) => row.provider)].map((row) => [
                  row.provider,
                  { value: row.provider, label: row.provider_name || row.provider },
                ])
              ).values(),
            ]}
          />
          <Select
            allowClear
            showSearch
            placeholder={t('settings.usage.models')}
            aria-label={t('settings.usage.models')}
            value={model}
            onChange={setModel}
            style={{ width: 210 }}
            options={[
              ...new Set(
                [...(data?.series ?? []), ...(data?.contexts ?? [])]
                  .filter((row) => row.model && (!provider || row.provider === provider))
                  .map((row) => row.model!)
              ),
            ].map((value) => ({ value, label: value }))}
          />
        </div>
      )}
      <Alert type='info' content={conversationId ? t('settings.usage.chatCoverage') : t('settings.usage.coverage')} />
      {error ? (
        <Alert
          type='error'
          content={t('settings.usage.error')}
          action={
            <Button onClick={() => void mutate().catch((): undefined => undefined)}>
              {t('settings.usage.refresh')}
            </Button>
          }
        />
      ) : isLoading ? (
        <div className={styles.loading}>
          <Spin />
        </div>
      ) : (
        <>
          <div className={styles.metrics}>
            {[
              { label: t('settings.usage.input'), value: totals.input },
              { label: t('settings.usage.output'), value: totals.output },
              { label: t('settings.usage.cached'), value: totals.cache },
              { label: t('settings.usage.requests'), value: totals.requests },
              ...(conversationId
                ? [
                    {
                      label: t('settings.usage.latestContext'),
                      value: latest?.context_tokens,
                      measured: !!latest,
                    },
                    {
                      label: t('settings.usage.toolDefinitions'),
                      value: latest?.request_metrics?.tool_count,
                      measured: latest?.request_metrics?.tool_count !== undefined,
                    },
                  ]
                : []),
            ].map((metric) => (
              <Tooltip
                key={metric.label}
                disabled={
                  metric.label !== t('settings.usage.latestContext') ||
                  !latest?.request_metrics ||
                  Object.keys(latest.request_metrics).length === 0
                }
                content={
                  <div>
                    {t('settings.usage.requestSizes')}
                    {latest?.request_metrics &&
                      Object.entries(latest.request_metrics).map(([key, value]) => (
                        <div key={key}>
                          {t(`settings.usage.measurements.${key}`, { defaultValue: key })}: {format(value)}
                        </div>
                      ))}
                  </div>
                }
              >
                <div className={styles.metric}>
                  <span>{metric.label}</span>
                  <strong>
                    {('measured' in metric ? metric.measured : series.length > 0) && metric.value !== undefined
                      ? format(metric.value)
                      : '—'}
                  </strong>
                </div>
              </Tooltip>
            ))}
          </div>
          {series.length === 0 && !latest ? (
            <Empty description={t('settings.usage.empty')} />
          ) : (
            <div className={styles.charts}>
              {series.length > 0 && (
                <article className={styles.card}>
                  <h3>{t('settings.usage.flow')}</h3>
                  <Donut
                    label={t('settings.usage.tokens')}
                    slices={[
                      { label: t('settings.usage.input'), value: totals.input },
                      { label: t('settings.usage.output'), value: totals.output },
                    ]}
                    format={format}
                  />
                  <p>{t('settings.usage.cacheHint')}</p>
                </article>
              )}
              {(!conversationId || series.length === 0) && (
                <article className={styles.card}>
                  <h3>{t('settings.usage.context')}</h3>
                  {!conversationId && (filteredData?.contexts.length ?? 0) > 1 && (
                    <Select
                      aria-label={t('settings.usage.chat')}
                      value={latest?.conversation_id}
                      onChange={setContextId}
                      options={filteredData?.contexts.map((context) => ({
                        value: context.conversation_id,
                        label: context.conversation_name,
                      }))}
                    />
                  )}

                  {latest ? (
                    <>
                      <Donut
                        label={t('settings.usage.tokens')}
                        slices={contextKeys.map((key) => ({
                          label: t(`settings.usage.${key}`),
                          value: latest.breakdown[key] ?? 0,
                        }))}
                        format={format}
                      />
                      <p>
                        {t('settings.usage.contextHint')} · {format(latest.context_tokens)} /{' '}
                        {latest.context_window ? format(latest.context_window) : '—'} ·{' '}
                        {new Date(latest.created_at).toLocaleString(i18n.language)}
                      </p>
                    </>
                  ) : (
                    <Empty description={t('settings.usage.contextUnavailable')} />
                  )}
                </article>
              )}
            </div>
          )}
          {!conversationId && (
            <>
              <div className={styles.tableHeader}>
                <h3>{t('settings.usage.breakdown')}</h3>
                <Select
                  value={group}
                  aria-label={t('settings.usage.group')}
                  onChange={setGroup}
                  style={{ width: 160 }}
                  options={(['period', 'provider', 'model'] as const).map((value) => ({
                    value,
                    label: t(`settings.usage.${value}`),
                  }))}
                />
              </div>
              <Table
                pagination={{ pageSize: 12, hideOnSinglePage: true }}
                scroll={{ x: 600 }}
                data={rows}
                rowKey='key'
                columns={[
                  { title: t(`settings.usage.${group}`), dataIndex: 'label' },
                  ...(['requests', 'input_tokens', 'output_tokens', 'cache_read_tokens'] as const).map((field) => ({
                    title: t(
                      `settings.usage.${({ requests: 'requests', input_tokens: 'input', output_tokens: 'output', cache_read_tokens: 'cached' } as const)[field]}`
                    ),
                    dataIndex: field,
                    render: (value: number) => format(value),
                    align: 'right' as const,
                  })),
                ]}
              />
            </>
          )}
        </>
      )}
    </section>
  );
}
