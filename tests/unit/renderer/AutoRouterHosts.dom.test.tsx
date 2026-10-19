import React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, expect, it, vi } from 'vitest';
import type { RouterSettings } from '@/common/types/agent/routerTypes';
import {
  normalizeRouterSettings,
  selectRouterSlot,
  activeRouterConfig,
} from '@/renderer/components/agent/AutoRouter/routerConfigState';
import AutoRouterSettings, { RouterPolicyButton } from '@/renderer/components/agent/AutoRouter';

const state = vi.hoisted(() => ({ data: undefined as RouterSettings | undefined, save: vi.fn() }));
vi.mock('@arco-design/web-react', async () => ({
  ...(await vi.importActual('@arco-design/web-react')),
  Message: { success: vi.fn(), error: vi.fn() },
}));
vi.mock('react-router-dom', () => ({ useNavigate: () => vi.fn() }));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('@/renderer/components/agent/AutoRouter/useRouter', () => ({
  useRouterConfig: () => ({ data: state.data, save: state.save }),
  useRouterOptions: () => ({ options: [] }),
}));
vi.mock('@/renderer/components/base/AionModal', () => ({
  default: ({
    visible,
    onCancel,
    onOk,
    children,
    okButtonProps,
  }: {
    visible: boolean;
    onCancel: () => void;
    onOk: () => void;
    children: React.ReactNode;
    okButtonProps?: { disabled?: boolean };
  }) =>
    visible ? (
      <div>
        <button onClick={onCancel}>outer cancel</button>
        <button disabled={okButtonProps?.disabled} onClick={onOk}>
          outer apply
        </button>
        {children}
      </div>
    ) : null,
}));
vi.mock('@/renderer/components/agent/AutoRouter/RouterConfigFields', () => ({
  default: ({
    value,
    onChange,
    onIncompleteChange,
  }: {
    value: RouterSettings;
    onChange: (value: RouterSettings) => void;
    onIncompleteChange?: (incomplete: boolean) => void;
  }) => (
    <div>
      <button
        onClick={() => {
          onIncompleteChange?.(true);
          onChange(structuredClone(value));
        }}
      >
        incomplete class
      </button>
      <span data-testid='active-slot'>
        {value.active_mode}:{value.active_presets[value.active_mode]}
      </span>
      <button onClick={() => onChange(selectRouterSlot(value, 'manual'))}>edit manual</button>
      <button onClick={() => onChange(selectRouterSlot(value, 'auto', 'cost'))}>edit cost</button>
      <span data-testid='manual-preserved'>{String(Boolean(value.configurations.manual))}</span>
    </div>
  ),
}));

beforeEach(() => {
  state.data = normalizeRouterSettings();
  state.save.mockReset();
  state.save.mockResolvedValue(undefined);
});
it('global background preference/catalog refresh never overwrites a dirty multi-slot draft; Cancel restores saved data', async () => {
  const view = render(<AutoRouterSettings />);
  await screen.findByTestId('active-slot');
  fireEvent.click(screen.getByText('edit manual'));
  fireEvent.click(screen.getByText('edit cost'));
  state.data = selectRouterSlot(normalizeRouterSettings(), 'auto', 'speed');
  view.rerender(<AutoRouterSettings />);
  expect(screen.getByTestId('active-slot')).toHaveTextContent('auto:cost');
  expect(screen.getByTestId('manual-preserved')).toHaveTextContent('true');
  fireEvent.click(screen.getByTestId('router-save'));
  await waitFor(() => expect(state.save).toHaveBeenCalledTimes(1));
  expect(state.save.mock.calls[0][0].configurations.manual.balanced.root_target).toBeUndefined();
  await waitFor(() => expect(screen.getByRole('button', { name: 'common.cancel' })).not.toBeDisabled());
  fireEvent.click(screen.getByText('edit cost'));
  fireEvent.click(screen.getByRole('button', { name: 'common.cancel' }));
  expect(screen.getByTestId('active-slot')).toHaveTextContent('auto:speed');
});
it('per-chat outer Cancel discards all edited modes; Apply returns only the independently edited envelope to its caller', () => {
  const changed = vi.fn();
  render(<RouterPolicyButton value={state.data} onChange={changed} />);
  fireEvent.click(screen.getByTestId('router-policy-button'));
  fireEvent.click(screen.getByText('edit manual'));
  fireEvent.click(screen.getByText('edit cost'));
  fireEvent.click(screen.getByText('outer cancel'));
  expect(changed).not.toHaveBeenCalled();
  fireEvent.click(screen.getByTestId('router-policy-button'));
  expect(screen.getByTestId('active-slot')).toHaveTextContent('auto:balanced');
  expect(screen.getByTestId('manual-preserved')).toHaveTextContent('false');
  fireEvent.click(screen.getByText('edit cost'));
  fireEvent.click(screen.getByText('outer apply'));
  const applied = changed.mock.calls[0][0] as RouterSettings;
  expect(activeRouterConfig(applied).schema_version).toBe(2);
  expect(activeRouterConfig(state.data!).profile).toBe('balanced');
});

it('freezes the complete editor during a deferred Save and permits a new edit only after the saved revision returns', async () => {
  let finish!: () => void;
  state.save.mockImplementation(
    (saved: RouterSettings) =>
      new Promise<void>((resolve) => {
        finish = () => {
          state.data = structuredClone(saved);
          resolve();
        };
      })
  );
  render(<AutoRouterSettings />);
  fireEvent.click(await screen.findByText('edit cost'));
  fireEvent.click(screen.getByTestId('router-save'));
  await waitFor(() => expect(state.save).toHaveBeenCalledTimes(1));
  expect(screen.getByText('edit manual')).toBeDisabled();
  expect(screen.getByText('edit manual').closest('fieldset')).toHaveAttribute('inert');
  fireEvent.click(screen.getByText('edit manual'));
  expect(screen.getByTestId('active-slot')).toHaveTextContent('auto:cost');
  finish();
  await waitFor(() => expect(screen.getByText('edit manual')).not.toBeDisabled());
  expect(screen.getByTestId('active-slot')).toHaveTextContent('auto:cost');
  fireEvent.click(screen.getByText('edit manual'));
  expect(screen.getByTestId('active-slot')).toHaveTextContent('manual:balanced');
  expect(screen.getByRole('status')).toHaveTextContent('settings.autoRouter.graph.dirty');
});
it('blocks global and per-chat saves with a visible unfinished-class reason; outer Cancel discards the draft', async () => {
  const global = render(<AutoRouterSettings />);
  fireEvent.click(await screen.findByText('incomplete class'));
  expect(screen.getByTestId('router-save')).toBeDisabled();
  expect(screen.getByRole('alert')).toHaveTextContent('settings.autoRouter.graph.errors.incompleteClasses');
  fireEvent.click(screen.getByRole('button', { name: 'common.cancel' }));
  expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  global.unmount();
  const changed = vi.fn();
  render(<RouterPolicyButton value={state.data} onChange={changed} />);
  fireEvent.click(screen.getByTestId('router-policy-button'));
  fireEvent.click(screen.getByText('incomplete class'));
  expect(screen.getByText('outer apply')).toBeDisabled();
  fireEvent.click(screen.getByText('outer cancel'));
  fireEvent.click(screen.getByTestId('router-policy-button'));
  expect(screen.getByText('outer apply')).not.toBeDisabled();
  expect(changed).not.toHaveBeenCalled();
});
