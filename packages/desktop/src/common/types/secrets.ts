export type SecretScope = { project_id: string | null };
export type SecretField = { kind: 'text' | 'password' | 'secret' | 'note'; value: string };
export type SecretBinding = {
  service: string;
  environment: string;
  tenant: string;
  role: string;
  target: string;
  mfa: 'none' | 'required' | 'unknown';
  mfa_method: string;
  mfa_instructions: string;
};
export type SecretRecord = {
  title: string;
  kind: 'login' | 'api_key' | 'secure_note' | 'structured';
  fields: Record<string, SecretField>;
  bindings: SecretBinding[];
};
export type SecretMetadata = Omit<SecretRecord, 'fields'> & {
  id: string;
  revision: number;
  incarnation: string;
  scope: SecretScope;
};
export type SecretRead = SecretMetadata & Pick<SecretRecord, 'fields'> & { human_action_required: boolean };
export type VaultStatus = {
  incarnation: string | null;
  initialized: boolean;
  unlocked: boolean;
  vault_id: string | null;
};
export type SecretOperation =
  | 'device/status'
  | 'device/remember'
  | 'device/unlock'
  | 'device/forget'
  | 'status'
  | 'vault/initialize'
  | 'vault/unlock'
  | 'vault/lock'
  | 'vault/change-passphrase'
  | 'vault/backup'
  | 'vault/restore'
  | 'records/groups'
  | 'records/list'
  | 'records/read'
  | 'records/write'
  | 'records/delete';
export type SecretBridgeRequest = { operation: SecretOperation; body?: unknown };
export type SecretList = { records: SecretMetadata[]; cursor: string | null };
export type SecretReceipt = { id: string; revision: number; deleted: boolean };
export const SECRET_OPERATIONS: readonly SecretOperation[] = [
  'device/status',
  'device/remember',
  'device/unlock',
  'device/forget',
  'status',
  'vault/initialize',
  'vault/unlock',
  'vault/lock',
  'vault/change-passphrase',
  'vault/backup',
  'vault/restore',
  'records/groups',
  'records/list',
  'records/read',
  'records/write',
  'records/delete',
];

export type SecretGroup = { scope: SecretScope; name: string; retained: boolean };
