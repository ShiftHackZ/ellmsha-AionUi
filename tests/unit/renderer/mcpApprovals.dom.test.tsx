import React from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SWRConfig } from 'swr';
import McpApprovals from '@/renderer/pages/settings/ToolsSettings/McpApprovals';
const mocks = vi.hoisted(() => ({ list: vi.fn(), revoke: vi.fn(), error: vi.fn() }));
vi.mock('@/common', () => ({
  ipcBridge: { mcpService: { listApprovals: { invoke: mocks.list }, revokeApproval: { invoke: mocks.revoke } } },
}));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('@arco-design/web-react', () => ({
  Button: ({
    loading,
    children,
    ...props
  }: React.ButtonHTMLAttributes<HTMLButtonElement> & { loading?: boolean; size?: string }) => (
    <button {...props} disabled={props.disabled || loading}>
      {children}
    </button>
  ),
  Alert: ({ content }: { content: string }) => <div role='alert'>{content}</div>,
  Spin: () => <span>Loading</span>,
  Message: { error: mocks.error },
}));
const mount = () =>
  render(
    <SWRConfig value={{ provider: () => new Map(), shouldRetryOnError: false }}>
      <McpApprovals />
    </SWRConfig>
  );
beforeEach(() => vi.resetAllMocks());
afterEach(cleanup);
describe('saved MCP permissions', () => {
  it('lists exact server/tool grants and revokes only the selected id', async () => {
    mocks.list.mockResolvedValue([{ id: 'owned-grant', server: 'fixture', tool: 'read' }]);
    let finish!: (value: unknown) => void;
    mocks.revoke.mockReturnValue(
      new Promise((resolve) => {
        finish = resolve;
      })
    );
    mount();
    const button = await screen.findByRole('button', { name: 'tools.approvals.revoke' });
    fireEvent.click(button);
    expect(mocks.revoke).toHaveBeenCalledWith({ id: 'owned-grant' });
    expect(button).toBeDisabled();
    finish({ revoked: true });
    expect(await screen.findByText('tools.approvals.empty')).toBeInTheDocument();
  });
  it('keeps a failed revocation visible and provides a retryable list error', async () => {
    mocks.list.mockResolvedValueOnce([{ id: 'owned-grant', server: 'fixture', tool: 'read' }]);
    mocks.revoke.mockRejectedValue(new Error('private server body'));
    mount();
    fireEvent.click(await screen.findByRole('button', { name: 'tools.approvals.revoke' }));
    await waitFor(() => expect(mocks.error).toHaveBeenCalledWith('tools.approvals.revokeFailed'));
    expect(screen.getByRole('button', { name: 'tools.approvals.revoke' })).not.toBeDisabled();
    mocks.list.mockRejectedValueOnce(new Error('private token'));
    fireEvent.click(screen.getByRole('button', { name: 'common.refresh' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('tools.approvals.loadFailed');
    expect(document.body.textContent).not.toContain('private');
  });
});
