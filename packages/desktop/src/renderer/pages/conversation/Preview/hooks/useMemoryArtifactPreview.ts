import { ipcBridge } from '@/common';
import { Message } from '@arco-design/web-react';
import { useCallback, useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { usePreviewContext } from '../context/PreviewContext';

export function useMemoryArtifactPreview(conversationId?: string) {
  const { openPreview } = usePreviewContext();
  const { t } = useTranslation();
  const requestGeneration = useRef(0);
  useEffect(
    () => () => {
      requestGeneration.current += 1;
    },
    [conversationId]
  );
  return useCallback(
    async (path: string) => {
      if (!conversationId) return;
      const generation = ++requestGeneration.current;
      try {
        const artifact = await ipcBridge.conversation.readMemoryArtifact.invoke({
          conversation_id: conversationId,
          path,
        });
        if (generation !== requestGeneration.current) return;
        openPreview(
          artifact.content,
          'markdown',
          {
            title: artifact.title,
            editable: false,
            memoryArtifact: { conversationId, path: artifact.path },
          },
          { replace: true }
        );
      } catch {
        if (generation !== requestGeneration.current) return;
        Message.error(t('preview.memoryArtifactUnavailable'));
      }
    },
    [conversationId, openPreview, t]
  );
}
