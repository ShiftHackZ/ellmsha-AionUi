import { describe, expect, it } from 'vitest';
import { createInstance } from 'i18next';
import fs from 'node:fs';
import path from 'node:path';

describe('Notion translations', () => {
  const root = path.resolve('packages/desktop/src/renderer/services/i18n/locales');
  for (const locale of fs.readdirSync(root).filter((entry) => fs.existsSync(path.join(root, entry, 'settings.json')))) {
    it(`resolves nested account controls without fallback: ${locale}`, async () => {
      const settings = JSON.parse(fs.readFileSync(path.join(root, locale, 'settings.json'), 'utf8'));
      const i18n = createInstance();
      await i18n.init({ lng: locale, fallbackLng: false, resources: { [locale]: { translation: { settings } } } });
      for (const key of [
        'accounts',
        'connectTitle',
        'connectHelp',
        'description',
        'connect',
        'reconnect',
        'disconnect',
        'disconnectConfirm',
        'enableFirst',
        'authorizing',
        'loadFailed',
        'connectionFailed',
        'empty',
        'selectionHelp',
        'status.connected',
        'status.disconnected',
        'status.connecting',
        'status.reconnect_required',
        'status.error',
      ]) {
        const full = `settings.notion.${key}`;
        expect(i18n.exists(full)).toBe(true);
        expect(i18n.t(full)).not.toBe(full);
        expect(i18n.t(full).trim().length).toBeGreaterThan(0);
      }
    });
  }
});
