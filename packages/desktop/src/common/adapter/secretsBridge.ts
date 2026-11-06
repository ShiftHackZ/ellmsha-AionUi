import { secrets } from './ipcBridge';
import { httpRequest, isWebUiBrowserMode } from './httpBridge';
import type { SecretOperation } from '../types/secrets';

/** Desktop keeps its human capability in the main process; browser mode uses its authenticated TLS session. */
export async function secretsRequest<T>(operation: SecretOperation, body?: unknown): Promise<T> {
  if (isWebUiBrowserMode()) {
    if (operation === 'device/status') return { available: false, remembered: false } as T;
    if (operation.startsWith('device/')) throw new Error('DESKTOP_CONTEXT_REQUIRED');
    if (location.protocol !== 'https:' && !['localhost', '127.0.0.1', '[::1]'].includes(location.hostname)) {
      throw new Error('SECRETS_SECURE_TRANSPORT_REQUIRED');
    }
    return httpRequest<T>(operation === 'status' ? 'GET' : 'POST', `/api/secrets/${operation}`, body ?? {});
  }
  return (await secrets.request.invoke({ operation, body })) as T;
}
