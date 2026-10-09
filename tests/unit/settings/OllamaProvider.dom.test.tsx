/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */
import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';

const { fetchModels, resetDetection } = vi.hoisted(() => ({ fetchModels: vi.fn(), resetDetection: vi.fn() }));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('@/common', () => ({ ipcBridge: { mode: { fetchModelList: { invoke: vi.fn() } } } }));
vi.mock('@/renderer/hooks/agent/useModeModeList', () => ({
  default: (...args: unknown[]) => {
    fetchModels(...args);
    return { data: { models: [{ label: 'qwen3:8b', value: 'qwen3:8b' }] }, mutate: vi.fn(), isLoading: false };
  },
}));
vi.mock('@/renderer/hooks/system/useProtocolDetection', () => ({
  default: () => ({ reset: resetDetection, isDetecting: false, result: null }),
}));
vi.mock('@/renderer/components/base/AionModal', () => ({
  default: ({ children, onOk }: { children: React.ReactNode; onOk: () => void }) => (
    <div>
      {children}
      <button onClick={onOk}>Save provider</button>
    </div>
  ),
}));

import AddPlatformModal from '@/renderer/pages/settings/components/AddPlatformModal';
import EditModeModal from '@/renderer/pages/settings/components/EditModeModal';

Object.defineProperty(window, 'matchMedia', {
  writable: true,
  value: vi.fn((query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: vi.fn(),
    removeListener: vi.fn(),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    dispatchEvent: vi.fn(),
  })),
});

describe('Ollama provider setup', () => {
  it('discovers and saves a model without requiring the user to enter an API key', async () => {
    const onSubmit = vi.fn();
    render(
      <AddPlatformModal
        initialPlatform='Ollama'
        onSubmit={onSubmit}
        modalCtrl={{ close: vi.fn() }}
        modalProps={{ visible: true }}
      />
    );
    expect(screen.getByDisplayValue('http://localhost:11434/v1')).toBeInTheDocument();
    expect(screen.getByText('settings.ollama.apiKeyOptional')).toBeInTheDocument();
    expect(fetchModels).toHaveBeenCalledWith('custom', 'http://localhost:11434/v1', 'ollama', true, undefined);
    // Arco associates the label with the composite Select's div, not its input.
    fireEvent.click(document.getElementById('model_input')!);
    fireEvent.click(await screen.findByText('qwen3:8b'));
    fireEvent.click(screen.getByText('Save provider'));
    await waitFor(() =>
      expect(onSubmit).toHaveBeenCalledWith(
        expect.objectContaining({
          name: 'Ollama',
          platform: 'custom',
          api_key: 'ollama',
          models: ['qwen3:8b'],
          model_settings: { 'qwen3:8b': { openai_api_mode: 'chat_completions' } },
        })
      )
    );
  });

  it('keeps the local placeholder private to configuration when editing and saving with the field blank', async () => {
    const onChange = vi.fn();
    render(
      <EditModeModal
        data={{
          id: 'local',
          name: 'Ollama',
          platform: 'custom',
          base_url: 'http://localhost:11434/v1',
          api_key: 'ollama',
          models: ['qwen3:8b'],
        }}
        onChange={onChange}
        modalCtrl={{ close: vi.fn() }}
        modalProps={{ visible: true }}
      />
    );
    expect(screen.getByLabelText('settings.apiKey')).toHaveValue('');
    fireEvent.click(screen.getByText('Save provider'));
    await waitFor(() =>
      expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ api_key: 'ollama', models: ['qwen3:8b'] }))
    );
  });
});
