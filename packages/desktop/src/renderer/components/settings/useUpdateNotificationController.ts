/**
 * @license
 * Copyright 2026 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */
import { ipcBridge } from '@/common';
import type { UpdateDownloadProgressEvent } from '@/common/update/updateTypes';
import { uuid } from '@/common/utils';
import { useCallback, useEffect, useReducer, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  initialUpdateNotificationState,
  updateNotificationReducer,
  type UpdateNotificationEvent,
  type UpdateNotificationOpenSource,
  type UpdateNotificationState,
} from './updateNotificationState';
import { runUpdateCheck, type CheckUpdateOutcome } from './checkForUpdatesShared';
import { isElectronDesktop } from '@/renderer/utils/platform';
import { setUpdateReadyState } from './updateReadyState';

declare const __APP_VERSION__: string;
export const UPDATE_AVAILABLE_EVENT = 'aionui-update-available';
export const formatUpdateSize = (bytes: number) =>
  bytes >= 1024 * 1024 ? `${(bytes / (1024 * 1024)).toFixed(1)} MB` : `${(bytes / 1024).toFixed(1)} KB`;
const reduceState = (state: UpdateNotificationState, event: UpdateNotificationEvent) =>
  updateNotificationReducer(state, event).state;

export const useUpdateNotificationController = () => {
  const { t } = useTranslation();
  const [state, reduce] = useReducer(reduceState, {
    ...initialUpdateNotificationState,
    currentVersion: __APP_VERSION__,
  });
  const [opening, setOpening] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const cancellationPending = useRef(false);
  const pendingDownload = useRef<ReturnType<typeof ipcBridge.update.download.invoke> | undefined>(undefined);
  const stateRef = useRef(state);
  const downloadId = useRef<string | undefined>(undefined);
  const checking = useRef(false);
  const cancelled = useRef<string | undefined>(undefined);
  const dispatch = useCallback((event: UpdateNotificationEvent) => {
    stateRef.current = reduceState(stateRef.current, event);
    reduce(event);
  }, []);
  const errorText = useCallback(
    (code?: string) => {
      switch (code) {
        case 'invalidRelease':
          return t('update.installer.invalidRelease');
        case 'verificationFailed':
          return t('update.installer.verificationFailed');
        case 'unverifiedInstaller':
          return t('update.installer.unverifiedInstaller');
        case 'openFailed':
          return t('update.installer.openFailed');
        case 'checkFailed':
          return t('update.checkFailed');
        default:
          return t('update.downloadFailed');
      }
    },
    [t]
  );
  const showOutcome = useCallback(
    (outcome: CheckUpdateOutcome) => {
      if (outcome.kind === 'error') {
        dispatch({ type: 'checkError', message: errorText(outcome.message) });
        return;
      }
      setUpdateReadyState({
        ready: false,
        available: outcome.kind === 'available',
        version: outcome.updateInfo?.version || '',
      });
      dispatch({
        type: outcome.kind === 'available' ? 'checkAvailable' : 'checkUpToDate',
        currentVersion: outcome.currentVersion,
        updateInfo: outcome.updateInfo,
        releasePageUrl: outcome.releasePageUrl,
        autoUpdateAvailable: false,
        autoUpdateInfo: null,
      });
    },
    [dispatch, errorText]
  );
  const checkForUpdates = useCallback(async () => {
    if (checking.current || stateRef.current.status === 'downloading') return;
    checking.current = true;
    dispatch({ type: 'checkStarted' });
    try {
      showOutcome(
        await runUpdateCheck({
          includePrerelease: false,
          fallbackVersion: __APP_VERSION__,
          checkFailedLabel: 'checkFailed',
        })
      );
    } finally {
      checking.current = false;
    }
  }, [dispatch, showOutcome]);

  useEffect(() => {
    if (!isElectronDesktop()) return;
    // Ignore legacy Squirrel readiness; only explicit installer actions are supported.
    setUpdateReadyState({ ready: false, version: '' });
    let disposed = false;
    const timer = setTimeout(() => {
      // Metadata only: startup failures and no-update results stay quiet.
      void runUpdateCheck({
        includePrerelease: false,
        fallbackVersion: __APP_VERSION__,
        checkFailedLabel: 'checkFailed',
      }).then((outcome) => {
        if (disposed || outcome.kind !== 'available') return;
        setUpdateReadyState({ ready: false, available: true, version: outcome.updateInfo?.version || '' });
      });
    }, 3000);
    return () => {
      disposed = true;
      clearTimeout(timer);
    };
  }, []);

  useEffect(() => {
    const open = (source: UpdateNotificationOpenSource = 'about') => {
      const current = stateRef.current.status;
      dispatch({ type: 'openRequested', source, userInitiated: true });
      if (current !== 'downloading' && current !== 'downloaded') void checkForUpdates();
    };
    const remove = ipcBridge.update.open.on((event) => open(event?.source));
    const onOpen = () => open();
    const onAvailable = (event: Event) => {
      if (['downloading', 'downloaded'].includes(stateRef.current.status)) {
        open();
        return;
      }
      const outcome = (event as CustomEvent<CheckUpdateOutcome>).detail;
      if (outcome?.kind === 'available') showOutcome(outcome);
    };
    window.addEventListener('aionui-open-update-modal', onOpen);
    window.addEventListener(UPDATE_AVAILABLE_EVENT, onAvailable);
    return () => {
      remove();
      window.removeEventListener('aionui-open-update-modal', onOpen);
      window.removeEventListener(UPDATE_AVAILABLE_EVENT, onAvailable);
    };
  }, [checkForUpdates, dispatch, showOutcome]);
  useEffect(
    () =>
      ipcBridge.update.downloadProgress.on((event: UpdateDownloadProgressEvent) => {
        dispatch({
          type: 'manualProgress',
          downloadId: event.downloadId,
          status: event.status,
          filePath: event.file_path,
          error: errorText(event.error),
          progress: {
            percent: Math.round(event.percent ?? 0),
            transferred: event.receivedBytes,
            total: event.totalBytes ?? 0,
            speed: `${formatUpdateSize(event.bytesPerSecond ?? 0)}/s`,
          },
        });
      }),
    [dispatch, errorText]
  );

  const startDownload = useCallback(async () => {
    const asset = stateRef.current.updateInfo?.recommendedAsset;
    if (!asset || cancellationPending.current || pendingDownload.current || stateRef.current.status === 'downloading')
      return;
    const id = uuid();
    downloadId.current = id;
    cancelled.current = undefined;
    dispatch({ type: 'manualDownloadStarted', downloadId: id });
    try {
      const request = ipcBridge.update.download.invoke({
        downloadId: id,
        url: asset.url,
        file_name: asset.name,
      });
      pendingDownload.current = request;
      const response = await request;
      if (!response.success || !response.data) {
        dispatch({ type: 'checkError', message: errorText(response.msg) });
        return;
      }
      downloadId.current = response.data.downloadId;
      if (cancelled.current === id) return;
      dispatch({
        type: 'manualDownloadReady',
        downloadId: response.data.downloadId,
        filePath: response.data.file_path,
      });
    } catch {
      dispatch({ type: 'checkError', message: errorText() });
    } finally {
      pendingDownload.current = undefined;
    }
  }, [dispatch, errorText]);
  const cancelDownload = useCallback(async () => {
    const id = downloadId.current;
    if (!id || cancellationPending.current) return;
    cancelled.current = id;
    cancellationPending.current = true;
    setCancelling(true);
    try {
      // Wait for the host's actual ID before cancelling; no retry may bind to the old transfer.
      const started = await pendingDownload.current;
      if (started && (!started.success || !started.data)) throw new Error('downloadFailed');
      const response = await ipcBridge.update.cancelDownload.invoke({ downloadId: started?.data?.downloadId || id });
      if (!response.success) throw new Error('downloadFailed');
      dispatch({ type: 'cancelDownloadRequested' });
    } catch {
      dispatch({ type: 'checkError', message: errorText() });
    } finally {
      cancellationPending.current = false;
      setCancelling(false);
    }
  }, [dispatch, errorText]);
  const openFile = useCallback(async () => {
    if (!downloadId.current || opening) return;
    setOpening(true);
    try {
      const result = await ipcBridge.update.openInstaller.invoke({ downloadId: downloadId.current });
      if (!result.success) dispatch({ type: 'checkError', message: errorText(result.msg) });
    } catch {
      dispatch({ type: 'checkError', message: errorText('openFailed') });
    } finally {
      setOpening(false);
    }
  }, [dispatch, errorText, opening]);
  const openReleasePage = useCallback(() => {
    if (stateRef.current.releasePageUrl) void ipcBridge.shell.openExternal.invoke(stateRef.current.releasePageUrl);
  }, []);
  return {
    state,
    opening,
    cancelling,
    versionLabel: state.updateInfo?.version || '',
    showManualInstallFallback: false,
    actions: {
      checkForUpdates,
      openReleasePage,
      startDownload,
      startManualInstallDownload: startDownload,
      openFile,
      quitAndInstall: openFile,
      showInFolder: () => {
        if (state.downloadPath) void ipcBridge.shell.showItemInFolder.invoke(state.downloadPath);
      },
      viewInstallerLastFailureLog: () => {},
      dismiss: (reason: 'later' | 'close') => dispatch({ type: 'dismissRequested', reason }),
      cancelDownload,
      minimize: () => dispatch({ type: 'minimizeRequested' }),
      restore: () => dispatch({ type: 'restoreRequested' }),
    },
  };
};
