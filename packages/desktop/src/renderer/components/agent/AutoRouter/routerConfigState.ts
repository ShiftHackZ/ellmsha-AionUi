import {
  DEFAULT_ROUTER_CONFIG,
  type RouterClass,
  type RouterConfig,
  type RouterMode,
  type RouterPreset,
  type RouterSettings,
} from '@/common/types/agent/routerTypes';

export const ROUTER_MODES: RouterMode[] = ['auto', 'semi_auto', 'manual'];
export const ROUTER_PRESETS: RouterPreset[] = ['cost', 'speed', 'quality', 'balanced', 'local_only'];
export const cloneRouterSettings = (value: RouterSettings): RouterSettings => structuredClone(value);
/** Only preferences migrate. Never call this on a conversation's frozen snapshot. */
export function normalizeRouterSettings(value?: RouterSettings | RouterConfig): RouterSettings {
  if (value && 'configurations' in value) {
    activeRouterConfig(value);
    return cloneRouterSettings(value);
  }
  const config: RouterConfig = structuredClone((value as RouterConfig | undefined) ?? DEFAULT_ROUTER_CONFIG);
  config.schema_version = 2;
  config.classes ??= [];
  const preset: RouterPreset = config.local_only ? 'local_only' : config.profile;
  return {
    schema_version: 2,
    active_mode: config.mode,
    active_presets: { auto: 'balanced', semi_auto: 'balanced', manual: 'balanced', [config.mode]: preset },
    configurations: { [config.mode]: { [preset]: config } },
  };
}
export function activeRouterConfig(settings: RouterSettings): RouterConfig {
  const config = settings.configurations[settings.active_mode]?.[settings.active_presets[settings.active_mode]];
  if (!config) throw new Error('Router active configuration is missing');
  return config;
}
/** Initialize a missing slot once; existing selections are restored without overlay. */
export function selectRouterSlot(
  settings: RouterSettings,
  mode: RouterMode,
  preset = settings.active_presets[mode]
): RouterSettings {
  const next = cloneRouterSettings(settings);
  if (!next.configurations[mode]?.[preset]) {
    const source = activeRouterConfig(settings);
    const config: RouterConfig = {
      ...structuredClone(source),
      schema_version: 2,
      mode,
      profile: preset === 'local_only' ? 'balanced' : preset,
      local_only: preset === 'local_only',
    };
    next.configurations[mode] = { ...next.configurations[mode], [preset]: config };
  }
  next.active_mode = mode;
  next.active_presets[mode] = preset;
  return next;
}
export function updateRouterSlot(settings: RouterSettings, config: RouterConfig): RouterSettings {
  const next = cloneRouterSettings(settings);
  const mode = next.active_mode;
  next.configurations[mode] = { ...next.configurations[mode], [next.active_presets[mode]]: structuredClone(config) };
  return next;
}
export function routerClassError(value: Partial<RouterClass>): string | undefined {
  const bytes = (text: string) => new TextEncoder().encode(text).length;
  if (!value.name?.trim() || bytes(value.name) > 80) return 'className';
  if (!value.description?.trim() || bytes(value.description) > 1024) return 'classDescription';
  if (!value.target) return 'classTarget';
  return undefined;
}
/** Save validates active readiness, while inactive partial slots remain recoverable drafts. */
export function routerReadinessError(config: RouterConfig): string | undefined {
  if (config.mode !== 'auto' && !config.root_target) return 'rootRequired';
  if (config.mode === 'manual' && !config.child_target) return 'childRequired';
  if (config.classes?.length && !config.classifier_target) return 'classifierRequired';
  if ((config.classes?.length ?? 0) > 32) return 'classLimit';
  for (const entry of config.classes ?? []) {
    const issue = routerClassError(entry);
    if (issue) return issue;
  }
  return undefined;
}
