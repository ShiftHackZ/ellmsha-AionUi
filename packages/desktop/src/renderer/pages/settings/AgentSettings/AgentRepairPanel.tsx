/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Alert, Button, Input, Message, Radio, Spin, Typography } from '@arco-design/web-react';
import { useTranslation } from 'react-i18next';
import {
  acpConversation,
  systemSettings,
  type CliRuntimeInfo,
  type CliRuntimeSelection,
} from '@/common/adapter/ipcBridge';
import { AION_ADD_BUTTON_CLASS } from '@/renderer/components/base/TalkToButlerButton';
import { formatManagedAgentDiagnosticMessage, type ManagedAgent } from '@/renderer/utils/model/agentTypes';
import EnvVarEditor, { type EnvVarRow } from './EnvVarEditor';
import { uuid } from '@/common/utils';

type AgentRepairPanelProps = {
  agent: ManagedAgent;
  onSaved: () => void;
};

// The diagnostic banner gives the page context: what state the agent is in,
// why, and which field below to act on. It also corrects the common
// misconception that "online" means "ready to use" — online only means a
// connection handshake succeeded, not that the agent is logged in/authorized.
type DiagnosticBanner = {
  type: 'success' | 'warning' | 'error' | 'info';
  title: string;
  content: string;
};

const resolveDiagnosticBanner = (t: ReturnType<typeof useTranslation>['t'], agent: ManagedAgent): DiagnosticBanner => {
  const diagnostics = formatManagedAgentDiagnosticMessage(t, agent);
  switch (agent.status) {
    case 'missing':
      return {
        type: 'error',
        title: t('settings.repair.missingTitle'),
        content: diagnostics || t('settings.repair.missingHint'),
      };
    case 'offline':
      return {
        type: 'warning',
        title: t('settings.repair.offlineTitle'),
        content: diagnostics || t('settings.repair.offlineHint'),
      };
    case 'online':
      return {
        type: 'success',
        title: t('settings.repair.onlineTitle'),
        content: t('settings.repair.onlineHint'),
      };
    default:
      // 'unchecked' (never connection-tested) and any future/unknown status.
      // Must NOT fall through to the success banner — that would claim the
      // agent is "connected" when we have never probed it (the list correctly
      // shows it as unchecked, so the two views would disagree otherwise).
      return {
        type: 'info',
        title: t('settings.repair.uncheckedTitle'),
        content: t('settings.repair.uncheckedHint'),
      };
  }
};

const showSaveAndTestResult = (t: ReturnType<typeof useTranslation>['t'], result: ManagedAgent) => {
  switch (result.status) {
    case 'online':
      Message.success(t('settings.agentManagement.testConnectionOnline', { name: result.name }));
      break;
    case 'missing':
      Message.warning(t('settings.agentManagement.testConnectionMissing', { name: result.name }));
      break;
    case 'offline':
      Message.warning(
        formatManagedAgentDiagnosticMessage(t, result) ||
          (result.last_check_error_code === 'auth_required'
            ? t('settings.agentManagement.testConnectionAuth', { name: result.name })
            : t('settings.agentManagement.testConnectionOffline', { name: result.name }))
      );
      break;
    default:
      break;
  }
};

const AgentRepairPanel: React.FC<AgentRepairPanelProps> = ({ agent, onSaved }) => {
  const { t } = useTranslation();
  const [commandOverride, setCommandOverride] = useState('');
  const [envRows, setEnvRows] = useState<EnvVarRow[]>([]);
  const [isSaving, setIsSaving] = useState(false);
  const [runtimeInfo, setRuntimeInfo] = useState<CliRuntimeInfo | null>(null);
  const [runtimeSelection, setRuntimeSelection] = useState<CliRuntimeSelection>('managed');
  const [runtimeLoading, setRuntimeLoading] = useState(false);
  const [runtimeAction, setRuntimeAction] = useState<'apply' | 'update' | 'rollback' | null>(null);
  const [error, setError] = useState('');
  const savingRef = useRef(false);
  const initialHasOverridesRef = useRef(false);
  const isInternalAionCli = agent.agent_type === 'aionrs' && agent.agent_source === 'internal';
  const cliName = agent.backend?.toLowerCase();
  const isManagedCli = cliName === 'claude' || cliName === 'codex';

  // Load current overrides on mount. The repair page is itself the explicit
  // entry point, so there's no separate unlock step.
  useEffect(() => {
    if (isInternalAionCli) return;

    let cancelled = false;
    void (async () => {
      setRuntimeLoading(isManagedCli);
      try {
        const [overrides, loadedRuntime] = await Promise.all([
          acpConversation.getAgentOverrides.invoke({ id: agent.id }),
          isManagedCli && cliName ? systemSettings.getCliRuntime.invoke({ name: cliName }) : Promise.resolve(null),
        ]);
        if (cancelled) return;
        const loadedCommandOverride = overrides.command_override || '';
        const loadedEnvOverride = overrides.env_override || [];
        initialHasOverridesRef.current =
          Boolean(loadedCommandOverride.trim()) || loadedEnvOverride.some((env) => Boolean(env.name.trim()));
        setCommandOverride(loadedCommandOverride);
        setEnvRows(loadedEnvOverride.map((env) => ({ id: uuid(), key: env.name, value: env.value })));
        if (loadedRuntime) {
          if (!loadedRuntime.selection_explicit && loadedCommandOverride.trim()) {
            setRuntimeSelection('custom');
            setRuntimeInfo({
              ...loadedRuntime,
              selection: 'custom',
              available: agent.installed,
              resolved_path: loadedCommandOverride,
              version: undefined,
            });
          } else {
            setRuntimeInfo(loadedRuntime);
            setRuntimeSelection(loadedRuntime.selection);
            if (loadedRuntime.selection === 'custom') {
              setCommandOverride(loadedRuntime.resolved_path || '');
            }
          }
        }
      } catch (err) {
        if (cancelled) return;
        console.error('Failed to fetch agent overrides:', err);
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        if (!cancelled) setRuntimeLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [agent.id, agent.installed, cliName, isInternalAionCli, isManagedCli]);

  const handleReset = useCallback(() => {
    setCommandOverride('');
  }, []);

  const handleSave = useCallback(async () => {
    if (savingRef.current || isSaving) return;

    // Check for duplicate keys
    const keys = envRows.map((row) => row.key.trim()).filter(Boolean);
    const uniqueKeys = new Set(keys);
    if (keys.length !== uniqueKeys.size) {
      setError(t('settings.repair.duplicateKeysError'));
      return;
    }

    const envOverride = envRows
      .filter((row) => row.key.trim())
      .map((row) => ({ name: row.key.trim(), value: row.value }));
    const hasCurrentOverrides = (!isManagedCli && Boolean(commandOverride.trim())) || envOverride.length > 0;
    if (!hasCurrentOverrides && !initialHasOverridesRef.current) {
      setError(t('settings.repair.emptyOverridesError'));
      return;
    }

    savingRef.current = true;
    setIsSaving(true);
    setError('');

    try {
      // Backend uses whole-replace semantics: setAgentOverrides overwrites BOTH command_override
      // and env_override columns from the request body. Missing/empty/null command_override is
      // written as None (cleared), so reset-path-then-save correctly clears the override.
      const result = await acpConversation.setAgentOverrides.invoke({
        id: agent.id,
        command_override: isManagedCli ? undefined : commandOverride.trim() || undefined,
        env_override: envOverride.length > 0 ? envOverride : undefined,
      });

      showSaveAndTestResult(t, result);
      onSaved();
    } catch (err) {
      console.error('Failed to save agent overrides:', err);
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      savingRef.current = false;
      setIsSaving(false);
    }
  }, [agent.id, commandOverride, envRows, isManagedCli, isSaving, onSaved, t]);

  const handleRuntimeAction = useCallback(
    async (action: 'apply' | 'update' | 'rollback') => {
      if (!cliName || runtimeAction) return;
      setRuntimeAction(action);
      setError('');
      try {
        let result: CliRuntimeInfo;
        if (action === 'apply') {
          result = await systemSettings.setCliRuntimeSelection.invoke({
            name: cliName,
            selection: runtimeSelection,
            custom_path: runtimeSelection === 'custom' ? commandOverride.trim() : undefined,
          });
          const envOverride = envRows
            .filter((row) => row.key.trim())
            .map((row) => ({ name: row.key.trim(), value: row.value }));
          await acpConversation.setAgentOverrides.invoke({
            id: agent.id,
            command_override: undefined,
            env_override: envOverride.length > 0 ? envOverride : undefined,
          });
          initialHasOverridesRef.current = envOverride.length > 0;
        } else if (action === 'update') {
          result = await systemSettings.updateCliRuntime.invoke({ name: cliName });
        } else {
          result = await systemSettings.rollbackCliRuntime.invoke({ name: cliName });
        }
        setRuntimeInfo(result);
        setRuntimeSelection(result.selection);
        Message.success(
          t(
            action === 'apply'
              ? 'settings.repair.runtimeApplySuccess'
              : action === 'update'
                ? 'settings.repair.runtimeUpdateSuccess'
                : 'settings.repair.runtimeRollbackSuccess'
          )
        );
        onSaved();
      } catch (err) {
        console.error(`Failed to ${action} CLI runtime:`, err);
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        setRuntimeAction(null);
      }
    },
    [agent.id, cliName, commandOverride, envRows, onSaved, runtimeAction, runtimeSelection, t]
  );

  const banner = resolveDiagnosticBanner(t, agent);

  // A launch-path override only makes sense for direct-CLI agents. Bridge-launched
  // rows (e.g. `npx`) keep the bridge's own arguments (`-y <package> …`) in `args`;
  // pointing the launch path at a resolved binary would forward those bridge args to
  // it (e.g. `kilo.cmd -y @kilocode/cli acp`) and break startup. Never offer the
  // field for them — the backend also rejects such overrides.
  const sourceInfo = agent.agent_source_info;
  const isBridgeLaunched = Boolean(sourceInfo?.bridge_binary && sourceInfo.bridge_binary !== sourceInfo.binary_name);

  // Only surface the actionable fields (launch path, env vars, Save & Test) once
  // a check has run. While the agent is still `unchecked` we deliberately show
  // nothing but a hint pointing to Test Connection: the launch path may well be
  // correct, and env-var editing is only a last-resort fallback (we'd rather the
  // user resolve login in their terminal). Anything other than a known
  // online/offline/missing status is treated as not-yet-actionable.
  const isActionable = agent.status === 'online' || agent.status === 'offline' || agent.status === 'missing';

  // The launch-path override is only the right lever once a check has actually
  // failed: `missing` (command not found on the default path) or `offline`
  // (found but couldn't connect). For `online` it was already resolved.
  // Bridge-launched (npx) rows never expose it (their args belong to the bridge).
  const showPath = !isManagedCli && !isBridgeLaunched && (agent.status === 'missing' || agent.status === 'offline');

  const runtimeBlock = isManagedCli ? (
    <div className='rounded-8px bg-aou-2 px-12px py-12px'>
      <Typography.Text className='mb-8px block text-13px font-medium text-t-primary'>
        {t('settings.repair.runtimeTitle')}
      </Typography.Text>
      {runtimeLoading ? (
        <div className='flex min-h-72px items-center justify-center'>
          <Spin tip={t('common.loading')} />
        </div>
      ) : (
        <div className='flex flex-col gap-10px'>
          <Radio.Group
            type='button'
            value={runtimeSelection}
            onChange={(value) => setRuntimeSelection(value as CliRuntimeSelection)}
            className='[&_.arco-radio-button]:!text-t-secondary [&_.arco-radio-button.arco-radio-checked]:!text-t-primary'
            options={[
              { label: t('settings.repair.runtimeManaged'), value: 'managed' },
              { label: t('common.system'), value: 'system' },
              { label: t('settings.repair.runtimeCustom'), value: 'custom' },
            ]}
          />
          {runtimeSelection === 'custom' ? (
            <Input
              size='large'
              value={commandOverride}
              onChange={setCommandOverride}
              placeholder={t('settings.repair.runtimeCustomPlaceholder')}
            />
          ) : null}
          <div className='rounded-6px bg-aou-1 px-10px py-8px text-11px leading-18px text-t-secondary'>
            <div>
              {t('settings.repair.runtimeStatus')}: {runtimeInfo?.available ? t('common.success') : t('common.failed')}
            </div>
            <div className='break-all'>
              {t('settings.repair.runtimeResolvedPath')}:{' '}
              {runtimeInfo?.resolved_path || t('settings.repair.runtimeUnavailable')}
            </div>
            <div>
              {t('common.version')}: {runtimeInfo?.version || t('settings.repair.runtimeUnavailable')}
            </div>
            {runtimeInfo?.error ? <div className='text-status-error'>{runtimeInfo.error}</div> : null}
          </div>
          <div className='flex flex-wrap gap-8px'>
            <Button
              type='primary'
              size='small'
              className={AION_ADD_BUTTON_CLASS}
              disabled={runtimeAction !== null}
              loading={runtimeAction === 'apply'}
              onClick={() => void handleRuntimeAction('apply')}
            >
              {t('settings.repair.runtimeApply')}
            </Button>
            <Button
              size='small'
              className={AION_ADD_BUTTON_CLASS}
              disabled={runtimeAction !== null}
              loading={runtimeAction === 'update'}
              onClick={() => void handleRuntimeAction('update')}
            >
              {t('settings.repair.runtimeUpdate')}
            </Button>
            <Button
              size='small'
              className={AION_ADD_BUTTON_CLASS}
              disabled={runtimeAction !== null || !runtimeInfo?.rollback_version}
              loading={runtimeAction === 'rollback'}
              onClick={() => void handleRuntimeAction('rollback')}
            >
              {t('settings.repair.runtimeRollback')}
            </Button>
          </div>
          <Typography.Text className='text-11px leading-16px text-t-secondary'>
            {t('settings.repair.runtimeSessionPinHint')}
          </Typography.Text>
        </div>
      )}
    </div>
  ) : null;

  const pathBlock = (
    <div>
      <div className='mb-6px flex items-center justify-between'>
        <Typography.Text className='block text-13px font-medium text-t-primary'>
          {t('settings.repair.pathLabel')}
        </Typography.Text>
        <Button type='text' size='mini' onClick={handleReset} className='!h-auto !px-0 text-12px text-t-secondary'>
          {t('settings.repair.resetPath')}
        </Button>
      </div>
      <Input
        size='large'
        value={commandOverride}
        onChange={setCommandOverride}
        placeholder={t('settings.repair.pathPlaceholder', { command: agent.command || '' })}
      />
      <Typography.Text type='secondary' className='mt-4px block text-11px leading-16px text-t-tertiary'>
        {t('settings.repair.pathHelp')}
      </Typography.Text>
    </div>
  );

  const envBlock = (
    <div>
      <Typography.Text className='mb-6px block text-13px font-medium text-t-primary'>
        {t('settings.repair.envLabel')}
      </Typography.Text>
      <Typography.Text type='secondary' className='mb-6px block text-11px leading-16px text-t-tertiary'>
        {t('settings.repair.envHelp')}
      </Typography.Text>
      {/* What configuring env vars can fix — grounded in how AionUi injects them
          per-agent at spawn time. Deliberately excludes OAuth login (stored in
          the CLI's own config, not reachable via env), called out in envOauthNote. */}
      <div className='mb-8px rounded-6px bg-aou-2 px-10px py-8px'>
        <Typography.Text className='block text-11px font-medium text-t-secondary'>
          {t('settings.repair.envScenariosTitle')}
        </Typography.Text>
        <ul className='my-4px pl-16px text-11px leading-18px text-t-tertiary'>
          <li>{t('settings.repair.envScenarioApiKey')}</li>
          <li>{t('settings.repair.envScenarioBaseUrl')}</li>
          <li>{t('settings.repair.envScenarioProxy')}</li>
        </ul>
        <Typography.Text className='block text-11px leading-16px text-t-tertiary'>
          {t('settings.repair.envOauthNote')}
        </Typography.Text>
      </div>
      <EnvVarEditor value={envRows} onChange={setEnvRows} />
    </div>
  );

  return (
    <div className='mt-10px flex flex-col gap-12px rounded-10px bg-aou-1 px-12px py-12px'>
      {/* Status-aware diagnostic banner: explains where the agent stands and
          which field below to use. */}
      <Alert type={banner.type} title={banner.title} content={banner.content} className='!rounded-8px' />

      {!isInternalAionCli ? runtimeBlock : null}
      {!isInternalAionCli && isActionable && showPath ? pathBlock : null}
      {!isInternalAionCli && isActionable ? envBlock : null}

      {/* Error Alert */}
      {error && <Alert type='error' content={error} closable onClose={() => setError('')} className='!rounded-8px' />}

      {/* Save Button — only once the agent is actionable (checked). While
          unchecked we show just the banner and steer the user to Test Connection. */}
      {!isInternalAionCli && isActionable ? (
        <Button
          type='primary'
          size='large'
          disabled={isSaving}
          loading={isSaving}
          onClick={handleSave}
          className='!rounded-8px'
        >
          {t('settings.repair.saveAndTest')}
        </Button>
      ) : null}
    </div>
  );
};

export default AgentRepairPanel;
