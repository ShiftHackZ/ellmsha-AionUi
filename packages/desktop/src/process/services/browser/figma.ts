/** Private Figma PAT import. The token never traverses MCP or renderer IPC. */
import { session, type WebContents } from 'electron';
import type { FigmaConnection } from '@/common/adapter/ipcBridge';
import { browserProfileFromToken } from './profiles';

export const isFigmaOrigin = (value: string): boolean => {
  try {
    const url = new URL(value);
    return ['https://www.figma.com', 'https://figma.com'].includes(url.origin) && !url.username && !url.password;
  } catch {
    return false;
  }
};

export const figmaTokenExpression = (selector: string): string => `(() => {
  if (!['https://www.figma.com', 'https://figma.com'].includes(location.origin)) return null;
  const matches = document.querySelectorAll(${JSON.stringify(selector)});
  if (matches.length !== 1) return null;
  const element = matches[0];
  if (element instanceof HTMLInputElement && element.type === 'password') return null;
  const input = element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement;
  if (!input && element.children.length !== 0) return null;
  const value = (input ? element.value : element.textContent || '').trim();
  return value.length >= 20 && value.length <= 16384 && /^[\\x21-\\x7e]+$/.test(value) ? value : null;
})()`;

export const importFigmaAccountFromTab = async (
  contents: WebContents,
  selector: string,
  browserToken: string,
  assertAuthorized: () => Promise<void>,
  connectionId?: string
): Promise<FigmaConnection> => {
  if (typeof selector !== 'string' || !selector.trim() || selector.length > 1000)
    throw new Error('Choose one exact Figma token field with a CSS selector.');
  if (
    connectionId !== undefined &&
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(connectionId)
  )
    throw new Error('Invalid Figma connection ID.');
  await assertAuthorized();
  const originalUrl = contents.getURL();
  if (contents.isDestroyed() || !isFigmaOrigin(originalUrl))
    throw new Error('Token import requires the exact signed-in Figma tab at https://www.figma.com.');
  let personal_access_token: string;
  try {
    const response = (await contents.debugger.sendCommand('Runtime.evaluate', {
      expression: figmaTokenExpression(selector),
      returnByValue: true,
    })) as { result?: { value?: unknown }; exceptionDetails?: unknown };
    const value = response.result?.value;
    if (
      response.exceptionDetails ||
      typeof value !== 'string' ||
      value.length < 20 ||
      value.length > 16384 ||
      !/^[\x21-\x7e]+$/.test(value)
    )
      throw new Error('unavailable');
    personal_access_token = value;
  } catch {
    throw new Error(
      'Figma token field is unavailable or ambiguous. Generate a token and select its exact field; do not copy the token into chat.'
    );
  }
  await assertAuthorized();
  if (contents.isDestroyed() || contents.getURL() !== originalUrl)
    throw new Error('Figma tab changed during token import. Inspect the tab before retrying.');
  const expected_user_id = browserProfileFromToken(browserToken).claims.user_id;
  const port = (globalThis as typeof globalThis & { __backendPort?: number }).__backendPort;
  if (!Number.isInteger(port) || port! < 1 || port! > 65535) throw new Error('Figma account service unavailable.');
  const base = `http://127.0.0.1:${port}`;
  const cookies = await session.defaultSession.cookies.get({ url: base });
  const csrf = cookies.find((cookie) => cookie.name === 'aionui-csrf-token')?.value;
  if (!csrf) throw new Error('Application authorization unavailable. Sign in to eLLMsha again.');
  await assertAuthorized();
  const response = await session.defaultSession
    .fetch(
      `${base}/api/plugins/figma/connections${connectionId ? `/${encodeURIComponent(connectionId)}/connect` : ''}`,
      {
        method: 'POST',
        credentials: 'include',
        redirect: 'error',
        headers: { 'content-type': 'application/json', 'x-csrf-token': csrf },
        body: JSON.stringify({ personal_access_token, expected_user_id }),
        signal: AbortSignal.timeout(35_000),
      }
    )
    .catch(() => {
      throw new Error(
        'Figma import outcome is unknown. Refresh plugin accounts before retrying; do not create another token yet.'
      );
    });
  // Withhold backend/provider bodies from browser tool diagnostics.
  if (!response.ok)
    throw new Error(
      'Figma account was not imported. Check token scopes, account ownership and the existing connections in Settings → Plugins → Figma.'
    );
  const payload = (await response.json().catch(() => {
    throw new Error('Figma import response could not be verified. Refresh plugin accounts before retrying.');
  })) as { data?: FigmaConnection };
  const connection = payload.data;
  if (!connection?.id || connection.status !== 'connected' || !connection.identity?.account_id)
    throw new Error('Figma import could not be verified. Refresh plugin accounts before retrying.');
  // Only explicitly public metadata may leave this private path.
  const publicConnection: FigmaConnection = {
    id: connection.id,
    namespace: connection.namespace,
    label: connection.label,
    status: connection.status,
    identity: {
      account_id: connection.identity.account_id,
      account_name: connection.identity.account_name,
      account_email: connection.identity.account_email,
    },
    created_at: connection.created_at,
    updated_at: connection.updated_at,
  };
  if (JSON.stringify(publicConnection).includes(personal_access_token))
    throw new Error('Private Figma response withheld. Refresh plugin accounts to inspect the result.');
  return publicConnection;
};
