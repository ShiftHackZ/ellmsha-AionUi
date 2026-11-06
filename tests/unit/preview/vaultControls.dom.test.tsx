import React from 'react';
import '@arco-design/web-react/es/_util/react-19-adapter';
import { cleanup, fireEvent, render, screen, waitFor, within, act } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
const api = vi.hoisted(() => ({
  request: vi.fn(async () => ({ available: false, remembered: false })),
  upload: undefined as
    | undefined
    | {
        beforeUpload: (file: { size: number; text: () => Promise<string> }) => Promise<boolean>;
        onRemove: () => boolean;
      },
}));
vi.mock('@/common/adapter/secretsBridge', () => ({ secretsRequest: api.request }));
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => (key === 'settings.secrets.retentionDisclosure' ? settings.secrets.retentionDisclosure : key),
  }),
}));
vi.mock('@arco-design/web-react', async (original) => {
  const module = await original<typeof import('@arco-design/web-react')>();
  return {
    ...module,
    Message: { error: vi.fn() },
    Upload: (props: typeof api.upload) => {
      api.upload = props;
      return <span>synthetic upload</span>;
    },
  };
});
import settings from '@/renderer/services/i18n/locales/en-US/settings.json';
import { VaultControls } from '@/renderer/components/secrets/VaultControls';
afterEach(() => {
  cleanup();
  api.request.mockClear();
});
describe('vault restore file selection', () => {
  it('invalidates old backup on malformed/oversized/removal and ignores late file reads', async () => {
    render(
      <VaultControls
        status={{ initialized: true, unlocked: true, vault_id: 'fixture', incarnation: 'fixture-incarnation' }}
        refresh={() => {}}
        clear={() => {}}
      />
    );
    fireEvent.click(screen.getByRole('button', { name: 'settings.secrets.restore' }));
    const dialog = screen.getByRole('dialog');
    fireEvent.change(within(dialog).getByLabelText('settings.secrets.passphrase'), {
      target: { value: 'synthetic passphrase' },
    });
    const submit = within(dialog).getByRole('button', { name: 'common.confirm' });
    const valid = { size: 40, text: async () => JSON.stringify({ format: 1, encrypted_data: 'synthetic' }) };
    await act(async () => {
      await api.upload!.beforeUpload(valid);
    });
    expect(submit).not.toBeDisabled();
    await act(async () => {
      await api.upload!.beforeUpload({ size: 2, text: async () => '{bad' });
    });
    expect(submit).toBeDisabled();
    await act(async () => {
      await api.upload!.beforeUpload(valid);
    });
    await act(async () => {
      await api.upload!.beforeUpload({ size: 65 * 1024 * 1024, text: async () => '' });
    });
    expect(submit).toBeDisabled();
    await act(async () => {
      await api.upload!.beforeUpload(valid);
    });
    act(() => {
      api.upload!.onRemove();
    });
    expect(submit).toBeDisabled();
    let finish!: (value: string) => void;
    let pending!: Promise<boolean>;
    act(() => {
      pending = api.upload!.beforeUpload({
        size: 10,
        text: () =>
          new Promise((resolve) => {
            finish = resolve;
          }),
      });
    });
    act(() => {
      api.upload!.onRemove();
    });
    await act(async () => {
      finish('{"format":1}');
      await pending;
    });
    await waitFor(() => expect(submit).toBeDisabled());
    expect(api.request).not.toHaveBeenCalledWith('vault/restore', expect.anything());
  });
});

it('shows provider transcript and later agent echo retention before initializing', async () => {
  render(
    <VaultControls
      status={{ initialized: false, unlocked: false, vault_id: null, incarnation: null }}
      refresh={() => {}}
      clear={() => {}}
    />
  );
  fireEvent.click(screen.getByRole('button', { name: 'settings.secrets.initialize' }));
  expect(within(screen.getByRole('dialog')).getByText(settings.secrets.retentionDisclosure)).toBeVisible();
  expect(settings.secrets.retentionDisclosure).toContain('Provider-owned transcripts');
  expect(settings.secrets.retentionDisclosure).toContain('messages written by the agent');
  await act(async () => {
    await Promise.resolve();
  });
});
