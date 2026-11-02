import React from 'react';
import { Message } from '@arco-design/web-react';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import WorkspaceOpenButton from '@/renderer/pages/conversation/components/ChatLayout/WorkspaceOpenButton';
const terminal = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
vi.mock('@/renderer/utils/platform', () => ({ isElectronDesktop: () => false }));
vi.mock('@/renderer/pages/conversation/Preview/context/PreviewContext', () => ({
  useOptionalPreviewContext: () => ({ openTerminalTab: terminal, openBrowserTab: vi.fn() }),
}));
vi.mock('@/common', () => ({
  ipcBridge: { shell: { checkToolInstalled: { invoke: vi.fn() }, openFolderWith: { invoke: vi.fn() } } },
}));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
afterEach(() => {
  cleanup();
  localStorage.clear();
  vi.clearAllMocks();
});
describe('shared terminal launcher in WebUI', () => {
  it.each([false, true])(
    'opens an integrated terminal for a project or temporary chat (temporary=%s)',
    async (temporary) => {
      render(<WorkspaceOpenButton workspacePath='/server/workspace' isTemporary={temporary} />);
      const buttons = screen.getAllByRole('button');
      fireEvent.click(buttons[0]);
      await vi.waitFor(() => expect(terminal).toHaveBeenCalledTimes(1));
      expect(terminal).toHaveBeenCalledWith();
    }
  );
  it('shows a visible error when the owning workspace cannot start a terminal', async () => {
    const toast = vi.spyOn(Message, 'error').mockImplementation(() => undefined as never);
    vi.spyOn(console, 'error').mockImplementation(() => {});
    terminal.mockRejectedValueOnce(new Error('fixture unavailable'));
    render(<WorkspaceOpenButton workspacePath='/server/workspace' isTemporary />);
    fireEvent.click(screen.getAllByRole('button')[0]);
    await vi.waitFor(() => expect(toast).toHaveBeenCalledWith('preview.terminal.unavailable'));
    vi.restoreAllMocks();
  });
});
