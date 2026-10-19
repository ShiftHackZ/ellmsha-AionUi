import type { IProvider, TChatConversation } from '@/common/config/storage';
import { httpRequest } from '@/common/adapter/httpBridge';
import {
  routerTargetKey,
  DEFAULT_ROUTER_CONFIG,
  type RouterCatalogEntry,
  type RouterConfig,
  type RouterHint,
  type RouterSettings,
} from '@/common/types/agent/routerTypes';
import { useProvidersQuery } from '@/renderer/hooks/agent/useModelProviderList';
import { getClientBusinessSetting, setClientBusinessSetting } from '@/renderer/services/clientBusinessSettings';
import { getConversationOrNull } from '@/renderer/pages/conversation/utils/conversationCache';
import { normalizeRouterSettings } from './routerConfigState';
import useSWR from 'swr';

export type RouterOption = RouterCatalogEntry & { key: string; loopback: boolean };
/** URL parsing canonicalizes IPv4/IPv6; mirrors Core's http(s) loopback check. */
export function isRouterLoopback(endpoint: string): boolean {
  try {
    const url = new URL(endpoint);
    if (!['http:', 'https:'].includes(url.protocol)) return false;
    return url.hostname === 'localhost' || url.hostname === '[::1]' || /^127(?:\.\d{1,3}){3}$/.test(url.hostname);
  } catch {
    return false;
  }
}
/** Role eligibility comes only from Core. Existing provider metadata enables explicit local declaration. */
export function buildRouterOptions(entries: RouterCatalogEntry[], providers: IProvider[]): RouterOption[] {
  return entries.map((entry) => {
    const provider =
      entry.target.kind === 'provider'
        ? providers.find((p) => p.id === (entry.target.kind === 'provider' ? entry.target.provider_id : ''))
        : undefined;
    return {
      ...entry,
      key: routerTargetKey(entry.target),
      loopback: Boolean(
        provider &&
        isRouterLoopback(provider.base_url) &&
        !['bedrock', 'gemini-vertex-ai'].includes(provider.platform) &&
        entry.classifier.reason !== 'provider_transport_unsupported'
      ),
    };
  });
}
/** Catalog eligibility depends on references, local declarations and tool support, not task prose or ranking metrics. */
function catalogPolicy(config?: RouterConfig): RouterConfig | undefined {
  if (!config) return undefined;
  return {
    ...DEFAULT_ROUTER_CONFIG,
    local_only: config.local_only,
    root_target: config.root_target,
    child_target: config.child_target,
    classifier_target: config.classifier_target,
    allowed_targets: config.allowed_targets,
    classes: config.classes?.map((entry, index) => ({
      id: `catalog-${index}`,
      name: '',
      description: '',
      target: entry.target,
    })),
    hints: config.hints.map(
      (hint): RouterHint => ({
        target: hint.target,
        strengths: [],
        local_inference: hint.local_inference,
        supports_tools: hint.supports_tools,
      })
    ),
  };
}
export function useRouterOptions(config?: RouterConfig, enabled = true) {
  const providers = useProvidersQuery();
  const policy = catalogPolicy(config);
  const query = useSWR(
    enabled ? ['router.catalog', policy ?? null] : null,
    () => httpRequest<{ entries: RouterCatalogEntry[] }>('POST', '/api/agents/router/catalog', { config: policy }),
    { revalidateOnFocus: false, keepPreviousData: true }
  );
  return {
    options: buildRouterOptions(query.data?.entries ?? [], providers.data ?? []),
    loading: query.isLoading,
    error: query.error || providers.error,
  };
}
export function useRouterConfig() {
  const query = useSWR(
    'router.config',
    async () => normalizeRouterSettings(await getClientBusinessSetting('router.config')),
    { revalidateOnFocus: false }
  );
  const save = async (config: RouterSettings) => {
    await setClientBusinessSetting('router.config', config);
    await query.mutate(config, { revalidate: false });
  };
  return { ...query, save };
}
export function useRouterConversation(id?: string) {
  return useSWR<TChatConversation | null>(id ? `conversation/${id}` : null, () => getConversationOrNull(id!), {
    revalidateOnFocus: false,
  });
}
