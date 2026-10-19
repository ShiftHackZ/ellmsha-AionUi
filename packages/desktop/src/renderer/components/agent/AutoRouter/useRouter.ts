import type { IProvider, TChatConversation } from '@/common/config/storage';
import {
  DEFAULT_ROUTER_CONFIG,
  routerTargetKey,
  type RouterConfig,
  type RouterTarget,
} from '@/common/types/agent/routerTypes';
import { useProvidersQuery } from '@/renderer/hooks/agent/useModelProviderList';
import { useManagedAgentRuntimeCatalog } from '@/renderer/hooks/agent/useManagedAgents';
import { buildAgentRuntimeModelInfo } from '@/renderer/utils/model/agentRuntimeCatalog';
import type { ManagedAgent } from '@/renderer/utils/model/agentTypes';
import { getClientBusinessSetting, setClientBusinessSetting } from '@/renderer/services/clientBusinessSettings';
import { getConversationOrNull } from '@/renderer/pages/conversation/utils/conversationCache';
import useSWR from 'swr';

export type RouterOption = { target: RouterTarget; key: string; label: string; loopback: boolean };
const loopback = (endpoint: string) => {
  try {
    return ['localhost', '127.0.0.1', '[::1]'].includes(new URL(endpoint).hostname);
  } catch {
    return false;
  }
};
/** Project only existing identities and labels; never copy account credentials. */
export function buildRouterOptions(providers: IProvider[], agents: ManagedAgent[]): RouterOption[] {
  const options: RouterOption[] = [];
  for (const provider of providers) {
    if (provider.enabled === false || provider.platform === 'gemini-with-google-auth') continue;
    for (const model of provider.models ?? []) {
      if (provider.model_enabled?.[model] === false || provider.model_health?.[model]?.status === 'unhealthy') continue;
      const target: RouterTarget = { kind: 'provider', provider_id: provider.id, model };
      options.push({
        target,
        key: routerTargetKey(target),
        label: `${provider.name} · ${model}`,
        loopback: loopback(provider.base_url),
      });
    }
  }
  for (const agent of agents) {
    if (
      agent.id === 'auto-router' ||
      !agent.enabled ||
      !agent.installed ||
      !['online', 'unchecked'].includes(agent.status) ||
      !['acp', 'antigravity'].includes(agent.agent_type)
    )
      continue;
    for (const model of buildAgentRuntimeModelInfo(agent)?.available_models ?? []) {
      const target: RouterTarget = { kind: 'agent', agent_id: agent.id, model: model.id };
      options.push({
        target,
        key: routerTargetKey(target),
        label: `${agent.name} · ${model.label || model.id}`,
        loopback: false,
      });
    }
  }
  return [...new Map(options.map((option) => [option.key, option])).values()];
}
export function useRouterOptions() {
  const providers = useProvidersQuery();
  const agents = useManagedAgentRuntimeCatalog();
  return {
    options: buildRouterOptions(providers.data ?? [], agents),
    loading: providers.isLoading,
    error: providers.error,
  };
}
export function useRouterConfig() {
  const query = useSWR(
    'router.config',
    async () => (await getClientBusinessSetting('router.config')) ?? DEFAULT_ROUTER_CONFIG,
    { revalidateOnFocus: false }
  );
  const save = async (config: RouterConfig) => {
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
/** UI validation supplements authoritative backend capability/ownership checks. */
export function routerConfigError(config: RouterConfig, options: RouterOption[], solo = false): string | undefined {
  const has = (target?: RouterTarget | null) =>
    Boolean(target && options.some((option) => option.key === routerTargetKey(target)));
  if (!options.length) return 'empty';
  if (config.mode !== 'auto' && !has(config.root_target)) return 'rootRequired';
  if (config.mode === 'manual' && !has(config.child_target)) return 'childRequired';
  if (config.classifier_target && (!has(config.classifier_target) || config.classifier_target.kind !== 'provider'))
    return 'classifierRequired';
  if (config.allowed_targets.some((target) => !has(target))) return 'unavailable';
  if (
    solo &&
    config.mode === 'manual' &&
    (config.root_target?.kind !== 'provider' || config.child_target?.kind !== 'provider')
  )
    return 'manualNative';
  if (config.local_only) {
    const isLocal = (target: RouterTarget) =>
      options.some((option) => option.key === routerTargetKey(target) && option.loopback) &&
      config.hints.some((hint) => routerTargetKey(hint.target) === routerTargetKey(target) && hint.local_inference);
    const selected = [
      config.mode !== 'auto' ? config.root_target : undefined,
      config.mode === 'manual' ? config.child_target : undefined,
      config.classifier_target,
    ].filter((target): target is RouterTarget => Boolean(target));
    const pool = config.allowed_targets.length ? config.allowed_targets : options.map((option) => option.target);
    if (selected.some((target) => !isLocal(target)) || !pool.some(isLocal)) return 'localRequired';
  }
  return undefined;
}
