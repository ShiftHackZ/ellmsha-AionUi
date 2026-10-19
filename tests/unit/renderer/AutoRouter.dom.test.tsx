import { describe, expect, it, vi } from 'vitest';
import { buildRouterOptions, routerConfigError } from '@/renderer/components/agent/AutoRouter/useRouter';
import {
  DEFAULT_ROUTER_CONFIG,
  routerTargetKey,
  type RouterConfig,
  type RouterTarget,
} from '@/common/types/agent/routerTypes';
import type { IProvider } from '@/common/config/storage';
import type { ManagedAgent } from '@/renderer/utils/model/agentTypes';

vi.mock('@/renderer/hooks/agent/useModelProviderList', () => ({ useProvidersQuery: vi.fn() }));
vi.mock('@/renderer/hooks/agent/useManagedAgents', () => ({ useManagedAgentRuntimeCatalog: vi.fn() }));
vi.mock('@/renderer/services/clientBusinessSettings', () => ({
  getClientBusinessSetting: vi.fn(),
  setClientBusinessSetting: vi.fn(),
}));
vi.mock('@/renderer/pages/conversation/utils/conversationCache', () => ({ getConversationOrNull: vi.fn() }));
const provider = (id: string, patch: Partial<IProvider> = {}): IProvider => ({
  id,
  name: id,
  platform: 'custom',
  base_url: 'http://127.0.0.1:9000/v1',
  api_key: 'do-not-copy',
  models: ['small', 'large'],
  ...patch,
});
const root: RouterTarget = { kind: 'provider', provider_id: 'local', model: 'small' };
const child: RouterTarget = { kind: 'provider', provider_id: 'local', model: 'large' };

describe('Auto Router target selection contract', () => {
  it('uses enabled usable identities without credential copies or unhealthy models', () => {
    const options = buildRouterOptions(
      [
        provider('disabled', { enabled: false }),
        provider('local', { model_enabled: { large: false } }),
        provider('cloud', { model_health: { small: { status: 'unhealthy' } } as IProvider['model_health'] }),
      ],
      []
    );
    expect(options.map((option) => option.target)).toEqual([
      root,
      { kind: 'provider', provider_id: 'cloud', model: 'large' },
    ]);
    expect(JSON.stringify(options)).not.toContain('do-not-copy');
    expect(options[0].loopback).toBe(true);
  });
  it('reads wrapped advertised models and excludes unavailable or unsupported runtimes', () => {
    const agent = {
      id: 'cli',
      name: 'CLI',
      agent_type: 'acp',
      enabled: true,
      installed: true,
      status: 'online',
      config_options: {
        config_options: [
          { id: 'model', category: 'model', type: 'select', options: [{ value: 'specific-id', label: 'Specific' }] },
        ],
      },
    } as ManagedAgent;
    const options = buildRouterOptions(
      [],
      [
        agent,
        { ...agent, id: 'offline', status: 'offline' },
        { ...agent, id: 'remote', agent_type: 'remote' },
        { ...agent, id: 'uninstalled', installed: false },
      ]
    );
    expect(options.map((option) => option.target)).toEqual([{ kind: 'agent', agent_id: 'cli', model: 'specific-id' }]);
  });
  it('requires fixed references in semi-auto and manual, rejects disabled references and unsupported solo children', () => {
    const options = buildRouterOptions([provider('local')], []);
    expect(routerConfigError({ ...DEFAULT_ROUTER_CONFIG, mode: 'semi_auto' }, options)).toBe('rootRequired');
    expect(routerConfigError({ ...DEFAULT_ROUTER_CONFIG, mode: 'manual', root_target: root }, options)).toBe(
      'childRequired'
    );
    expect(
      routerConfigError({ ...DEFAULT_ROUTER_CONFIG, allowed_targets: [{ ...root, provider_id: 'missing' }] }, options)
    ).toBe('unavailable');
    const agent: RouterTarget = { kind: 'agent', agent_id: 'cli', model: 'm' };
    const expanded = [...options, { target: agent, key: routerTargetKey(agent), label: 'CLI', loopback: false }];
    const manual: RouterConfig = { ...DEFAULT_ROUTER_CONFIG, mode: 'manual', root_target: root, child_target: agent };
    expect(routerConfigError(manual, expanded, true)).toBe('manualNative');
    expect(routerConfigError(manual, expanded, false)).toBeUndefined();
  });
  it('requires declared local inference and refuses a cloud classifier even with a local work pool', () => {
    const cloud: RouterTarget = { kind: 'provider', provider_id: 'cloud', model: 'small' };
    const options = buildRouterOptions(
      [provider('local'), provider('cloud', { base_url: 'https://cloud.example/v1' })],
      []
    );
    const config: RouterConfig = { ...DEFAULT_ROUTER_CONFIG, local_only: true, allowed_targets: [root] };
    expect(routerConfigError(config, options)).toBe('localRequired');
    config.hints = [{ target: root, strengths: [], local_inference: true }];
    expect(routerConfigError(config, options)).toBeUndefined();
    expect(routerConfigError({ ...config, classifier_target: cloud }, options)).toBe('localRequired');
    expect(routerConfigError({ ...config, mode: 'manual', root_target: root, child_target: child }, options)).toBe(
      'localRequired'
    );
  });
  it('does not collide model identity across account and runtime boundaries', () => {
    expect(routerTargetKey({ kind: 'provider', provider_id: 'a::b', model: 'c' })).not.toBe(
      routerTargetKey({ kind: 'provider', provider_id: 'a', model: 'b::c' })
    );
    expect(routerTargetKey(root)).not.toBe(routerTargetKey({ kind: 'agent', agent_id: 'local', model: 'small' }));
  });
});
