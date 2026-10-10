import { execFile } from 'node:child_process';

import type { IComputerUsePermissionStatus } from '@/common/adapter/ipcBridge';

const DOCTOR_TIMEOUT_MS = 15_000;
const DOCTOR_MAX_BUFFER_BYTES = 32 * 1024;
const PERMISSION_SUMMARY_PATTERN =
  /(?:^|\n)Permissions: accessibility=(granted|missing), screenRecording=(granted|missing)(?:\n|$)/;

export type ComputerUseDoctorExecutor = (
  entryPath: string,
  args: string[]
) => Promise<{ stdout: string; stderr: string }>;

const executeDoctor: ComputerUseDoctorExecutor = (entryPath, args) =>
  new Promise((resolve, reject) => {
    execFile(
      entryPath,
      args,
      {
        encoding: 'utf8',
        timeout: DOCTOR_TIMEOUT_MS,
        maxBuffer: DOCTOR_MAX_BUFFER_BYTES,
      },
      (error, stdout, stderr) => {
        if (error) {
          reject(error);
          return;
        }
        resolve({ stdout, stderr });
      }
    );
  });

export function parseComputerUsePermissionSummary(stdout: string): IComputerUsePermissionStatus {
  const match = PERMISSION_SUMMARY_PATTERN.exec(stdout);
  if (!match) {
    throw new Error('Open Computer Use returned an unrecognized permission status.');
  }

  const accessibility = match[1] as 'granted' | 'missing';
  const screenRecording = match[2] as 'granted' | 'missing';
  return {
    supported: true,
    platform: 'darwin',
    accessibility,
    screenRecording,
    onboardingOpened: accessibility === 'missing' || screenRecording === 'missing',
  };
}

export async function runComputerUsePermissionDoctor(options: {
  entryPath?: string;
  platform?: NodeJS.Platform;
  execute?: ComputerUseDoctorExecutor;
}): Promise<IComputerUsePermissionStatus> {
  const platform = options.platform ?? process.platform;
  if (platform !== 'darwin') {
    return {
      supported: false,
      platform,
      accessibility: 'unknown',
      screenRecording: 'unknown',
      onboardingOpened: false,
    };
  }

  const entryPath = options.entryPath?.trim();
  if (!entryPath) {
    throw new Error('Open Computer Use runtime is unavailable.');
  }

  const result = await (options.execute ?? executeDoctor)(entryPath, ['doctor']);
  return parseComputerUsePermissionSummary(result.stdout);
}
