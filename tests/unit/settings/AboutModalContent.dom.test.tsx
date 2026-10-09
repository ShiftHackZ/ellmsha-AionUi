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
  });
  it('opens original upstream repositories', () => {
    render(<AboutModalContent />);
    for (const component of harnessRelease.components) {
      fireEvent.click(screen.getByRole('button', { name: component.name }));
      expect(openExternalUrl).toHaveBeenLastCalledWith(component.url);
    }
  });
});
