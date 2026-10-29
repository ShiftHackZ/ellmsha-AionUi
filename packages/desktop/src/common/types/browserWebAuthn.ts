/** Bounded wire data; websites never receive native device paths or PINs. */
export type SecurityKeyRequest = {
  requestId: string;
  mediation?: string;
  publicKey: {
    challenge: string;
    rpId?: string;
    timeout?: number;
    userVerification?: string;
    allowCredentials?: { type: string; id: string; transports?: string[] }[];
    extensions?: Record<string, unknown>;
    authenticatorAttachment?: string;
    hints?: string[];
  };
};
export type SecurityKeyAssertion = {
  id: string;
  authenticatorData: string;
  signature: string;
  userHandle: string | null;
};
export type SecurityKeyResponse =
  | { ok: true; assertion: SecurityKeyAssertion; clientDataJSON: string; appid?: boolean }
  | {
      ok: false;
      error: 'AbortError' | 'NotAllowedError' | 'NotSupportedError' | 'SecurityError' | 'TypeError';
    };
export type SecurityKeyDialogState = {
  step: 'confirm' | 'devices' | 'pin' | 'touch' | 'accounts' | 'error';
  origin: string;
  rpId: string;
  options?: { id: string; name: string }[];
  retries?: number;
  error?: 'invalidPin' | 'blockedPin' | 'unavailable' | 'unsupported' | 'noCredential';
  language: string;
  dark: boolean;
};
export type SecurityKeyAction = {
  action: 'cancel' | 'continue' | 'refresh' | 'select' | 'pin';
  value?: string;
};
