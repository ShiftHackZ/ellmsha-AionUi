/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { getRoutingSnapshot } from '@/common/types/agent/routerTypes';
import { useRouterConversation } from '@/renderer/components/agent/AutoRouter/useRouter';
import type { IProvider, TProviderWithModel } from '@/common/config/storage';
import { useModelProviderList } from '@/renderer/hooks/agent/useModelProviderList';
import { useCallback, useEffect, useMemo, useState } from 'react';

export type AionrsModelSelection = {
  locked?: boolean;
  current_model?: TProviderWithModel;
  providers: IProvider[];
  getAvailableModels: (provider: IProvider) => string[];
  handleSelectModel: (provider: IProvider, modelName: string) => Promise<void>;
  getDisplayModelName: (modelName?: string) => string;
};

export type UseAionrsModelSelectionOptions = {
  conversationId?: string;
  initialModel: TProviderWithModel | undefined;
  onSelectModel: (provider: IProvider, modelName: string) => Promise<boolean>;
};

export const useAionrsModelSelection = ({
  initialModel,
  conversationId,
  onSelectModel,
}: UseAionrsModelSelectionOptions): AionrsModelSelection => {
  const { data: conversation } = useRouterConversation(conversationId);
  const locked = Boolean(getRoutingSnapshot(conversation?.extra));
  const [current_model, setCurrentModel] = useState<TProviderWithModel | undefined>(initialModel);

  useEffect(() => {
    setCurrentModel(initialModel);
  }, [initialModel?.id, initialModel?.use_model]);

  const { providers: allProviders, getAvailableModels, formatModelLabel } = useModelProviderList();

  // AionCore does not support Google Auth — filter it out
  const providers = useMemo(
    () => allProviders.filter((p) => !p.platform?.toLowerCase().includes('gemini-with-google-auth')),
    [allProviders]
  );

  const handleSelectModel = useCallback(
    async (provider: IProvider, modelName: string) => {
      if (locked) return;
      const selected = {
        ...(provider as unknown as TProviderWithModel),
        use_model: modelName,
      } as TProviderWithModel;
      const ok = await onSelectModel(provider, modelName);
      if (ok) {
        setCurrentModel(selected);
      }
    },
    [locked, onSelectModel]
  );

  const getDisplayModelName = useCallback(
    (modelName?: string) => {
      if (!modelName) return '';
      const label = formatModelLabel(current_model, modelName);
      const maxLength = 20;
      return label.length > maxLength ? `${label.slice(0, maxLength)}...` : label;
    },
    [current_model, formatModelLabel]
  );

  return {
    locked,
    current_model,
    providers,
    getAvailableModels,
    handleSelectModel,
    getDisplayModelName,
  };
};
