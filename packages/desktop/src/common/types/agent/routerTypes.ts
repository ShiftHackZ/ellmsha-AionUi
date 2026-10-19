/** Credential-free mirror of aionui-api-types/src/routing.rs. */
export type RouterTarget =
  | { kind: 'provider'; provider_id: string; model: string }
  | { kind: 'agent'; agent_id: string; model: string };
export type RouterMode = 'auto' | 'semi_auto' | 'manual';
export type RouterPreset = RouterProfile | 'local_only';
export type RouterProfile = 'cost' | 'speed' | 'quality' | 'balanced';
export type RouterTaskKind = 'coding' | 'review' | 'research' | 'writing' | 'analysis' | 'general';
export type RouterHint = {
  target: RouterTarget;
  input_usd_per_million?: number | null;
  output_usd_per_million?: number | null;
  expected_latency_ms?: number | null;
  quality_tier?: number | null;
  strengths: RouterTaskKind[];
  context_tokens?: number | null;
  supports_tools?: boolean | null;
  supports_vision?: boolean | null;
  local_inference: boolean;
};
export type RouterClass = { id: string; name: string; description: string; target: RouterTarget };
export type RouterConfig = {
  /** Missing denotes an immutable legacy V1 snapshot. */
  schema_version?: 1 | 2;
  classes?: RouterClass[];
  mode: RouterMode;
  profile: RouterProfile;
  local_only: boolean;
  root_target?: RouterTarget | null;
  child_target?: RouterTarget | null;
  classifier_target?: RouterTarget | null;
  /** Empty explicitly means all eligible configured targets. */
  allowed_targets: RouterTarget[];
  hints: RouterHint[];
};
export type RouterSettings = {
  schema_version: 2;
  active_mode: RouterMode;
  active_presets: Record<RouterMode, RouterPreset>;
  configurations: Partial<Record<RouterMode, Partial<Record<RouterPreset, RouterConfig>>>>;
};
export type RouterEligibility = { supported: boolean; reason?: string };
export type RouterCatalogEntry = {
  target: RouterTarget;
  label: string;
  backend: string;
  local: boolean;
  root: RouterEligibility;
  child: RouterEligibility;
  classifier: RouterEligibility;
};
export type RouterChildMetadata = {
  version: 1;
  root_conversation_id: string;
  parent_conversation_id: string;
  parent_turn_id: string;
  task_id: string;
};
/** Only the host-owned, versioned lineage identifies an approval-capable child. */
export function getRouterChildMetadata(extra: unknown): RouterChildMetadata | undefined {
  if (!extra || typeof extra !== 'object' || !('router_child' in extra)) return undefined;
  const marker = extra.router_child;
  if (!marker || typeof marker !== 'object' || !('version' in marker) || marker.version !== 1) return undefined;
  const fields = ['root_conversation_id', 'parent_conversation_id', 'parent_turn_id', 'task_id'] as const;
  const record = marker as Record<string, unknown>;
  if (!fields.every((field) => typeof record[field] === 'string' && (record[field] as string).trim())) return undefined;
  return marker as RouterChildMetadata;
}
export type RouterSnapshot = {
  config: RouterConfig;
  decision: {
    id: string;
    target: RouterTarget;
    requirements: { task: RouterTaskKind; complex: boolean; vision: boolean; minimum_context_tokens: number };
    reasons: string[];
    evidence_count: number;
    elapsed_ms: number;
    managed_children: boolean;
    scope_workspace: string;
  };
};
export type RouterCreateRequest = { initial_prompt: string; config?: RouterConfig; has_images: boolean };
export const DEFAULT_ROUTER_CONFIG: RouterConfig = {
  schema_version: 2,
  classes: [],
  mode: 'auto',
  profile: 'balanced',
  local_only: false,
  allowed_targets: [],
  hints: [],
};
/** A collision-safe account/runtime plus model identity. */
export const routerTargetKey = (target: RouterTarget): string =>
  JSON.stringify([target.kind, target.kind === 'provider' ? target.provider_id : target.agent_id, target.model]);
export function getRoutingSnapshot(extra: unknown): RouterSnapshot | undefined {
  if (!extra || typeof extra !== 'object' || !('routing' in extra)) return undefined;
  const value = extra.routing as RouterSnapshot | undefined;
  return value?.decision?.target && value?.config ? value : undefined;
}
