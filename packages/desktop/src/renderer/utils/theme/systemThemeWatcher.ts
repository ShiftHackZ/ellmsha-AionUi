/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { configService } from '@/common/config/configService';
import { SYSTEM_THEME_ID } from '@/common/theme/constants';
import { setActiveTheme } from './applyTheme';
import { watchSystemPrefersDark } from './systemAppearance';

/**
 * While "Follow System" is the active selection, re-resolve and re-apply the theme
 * whenever the OS appearance changes. Reuses the normal select pipeline, so the
 * change persists and reaches the active platform's theme consumers. Returns an unsubscribe function.
 */
export function startSystemThemeWatcher(
  applySystemTheme: () => Promise<unknown> = () => setActiveTheme(SYSTEM_THEME_ID)
): () => void {
  return watchSystemPrefersDark(() => {
    const activeId = configService.get('theme.activeId') as string | undefined;
    if (activeId !== SYSTEM_THEME_ID) return;
    void applySystemTheme().catch((e) => console.error('re-apply system theme failed', e));
  });
}
