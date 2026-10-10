import { describe, expect, it, vi } from 'vitest';
import {
  parseComputerUsePermissionSummary,
  runComputerUsePermissionDoctor,
} from '../../../packages/desktop/src/process/backend/computerUsePermissions';

describe('Computer Use permission doctor', () => {
  it('parses granted permissions without reporting onboarding', () => {
    expect(parseComputerUsePermissionSummary('Permissions: accessibility=granted, screenRecording=granted\n')).toEqual({
      supported: true,
      platform: 'darwin',
      accessibility: 'granted',
      screenRecording: 'granted',
      onboardingOpened: false,
    });
  });

  it('reports onboarding when either permission is missing', () => {
    expect(
      parseComputerUsePermissionSummary('Permissions: accessibility=missing, screenRecording=granted\n')
    ).toMatchObject({ accessibility: 'missing', screenRecording: 'granted', onboardingOpened: true });
  });

  it('rejects output that does not prove both permission states', () => {
    expect(() => parseComputerUsePermissionSummary('Permissions unavailable')).toThrow('unrecognized');
  });

  it('uses the resolved bundled runtime and doctor command on macOS', async () => {
    const execute = vi.fn().mockResolvedValue({
      stdout: 'Permissions: accessibility=granted, screenRecording=missing\n',
      stderr: '',
    });

    const result = await runComputerUsePermissionDoctor({
      entryPath: '/bundled/OpenComputerUse',
      platform: 'darwin',
      execute,
    });

    expect(execute).toHaveBeenCalledWith('/bundled/OpenComputerUse', ['doctor']);
    expect(result).toMatchObject({ screenRecording: 'missing', onboardingOpened: true });
  });

  it('does not launch a runtime on unsupported platforms', async () => {
    const execute = vi.fn();

    const result = await runComputerUsePermissionDoctor({ platform: 'linux', execute });

    expect(result).toMatchObject({ supported: false, platform: 'linux' });
    expect(execute).not.toHaveBeenCalled();
  });
});
