import React from 'react';
import { createRoot } from 'react-dom/client';
import { createInstance } from 'i18next';
import { I18nextProvider } from 'react-i18next';
import SecurityKeyDialog from './index';
import type { SecurityKeyAction, SecurityKeyDialogState } from '@/common/types/browserWebAuthn';
import '@arco-design/web-react/dist/css/arco.css';
import '@/renderer/styles/themes/index.css';
import en from '@/renderer/services/i18n/locales/en-US/settings.json';
import zh from '@/renderer/services/i18n/locales/zh-CN/settings.json';
import tw from '@/renderer/services/i18n/locales/zh-TW/settings.json';
import ja from '@/renderer/services/i18n/locales/ja-JP/settings.json';
import ko from '@/renderer/services/i18n/locales/ko-KR/settings.json';
import tr from '@/renderer/services/i18n/locales/tr-TR/settings.json';
import ru from '@/renderer/services/i18n/locales/ru-RU/settings.json';
import uk from '@/renderer/services/i18n/locales/uk-UA/settings.json';
import pt from '@/renderer/services/i18n/locales/pt-BR/settings.json';
import de from '@/renderer/services/i18n/locales/de-DE/settings.json';
import es from '@/renderer/services/i18n/locales/es-ES/settings.json';
import fr from '@/renderer/services/i18n/locales/fr-FR/settings.json';
import fa from '@/renderer/services/i18n/locales/fa-IR/settings.json';

const api = (
  window as unknown as {
    securityKeyAPI: {
      status: (status: 'ready' | 'failed') => void;
      state: () => Promise<SecurityKeyDialogState>;
      onState: (listener: (s: SecurityKeyDialogState) => void) => () => void;
      respond: (action: SecurityKeyAction) => void;
    };
  }
).securityKeyAPI;
const failed = () => api.status('failed');
const ready = () => api.status('ready');
window.addEventListener('error', failed);
window.addEventListener('unhandledrejection', failed);
const language = createInstance();
const data = {
  'en-US': en,
  'zh-CN': zh,
  'zh-TW': tw,
  'ja-JP': ja,
  'ko-KR': ko,
  'tr-TR': tr,
  'ru-RU': ru,
  'uk-UA': uk,
  'pt-BR': pt,
  'de-DE': de,
  'es-ES': es,
  'fr-FR': fr,
  'fa-IR': fa,
};
const root = createRoot(document.getElementById('root')!, { onUncaughtError: failed });
void language
  .init({
    fallbackLng: 'en-US',
    resources: Object.fromEntries(
      Object.entries(data).map(([locale, settings]) => [locale, { translation: { settings } }])
    ),
    interpolation: { escapeValue: false },
  })
  .then(() => {
    const render = (state: SecurityKeyDialogState) => {
      if (!state) return;
      document.body.setAttribute('arco-theme', state.dark ? 'dark' : 'light');
      document.documentElement.setAttribute('data-theme', state.dark ? 'dark' : 'light');
      void language.changeLanguage(state.language).then(() =>
        root.render(
          <I18nextProvider i18n={language}>
            <SecurityKeyDialog state={state} respond={api.respond} onReady={ready} />
          </I18nextProvider>
        )
      );
    };
    api.onState(render);
    void api.state().then(render);
  })
  .catch(failed);
