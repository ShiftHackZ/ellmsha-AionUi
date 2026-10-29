import { createHash } from 'node:crypto';
import { isIP } from 'node:net';
import { parse } from 'tldts';
import type { SecurityKeyRequest } from '@/common/types/browserWebAuthn';

export class WebAuthnError extends Error {
  constructor(readonly code: 'AbortError' | 'NotAllowedError' | 'NotSupportedError' | 'SecurityError' | 'TypeError') {
    super(code);
  }
}
const deny = (code: WebAuthnError['code'] = 'TypeError'): never => {
  throw new WebAuthnError(code);
};
export const decode = (value: unknown, max = 1024): Buffer => {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]+$/.test(value) || value.length > Math.ceil((max * 4) / 3))
    return deny();
  const bytes = Buffer.from(value, 'base64url');
  if (!bytes.length || bytes.length > max || bytes.toString('base64url') !== value) return deny();
  return bytes;
};
export function validateRequest(input: unknown, origin: string) {
  if (!input || typeof input !== 'object' || Buffer.byteLength(JSON.stringify(input)) > 100_000) return deny();
  const request = input as SecurityKeyRequest;
  if (!/^[a-f0-9-]{36}$/.test(request.requestId) || !request.publicKey || typeof request.publicKey !== 'object')
    return deny();
  if (request.mediation !== undefined && request.mediation !== 'optional' && request.mediation !== 'required')
    return deny('NotSupportedError');
  const url = new URL(origin);
  if (url.protocol !== 'https:' || isIP(url.hostname) || !parse(url.hostname, { allowPrivateDomains: true }).domain)
    return deny('SecurityError');
  const p = request.publicKey;
  if (p.authenticatorAttachment === 'platform') return deny('NotSupportedError');
  if (p.authenticatorAttachment !== undefined && p.authenticatorAttachment !== 'cross-platform') return deny();
  const rpId = p.rpId ?? url.hostname;
  if (
    typeof rpId !== 'string' ||
    rpId.length > 253 ||
    rpId !== rpId.toLowerCase() ||
    !parse(rpId, { allowPrivateDomains: true }).domain ||
    !(url.hostname === rpId || url.hostname.endsWith(`.${rpId}`))
  )
    return deny('SecurityError');
  const challenge = decode(p.challenge, 1024);
  const uv = p.userVerification ?? 'preferred';
  if (!['required', 'preferred', 'discouraged'].includes(uv)) return deny();
  if (p.timeout !== undefined && (!Number.isFinite(p.timeout) || p.timeout < 0)) return deny();
  const timeout = Math.min(120_000, Math.max(1000, p.timeout ?? 60_000));
  if (p.allowCredentials !== undefined && (!Array.isArray(p.allowCredentials) || p.allowCredentials.length > 64))
    return deny();
  const allowCredentials = (p.allowCredentials ?? []).map((c) => {
    if (
      !c ||
      c.type !== 'public-key' ||
      (c.transports !== undefined && (!Array.isArray(c.transports) || c.transports.some((t) => typeof t !== 'string')))
    )
      return deny();
    return { id: decode(c.id).toString('base64url'), transports: c.transports };
  }); // Transports are discovery hints; a key registered over NFC may now use USB.
  if (p.extensions !== undefined && (!p.extensions || typeof p.extensions !== 'object' || Array.isArray(p.extensions)))
    return deny();
  if (Object.keys(p.extensions ?? {}).some((k) => k !== 'appid')) return deny('NotSupportedError');
  const appid = p.extensions?.appid;
  if (appid !== undefined && (typeof appid !== 'string' || appid.length > 2048 || !allowCredentials.length))
    return deny('NotSupportedError');
  const clientData = Buffer.from(
    JSON.stringify({
      type: 'webauthn.get',
      challenge: challenge.toString('base64url'),
      origin: url.origin,
      crossOrigin: false,
    })
  );
  return {
    requestId: request.requestId,
    origin: url.origin,
    rpId,
    uv,
    timeout,
    allowCredentials: allowCredentials.map((c) => c.id),
    appid: appid as string | undefined,
    clientDataJSON: clientData.toString('base64url'),
    hash: createHash('sha256').update(clientData).digest('base64url'),
  };
}
export type ValidatedRequest = ReturnType<typeof validateRequest>;

/** Chromium authorizes HTTPS AppIDs within the caller's registrable domain, without facet retrieval. */
export async function authorizeAppId(appid: string, origin: string, signal?: AbortSignal): Promise<string> {
  if (signal?.aborted) throw signal.reason;
  const identifier = appid || origin;
  let app: URL;
  let site: URL;
  try {
    app = new URL(identifier);
    site = new URL(origin);
  } catch {
    return deny('SecurityError');
  }
  if (
    app.protocol !== 'https:' ||
    app.username ||
    app.password ||
    app.href.includes('#') ||
    (app.port && app.port !== '443') ||
    isIP(app.hostname) ||
    site.protocol !== 'https:' ||
    site.origin !== origin ||
    isIP(site.hostname)
  )
    return deny('SecurityError');
  const appDomain = parse(app.hostname, { allowPrivateDomains: true }).domain;
  const siteDomain = parse(site.hostname, { allowPrivateDomains: true }).domain;
  if (!appDomain || !siteDomain) return deny('SecurityError');
  if (appDomain !== siteDomain) return deny('NotSupportedError'); // Cross-site facet lists are outside this release.
  // Preserve the original bytes: a U2F credential is scoped to the hash of the exact AppID.
  return identifier;
}
