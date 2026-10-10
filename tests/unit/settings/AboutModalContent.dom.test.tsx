import React from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { harnessRelease, harnessVersion } from '@/common/branding';
import packageJson from '../../../package.json';
import AboutModalContent from '@/renderer/components/settings/SettingsModal/contents/AboutModalContent';
import { openExternalUrl } from '@/renderer/utils/platform';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, params?: Record<string, unknown>) => `${key} ${params?.version ?? params?.patch ?? ''}`.trim(),
  }),
}));
vi.mock('@/renderer/utils/platform', () => ({ openExternalUrl: vi.fn().mockResolvedValue(undefined) }));
afterEach(cleanup);

describe('eLLMsha About', () => {
  it('shows the harness release and component provenance without update controls', () => {
    render(<AboutModalContent />);
    expect(screen.getByText(harnessVersion)).toBeInTheDocument();
    expect(packageJson.version).toBe(`${harnessRelease.version}-patch.${harnessRelease.patch}`);
    expect(screen.queryByRole('button', { name: /checkForUpdates/ })).not.toBeInTheDocument();
    for (const component of harnessRelease.components) {
      expect(screen.getByText(`settings.upstreamVersion ${component.upstream}`)).toBeInTheDocument();
    }
    expect(harnessRelease.components.find((component) => component.name === 'Mobile MCP')).toEqual({
      name: 'Mobile MCP',
      url: 'https://github.com/mobile-next/mobile-mcp',
      upstream: 'v1.0.8',
      commit: '65953016441e1f519d47c98d7bcc742647249c95',
      patch: 2,
    });
    expect(harnessRelease.components.find((component) => component.name === 'Chrome DevTools MCP')).toEqual({
      name: 'Chrome DevTools MCP',
      url: 'https://github.com/ChromeDevTools/chrome-devtools-mcp',
      upstream: 'chrome-devtools-mcp-v0.16.0',
      commit: '4f7b06898327ab5be42c85bd98bd176f33d55d89',
      patch: 2,
    });
    expect(harnessRelease.components.find((component) => component.name === 'Open Computer Use')).toEqual({
      name: 'Open Computer Use',
      url: 'https://github.com/iFurySt/open-codex-computer-use',
      forkUrl: 'https://github.com/ShiftHackZ/ellmsha-open-codex-computer-use',
      upstream: '0.3.6',
      commit: '83a521e546102564efd002f61a6763912081e5c7',
      patch: 0,
    });
    expect(harnessRelease.components.find((component) => component.name === 'AionRS')).toMatchObject({
      url: 'https://github.com/iOfficeAI/aionrs',
      forkUrl: 'https://github.com/ShiftHackZ/ellmsha-aionrs',
      commit: '4bd4f3254f6d875f122b648dd55116516c380d31',
    });
  });
  it('opens original upstream repositories', () => {
    render(<AboutModalContent />);
    for (const component of harnessRelease.components) {
      fireEvent.click(screen.getByRole('button', { name: component.name }));
      expect(openExternalUrl).toHaveBeenLastCalledWith(component.forkUrl ?? component.url);
    }
  });
  it('links forked components to their exact upstream source', () => {
    render(<AboutModalContent />);
    const component = harnessRelease.components.find((entry) => entry.name === 'Open Computer Use');
    if (!component?.forkUrl) throw new Error('Open Computer Use fork provenance is missing');
    fireEvent.click(screen.getByText(`settings.upstreamVersion ${component.upstream}`));
    expect(openExternalUrl).toHaveBeenLastCalledWith(component.url);
  });
});
