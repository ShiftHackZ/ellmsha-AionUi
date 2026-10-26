import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { mutate } from 'swr';
import type { CopilotIdeAction, CopilotIdeStatus } from '@/common/types/platform/electron';

/** Keep native lifecycle status fresh; only explicit actions start the runtime. */
export function useCopilotIde() {
  const { t } = useTranslation();
  const [status, setStatus] = useState<CopilotIdeStatus>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const api = window.electronAPI?.copilotIde;
  useEffect(() => {
    if (!api) return;
    let alive = true;
    const refresh = () => {
      void api('status')
        .then((value) => {
          if (alive) setStatus(value);
        })
        .catch(() => {
          if (alive) setError(t('settings.copilotIde.failed'));
        });
    };
    refresh();
    const timer = setInterval(refresh, 3000);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, [api, t]);
  const act = async (action: CopilotIdeAction) => {
    if (!api) return;
    setBusy(true);
    setError('');
    try {
      setStatus(await api(action));
      await Promise.all([mutate('providers'), mutate('agents.managed'), mutate('assistants.list')]);
    } catch (failure) {
      setError(`${t('settings.copilotIde.failed')}: ${failure instanceof Error ? failure.message : 'unknown'}`);
    } finally {
      setBusy(false);
    }
  };
  return { status, busy, error, act, available: Boolean(api) };
}
