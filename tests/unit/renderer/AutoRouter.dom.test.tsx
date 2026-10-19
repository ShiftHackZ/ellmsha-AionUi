import React, { useState } from 'react';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { buildRouterOptions, isRouterLoopback } from '@/renderer/components/agent/AutoRouter/useRouter';
import {
  DEFAULT_ROUTER_CONFIG,
  getRouterChildMetadata,
  routerTargetKey,
  type RouterCatalogEntry,
  type RouterConfig,
  type RouterTarget,
} from '@/common/types/agent/routerTypes';
import {
  activeRouterConfig,
  normalizeRouterSettings,
  routerClassError,
  routerReadinessError,
  ROUTER_MODES,
  ROUTER_PRESETS,
  selectRouterSlot,
  updateRouterSlot,
} from '@/renderer/components/agent/AutoRouter/routerConfigState';
import RouterConfigFields from '@/renderer/components/agent/AutoRouter/RouterConfigFields';
import RouterDiagram from '@/renderer/components/agent/AutoRouter/RouterDiagram';
import { RouterTargetPicker } from '@/renderer/components/agent/AutoRouter/RouterNodeFields';
import type { IProvider, TChatConversation } from '@/common/config/storage';
import { getSubagentDisplayStatus, isSubagentRunning } from '@/renderer/pages/conversation/GroupedHistory/types';

vi.mock('react-i18next', async () => {
  const settings = (await import('@/renderer/services/i18n/locales/en-US/settings.json')).default;
  const common = (await import('@/renderer/services/i18n/locales/en-US/common.json')).default;
  return {
    useTranslation: () => ({
      t: (key: string, values: Record<string, unknown> = {}) => {
        let value: unknown = { settings, common };
        for (const part of key.split('.'))
          value = value && typeof value === 'object' ? (value as Record<string, unknown>)[part] : undefined;
        return String(value ?? values.defaultValue ?? key).replace(/{{(\w+)}}/g, (_, name: string) =>
          String(values[name] ?? name)
        );
      },
    }),
  };
});
vi.mock('@/common/adapter/httpBridge', () => ({ httpRequest: vi.fn() }));
vi.mock('@/renderer/hooks/agent/useModelProviderList', () => ({ useProvidersQuery: vi.fn() }));
vi.mock('@/renderer/services/clientBusinessSettings', () => ({
  getClientBusinessSetting: vi.fn(),
  setClientBusinessSetting: vi.fn(),
}));
vi.mock('@/renderer/pages/conversation/utils/conversationCache', () => ({ getConversationOrNull: vi.fn() }));
const root: RouterTarget = { kind: 'provider', provider_id: 'local', model: 'small' };
const child: RouterTarget = { kind: 'agent', agent_id: 'cli', model: 'large' };
const entry = (target: RouterTarget, patch: Partial<RouterCatalogEntry> = {}): RouterCatalogEntry => ({
  target,
  label: target.kind === 'provider' ? 'Local API' : 'CLI',
  backend: 'aionrs',
  local: false,
  root: { supported: true },
  child: { supported: true },
  classifier: { supported: true },
  ...patch,
});
const providers = [
  {
    id: 'local',
    platform: 'custom',
    name: 'Local API',
    base_url: 'http://127.0.0.2:9000/v1',
    api_key: 'do-not-copy',
    models: ['small'],
  },
] as IProvider[];
const config: RouterConfig = {
  ...DEFAULT_ROUTER_CONFIG,
  classifier_target: root,
  classes: [{ id: 'review', name: 'Review code', description: 'Review changes', target: child }],
  hints: [{ target: root, strengths: ['review'], local_inference: true, quality_tier: 4 }],
};
const options = buildRouterOptions([entry(root), entry(child)], providers);

describe('independent router graph settings', () => {
  it('round-trips all 15 slots and restores classes, targets, pool and hints independently', () => {
    let settings = normalizeRouterSettings(config);
    for (const mode of ROUTER_MODES)
      for (const preset of ROUTER_PRESETS) {
        settings = selectRouterSlot(settings, mode, preset);
        settings = updateRouterSlot(settings, {
          ...activeRouterConfig(settings),
          root_target: root,
          child_target: child,
          allowed_targets: [root],
          classes: [{ ...config.classes![0], name: `${mode}-${preset}` }],
          hints: [{ ...config.hints[0], expected_latency_ms: ROUTER_PRESETS.indexOf(preset) }],
        });
      }
    const restored = normalizeRouterSettings(JSON.parse(JSON.stringify(settings)));
    for (const mode of ROUTER_MODES)
      for (const preset of ROUTER_PRESETS) {
        const slot = activeRouterConfig(selectRouterSlot(restored, mode, preset));
        expect(slot.classes![0].name).toBe(`${mode}-${preset}`);
        expect(slot.root_target).toEqual(root);
        expect(slot.child_target).toEqual(child);
        expect(slot.allowed_targets).toEqual([root]);
        expect(slot.hints[0].expected_latency_ms).toBe(ROUTER_PRESETS.indexOf(preset));
      }
  });
  it('preserves incomplete inactive Manual and copies custom classes only at first initialization', () => {
    const original = normalizeRouterSettings(config);
    let draft = selectRouterSlot(original, 'manual');
    expect(routerReadinessError(activeRouterConfig(draft))).toBe('rootRequired');
    draft = updateRouterSlot(draft, {
      ...activeRouterConfig(draft),
      classes: [{ ...config.classes![0], name: 'Manual only' }],
    });
    draft = selectRouterSlot(draft, 'auto');
    expect(routerReadinessError(activeRouterConfig(draft))).toBeUndefined();
    expect(activeRouterConfig(draft).classes![0].name).toBe('Review code');
    expect(activeRouterConfig(selectRouterSlot(draft, 'manual')).classes![0].name).toBe('Manual only');
    expect(original.configurations.manual).toBeUndefined();
  });
  it('migrates preferences without changing legacy snapshots or local-only quality', () => {
    const legacy = {
      ...config,
      schema_version: undefined,
      profile: 'quality' as const,
      local_only: true,
      classes: undefined,
    };
    const before = JSON.stringify(legacy);
    const saved = normalizeRouterSettings(legacy);
    expect(activeRouterConfig(saved).schema_version).toBe(2);
    expect(saved.active_presets.auto).toBe('local_only');
    expect(
      activeRouterConfig(selectRouterSlot(selectRouterSlot(saved, 'auto', 'cost'), 'auto', 'local_only')).profile
    ).toBe('quality');
    expect(JSON.stringify(legacy)).toBe(before);
  });
  it('checks UTF-8 byte limits, required description and classifier readiness', () => {
    const value = { ...config.classes![0], name: 'я'.repeat(40), description: '🙂'.repeat(256) };
    expect(routerClassError(value)).toBeUndefined();
    expect(routerClassError({ ...value, name: value.name + 'я' })).toBe('className');
    expect(routerClassError({ ...value, description: value.description + '🙂' })).toBe('classDescription');
    expect(routerClassError({ ...value, description: ' ' })).toBe('classDescription');
    expect(routerReadinessError({ ...config, classifier_target: undefined })).toBe('classifierRequired');
    expect(routerReadinessError({ ...config, classes: [], classifier_target: undefined })).toBeUndefined();
  });
});

describe('catalog and editable graph', () => {
  it('retains API/CLI unhealthy and unsupported targets without copying secrets or auto-declaring local', () => {
    const catalog = buildRouterOptions(
      [
        entry(root, { classifier: { supported: false, reason: 'model_unhealthy' } }),
        entry(child, { child: { supported: false, reason: 'host_delegation_unverified' } }),
      ],
      providers
    );
    expect(catalog).toHaveLength(2);
    expect(catalog[0].local).toBe(false);
    expect(catalog[0].loopback).toBe(true);
    expect(catalog[1].loopback).toBe(false);
    expect(catalog[0].classifier.reason).toBe('model_unhealthy');
    expect(JSON.stringify(catalog)).not.toContain('do-not-copy');
  });
  it.each(['http://localhost', 'https://127.0.0.2:5000', 'http://[::1]:9000'])(
    'allows an explicit declaration for %s',
    (url) => expect(isRouterLoopback(url)).toBe(true)
  );
  it.each(['ftp://localhost', 'http://localhost.example.com', 'https://example.com', 'http://[::ffff:127.0.0.1]'])(
    'does not declare non-Core-loopback %s',
    (url) => expect(isRouterLoopback(url)).toBe(false)
  );
  it('does not collide account and runtime model identity', () =>
    expect(routerTargetKey(root)).not.toBe(routerTargetKey({ kind: 'agent', agent_id: 'local', model: 'small' })));
  it('shows classifier fallback, but keeps local-only conflicts explicitly blocked', () => {
    const unavailable = buildRouterOptions(
      [entry(root, { classifier: { supported: false, reason: 'model_unhealthy' } })],
      providers
    );
    const view = render(
      <RouterTargetPicker role='classifier' target={root} options={unavailable} onChange={vi.fn()} />
    );
    expect(screen.getByRole('alert')).toHaveTextContent('subagents use the default policy');
    expect(screen.getByRole('alert')).not.toHaveTextContent('execution is blocked');
    view.rerender(
      <RouterTargetPicker role='classifier' target={root} options={unavailable} localOnly onChange={vi.fn()} />
    );
    expect(screen.getByRole('alert')).toHaveTextContent('execution is blocked');
  });
  it('only warns about the saved classifier when classes actually use it', () => {
    const unavailable = buildRouterOptions(
      [entry(root, { classifier: { supported: false, reason: 'local_only' } })],
      providers
    );
    const props = {
      config: { ...config, local_only: true },
      options: unavailable,
      onChange: vi.fn(),
      onClassesChange: vi.fn(),
    };
    const view = render(<RouterDiagram {...props} classes={[]} />);
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    view.rerender(<RouterDiagram {...props} classes={config.classes!} />);
    expect(screen.getByRole('alert')).toHaveTextContent('execution is blocked');
  });
  it('keeps the class junction below a taller default-subagent card', () => {
    const original = HTMLElement.prototype.getBoundingClientRect;
    const rectangles: Record<string, DOMRect> = {
      root: new DOMRect(180, 0, 320, 100),
      child: new DOMRect(0, 132, 320, 268),
      classifier: new DOMRect(360, 132, 320, 168),
      class: new DOMRect(0, 432, 320, 200),
    };
    const measure = vi
      .spyOn(HTMLElement.prototype, 'getBoundingClientRect')
      .mockImplementation(function (this: HTMLElement) {
        return rectangles[this.dataset.routerNode ?? ''] ?? original.call(this);
      });
    try {
      const view = render(
        <RouterDiagram
          config={config}
          classes={config.classes!}
          options={options}
          onChange={vi.fn()}
          onClassesChange={vi.fn()}
        />
      );
      const paths = [...view.container.querySelectorAll('svg[aria-hidden] path')].map((path) => path.getAttribute('d'));
      expect(paths).toContain('M 520 300 V 416 H 520');
      expect(paths).toContain('M 160 416 H 520');
      expect(paths).toContain('M 160 416 V 432');
    } finally {
      measure.mockRestore();
    }
  });
  it('shows fields inside their own nodes and keeps inline changes across catalog refresh without node Apply', () => {
    let current = normalizeRouterSettings({ ...config, mode: 'manual', root_target: root, child_target: child });
    const Harness = ({ revision }: { revision: number }) => {
      const [settings, setSettings] = useState(current);
      current = settings;
      return (
        <RouterConfigFields
          value={settings}
          onChange={setSettings}
          options={options.map((option) => ({ ...option, label: `${option.label}${revision}` }))}
        />
      );
    };
    const view = render(<Harness revision={1} />);
    for (const name of ['Root agent', 'Default subagents', 'Task classifier', 'Review code']) {
      expect(
        within(screen.getByRole('region', { name })).getByLabelText('Account / runtime and model')
      ).toBeInTheDocument();
    }
    const card = screen.getByRole('region', { name: 'Review code' });
    const remove = within(card).getByRole('button', { name: 'Delete' });
    expect(remove).toHaveTextContent('');
    expect(remove.querySelector('svg')).toBeInTheDocument();
    fireEvent.change(within(card).getByRole('textbox', { name: 'Class name' }), { target: { value: 'Kept draft' } });
    view.rerender(<Harness revision={2} />);
    expect(screen.getByRole('textbox', { name: 'Class name' })).toHaveValue('Kept draft');
    expect(activeRouterConfig(current).classes![0].name).toBe('Kept draft');
    expect(screen.queryByRole('button', { name: 'Apply node changes' })).not.toBeInTheDocument();
    expect(screen.queryByTestId('router-node-editor')).not.toBeInTheDocument();
  });
  it('retains incomplete class edits across independent slots and reports them until corrected or removed', async () => {
    let current = normalizeRouterSettings(config);
    const incomplete = vi.fn();
    const Harness = () => {
      const [settings, setSettings] = useState(current);
      current = settings;
      return (
        <RouterConfigFields value={settings} onChange={setSettings} options={options} onIncompleteChange={incomplete} />
      );
    };
    render(<Harness />);
    const switchPreset = async (label: string) => {
      const picker = screen.getByLabelText('Optimization preset');
      fireEvent.click(picker);
      await waitFor(() => expect(picker).toHaveAttribute('aria-expanded', 'true'));
      const option = (await screen.findAllByText(label)).find((item) => item.closest('[role=option]'));
      fireEvent.click(option!.closest('[role=option]')!);
      await waitFor(() => expect(picker).toHaveAttribute('aria-expanded', 'false'));
      await waitFor(() => expect(option).not.toBeInTheDocument());
    };
    fireEvent.change(screen.getByRole('textbox', { name: 'Class name' }), { target: { value: '🙂'.repeat(21) } });
    await waitFor(() => expect(incomplete).toHaveBeenLastCalledWith(true));
    expect(activeRouterConfig(current).classes![0].name).toBe('Review code');
    await switchPreset('Lowest known cost');
    expect(screen.getByRole('textbox', { name: 'Class name' })).toHaveValue('🙂'.repeat(21));
    fireEvent.change(screen.getByRole('textbox', { name: 'Class name' }), { target: { value: 'Cost class' } });
    await switchPreset('Balanced');
    expect(screen.getByRole('textbox', { name: 'Class name' })).toHaveValue('🙂'.repeat(21));
    expect(incomplete).toHaveBeenLastCalledWith(true);
    fireEvent.click(
      within(screen.getByRole('region', { name: '🙂'.repeat(21) })).getByRole('button', { name: 'Delete' })
    );
    await waitFor(() => expect(incomplete).toHaveBeenLastCalledWith(false));
    await switchPreset('Lowest known cost');
    expect(screen.getByRole('textbox', { name: 'Class name' })).toHaveValue('Cost class');
  });
  it('creates and edits an inline class over HTTP LAN without crypto.randomUUID', async () => {
    const getRandomValues = globalThis.crypto.getRandomValues.bind(globalThis.crypto);
    vi.stubGlobal('crypto', { getRandomValues });
    try {
      let current = normalizeRouterSettings(config);
      const incomplete = vi.fn();
      const Harness = () => {
        const [settings, setSettings] = useState(current);
        current = settings;
        return (
          <RouterConfigFields
            value={settings}
            onChange={setSettings}
            options={options}
            onIncompleteChange={incomplete}
          />
        );
      };
      render(<Harness />);
      expect(
        within(screen.getByRole('region', { name: 'Root agent' })).queryByLabelText('Account / runtime and model')
      ).not.toBeInTheDocument();
      fireEvent.click(screen.getByRole('button', { name: 'Add task class' }));
      const card = screen.getByRole('region', { name: 'Add task class' });
      fireEvent.change(within(card).getByRole('textbox', { name: 'Class name' }), { target: { value: 'LAN review' } });
      fireEvent.change(within(card).getByRole('textbox', { name: 'Tasks that match this class' }), {
        target: { value: 'Review changes over the local network' },
      });
      expect(incomplete).toHaveBeenLastCalledWith(true);
      const picker = within(card).getByLabelText('Account / runtime and model');
      fireEvent.click(picker);
      await waitFor(() => expect(picker).toHaveAttribute('aria-expanded', 'true'));
      const option = (await screen.findAllByText('Local API · small')).find((element) =>
        element.closest('[role=option]')
      );
      fireEvent.click(option!.closest('[role=option]')!);
      const classes = activeRouterConfig(current).classes!;
      expect(classes).toHaveLength(2);
      expect(classes[0]).toEqual(config.classes![0]);
      expect(classes[1]).toMatchObject({ name: 'LAN review', target: root });
      expect(classes[1].id).toMatch(/^class-[0-9a-f]{32}$/);
      expect(incomplete).toHaveBeenLastCalledWith(false);
      fireEvent.change(within(card).getByRole('textbox', { name: 'Class name' }), {
        target: { value: 'Renamed review' },
      });
      expect(activeRouterConfig(current).classes![1].id).toBe(classes[1].id);
    } finally {
      vi.unstubAllGlobals();
    }
  });
  it('prevents a 129th explicit pool target while allowing replacement and the all-targets policy', async () => {
    const targets: RouterTarget[] = Array.from({ length: 129 }, (_, index) => ({
      kind: 'provider',
      provider_id: 'local',
      model: `model-${String(index).padStart(3, '0')}`,
    }));
    let current = normalizeRouterSettings({ ...config, allowed_targets: targets.slice(0, 128) });
    const Harness = () => {
      const [settings, setSettings] = useState(current);
      current = settings;
      return (
        <RouterConfigFields
          value={settings}
          onChange={setSettings}
          options={buildRouterOptions(
            targets.filter((target) => target.model !== 'model-127').map((target) => entry(target)),
            providers
          )}
        />
      );
    };
    render(<Harness />);
    fireEvent.click(screen.getByText('Advanced settings'));
    const picker = screen.getByLabelText('Allowed targets');
    fireEvent.click(picker);
    await waitFor(() => expect(picker).toHaveAttribute('aria-expanded', 'true'));
    fireEvent.change(picker.querySelector('input')!, { target: { value: 'model-128' } });
    const extra = (await screen.findAllByText('model-128'))
      .find((element) => element.closest('[role=option]'))!
      .closest('[role=option]')!;
    expect(extra).toHaveClass('arco-select-option-wrapper-disabled');
    fireEvent.click(extra.querySelector('.arco-select-option')!);
    expect(activeRouterConfig(current).allowed_targets).toHaveLength(128);
    fireEvent.change(picker.querySelector('input')!, { target: { value: 'model-000' } });
    fireEvent.click(
      (await screen.findAllByText('model-000'))
        .find((element) => element.closest('[role=option]'))!
        .closest('[role=option]')!
        .querySelector('.arco-select-option')!
    );
    expect(activeRouterConfig(current).allowed_targets).toHaveLength(127);
    fireEvent.change(picker.querySelector('input')!, { target: { value: 'model-128' } });
    const replacement = (await screen.findAllByText('model-128'))
      .find((element) => element.closest('[role=option]'))!
      .closest('[role=option]')!;
    expect(replacement).not.toHaveClass('arco-select-option-wrapper-disabled');
    fireEvent.click(replacement.querySelector('.arco-select-option')!);
    expect(activeRouterConfig(current).allowed_targets).toHaveLength(128);
    expect(activeRouterConfig(current).allowed_targets).toContainEqual(targets[128]);
    expect(activeRouterConfig(current).allowed_targets).toContainEqual(targets[127]);
    fireEvent.click(screen.getByRole('checkbox', { name: 'Use all eligible configured targets' }));
    expect(activeRouterConfig(current).allowed_targets).toEqual([]);
  });
  it('prevents metadata for a 129th target without blocking edits to existing metadata', async () => {
    const targets: RouterTarget[] = Array.from({ length: 129 }, (_, index) => ({
      kind: 'provider',
      provider_id: 'local',
      model: `model-${String(index).padStart(3, '0')}`,
    }));
    let current = normalizeRouterSettings({
      ...config,
      hints: targets.slice(0, 128).map((target) => ({ target, strengths: [], local_inference: false })),
    });
    const Harness = () => {
      const [settings, setSettings] = useState(current);
      current = settings;
      return (
        <RouterConfigFields
          value={settings}
          onChange={setSettings}
          options={buildRouterOptions(
            targets.map((target) => entry(target)),
            providers
          )}
        />
      );
    };
    render(<Harness />);
    fireEvent.click(screen.getByText('Advanced settings'));
    const picker = screen.getByLabelText('Optional metadata for a target');
    fireEvent.click(picker);
    await waitFor(() => expect(picker).toHaveAttribute('aria-expanded', 'true'));
    fireEvent.change(picker.querySelector('input')!, { target: { value: 'model-128' } });
    const extra = (await screen.findAllByText('model-128'))
      .find((element) => element.closest('[role=option]'))!
      .closest('[role=option]')!;
    expect(extra).toHaveClass('arco-select-option-disabled');
    fireEvent.click(extra);
    expect(screen.queryByLabelText('Expected latency (ms)')).not.toBeInTheDocument();
    fireEvent.change(picker.querySelector('input')!, { target: { value: 'model-000' } });
    fireEvent.click(
      (await screen.findAllByText('model-000'))
        .find((element) => element.closest('[role=option]'))!
        .closest('[role=option]')!
    );
    fireEvent.change(screen.getByLabelText('Expected latency (ms)'), { target: { value: '250' } });
    expect(activeRouterConfig(current).hints).toHaveLength(128);
    expect(activeRouterConfig(current).hints.find((item) => item.target.model === 'model-000')).toMatchObject({
      expected_latency_ms: 250,
    });
    fireEvent.click(screen.getByRole('button', { name: 'Clear' }));
    expect(activeRouterConfig(current).hints).toHaveLength(127);
    expect(activeRouterConfig(current).hints.some((item) => item.target.model === 'model-000')).toBe(false);
    await waitFor(() => expect(picker).toHaveAttribute('aria-expanded', 'false'));
    fireEvent.click(picker);
    fireEvent.change(picker.querySelector('input')!, { target: { value: 'model-128' } });
    const replacement = (await screen.findAllByText('model-128'))
      .find((element) => element.closest('[role=option]'))!
      .closest('[role=option]')!;
    expect(replacement).not.toHaveClass('arco-select-option-disabled');
    fireEvent.click(replacement);
    fireEvent.change(screen.getByLabelText('Expected latency (ms)'), { target: { value: '80' } });
    expect(activeRouterConfig(current).hints).toHaveLength(128);
    expect(activeRouterConfig(current).hints.find((item) => item.target.model === 'model-128')).toMatchObject({
      expected_latency_ms: 80,
    });
  });
});

describe('managed child runtime status', () => {
  const childConversation = (runtime?: TChatConversation['runtime']): TChatConversation =>
    ({
      id: 'child',
      type: 'acp',
      runtime,
      extra: {
        router_child: {
          version: 1,
          root_conversation_id: 'root',
          parent_conversation_id: 'root',
          parent_turn_id: 'turn',
          task_id: 'task',
        },
        subagent: { parent_conversation_id: 'root', ref: 'task', status: 'running' },
      },
    }) as unknown as TChatConversation;
  const idle = {
    state: 'idle',
    pending_confirmations: 0,
    is_processing: false,
    has_task: false,
    can_send_message: true,
    turn_id: null,
  } as const;
  it('does not resurrect persisted running state after Core restart or missing status', () => {
    expect(getSubagentDisplayStatus(childConversation(idle))).toBe('idle');
    expect(isSubagentRunning(childConversation(idle))).toBe(false);
    expect(getSubagentDisplayStatus(childConversation())).toBe('unknown');
    expect(isSubagentRunning(childConversation())).toBe(false);
  });
  it('shows current approval instead of a stale running spinner', () => {
    const conversation = childConversation({ ...idle, state: 'waiting_confirmation', pending_confirmations: 1 });
    expect(getSubagentDisplayStatus(conversation)).toBe('waiting_for_approval');
    expect(isSubagentRunning(conversation)).toBe(false);
  });
  it('requires complete versioned lineage and preserves vendor transcript status', () => {
    expect(getRouterChildMetadata({ router_child: { version: 1, task_id: 'task' } })).toBeUndefined();
    const conversation = childConversation(idle);
    delete (conversation.extra as Record<string, unknown>).router_child;
    expect(getSubagentDisplayStatus(conversation)).toBe('running');
  });
});
