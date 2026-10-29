import { createRequire } from 'node:module';
import path from 'node:path';
import type { SecurityKeyAssertion } from '@/common/types/browserWebAuthn';

type NativeAssertion = {
  id: Buffer;
  authenticatorData: Buffer;
  signature: Buffer;
  userHandle: Buffer;
  name: string;
};
type NativeResult = {
  code: number;
  devices?: { path: string; name: string }[];
  fido2?: boolean;
  pinSet?: boolean;
  uvSet?: boolean;
  retries?: number;
  assertions?: NativeAssertion[];
};
type Native = {
  enumerate(): NativeResult;
  info(path: string): NativeResult;
  assert(input: Record<string, unknown>): NativeResult;
};
type Command = {
  id: number;
  operation: 'enumerate' | 'info' | 'assert';
  input?: Record<string, unknown>;
};
let native: Native | undefined;
process.parentPort?.on('message', (event: { data: Command }) => {
  const command = event.data;
  try {
    if (!command || !Number.isSafeInteger(command.id) || !['enumerate', 'info', 'assert'].includes(command.operation))
      throw new Error('Invalid command');
    if (!native) {
      const file = path
        .join(__dirname, 'native/security-key/security-key.node')
        .replace('app.asar/', 'app.asar.unpacked/');
      native = createRequire(__filename)(file) as Native;
    }
    let result: NativeResult;
    if (command.operation === 'enumerate') result = native.enumerate();
    else if (command.operation === 'info') result = native.info(String(command.input?.path ?? ''));
    else {
      const input = command.input!;
      result = native.assert({
        ...input,
        hash: Buffer.from(String(input.hash), 'base64url'),
        allowCredentials: (input.allowCredentials as string[]).map((v) => Buffer.from(v, 'base64url')),
      });
      input.pin = '';
    }
    const assertions: (SecurityKeyAssertion & { name: string })[] | undefined = result.assertions?.map((a) => ({
      id: a.id.toString('base64url'),
      authenticatorData: a.authenticatorData.toString('base64url'),
      signature: a.signature.toString('base64url'),
      userHandle: a.userHandle.length ? a.userHandle.toString('base64url') : null,
      name: a.name.slice(0, 256),
    }));
    process.parentPort?.postMessage({ id: command.id, ...result, assertions });
  } catch {
    // Native error text/arguments can contain secrets; emit a fixed diagnostic.
    process.parentPort?.postMessage({
      id: command.id,
      code: -1,
      nativeLoaded: native !== undefined,
    });
  } finally {
    if (command?.input && 'pin' in command.input) command.input.pin = '';
  }
});
