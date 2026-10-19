/** Credential-free mirror of aionui-api-types/src/routing.rs. */
export type RouterTarget =
  | { kind: 'provider'; provider_id: string; model: string }
  | { kind: 'agent'; agent_id: string; model: string };
export type RouterMode = 'auto' | 'semi_auto' | 'manual';
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
export type RouterConfig = {
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
