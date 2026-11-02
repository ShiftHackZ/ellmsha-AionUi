import React from 'react';
import { act, cleanup, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useTerminal } from '@/renderer/pages/conversation/Preview/components/Terminal/useTerminal';
import { ipcBridge } from '@/common';
const engine = vi.hoisted(() => ({ input: (_data: string) => {}, write: vi.fn(), reset: vi.fn(), dispose: vi.fn() }));
vi.mock('@xterm/xterm', () => ({
  Terminal: class {
    options = {};
    loadAddon() {}
    open() {}
    resize() {}
    onData(fn: (data: string) => void) {
      engine.input = fn;
      return { dispose: vi.fn() };
    }
    write(data: Uint8Array, done: () => void) {
      engine.write(data);
      done();
    }
    reset() {
      engine.reset();
    }
    dispose() {
      engine.dispose();
    }
  },
}));
vi.mock('@xterm/addon-fit', () => ({
  FitAddon: class {
    proposeDimensions() {
      return { rows: 24, cols: 80 };
    }
  },
}));
vi.mock('@/common', () => ({
  ipcBridge: {
    backgroundProcess: {
      output: { invoke: vi.fn() },
      input: { invoke: vi.fn() },
      resize: { invoke: vi.fn() },
      stop: { invoke: vi.fn() },
    },
  },
}));
function View({ error }: { error: () => void }) {
  const ref = useTerminal('chat', 'opaque', 0, error);
  return <div ref={ref} />;
}
beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      disconnect() {}
    }
  );
  vi.mocked(ipcBridge.backgroundProcess.output.invoke).mockResolvedValue({
    data: btoa('\x1b[31mready'),
    next_offset: 10,
    reset: true,
    running: true,
    input_revision: 0,
    rows: 24,
    cols: 80,
    screen_revision: 3,
  });
  vi.mocked(ipcBridge.backgroundProcess.input.invoke).mockResolvedValue({} as never);
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});
describe('shared terminal transport', () => {
  it('renders binary-safe VT data and resumes by byte and resize revisions', async () => {
    render(<View error={vi.fn()} />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });
    expect(Array.from(engine.write.mock.calls[0][0])).toEqual(Array.from(new TextEncoder().encode('\x1b[31mready')));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(101);
    });
    expect(ipcBridge.backgroundProcess.output.invoke).toHaveBeenLastCalledWith({
      conversation_id: 'chat',
      process_id: 'opaque',
      after: 10,
      screen_revision: 3,
    });
  });
  it('sends human keyboard input in order to that same session and detaches without closing it', async () => {
    const view = render(<View error={vi.fn()} />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
      engine.input('pwd');
      engine.input('\r');
    });
    expect(vi.mocked(ipcBridge.backgroundProcess.input.invoke).mock.calls.map(([call]) => call)).toEqual([
      { conversation_id: 'chat', process_id: 'opaque', data: 'pwd' },
      { conversation_id: 'chat', process_id: 'opaque', data: '\r' },
    ]);
    view.unmount();
    expect(ipcBridge.backgroundProcess.stop.invoke).not.toHaveBeenCalled();
    expect(engine.dispose).toHaveBeenCalledTimes(1);
  });
  it('fails closed after an uncertain write without retrying or sending queued Enter', async () => {
    const error = vi.fn();
    vi.mocked(ipcBridge.backgroundProcess.input.invoke).mockRejectedValueOnce(new Error('connection lost'));
    render(<View error={error} />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
      engine.input('dangerous partial');
      engine.input('\r');
    });
    expect(error).toHaveBeenCalled();
    expect(ipcBridge.backgroundProcess.input.invoke).toHaveBeenCalledTimes(1);
    await act(async () => {
      engine.input('more');
      await vi.advanceTimersByTimeAsync(500);
    });
    expect(ipcBridge.backgroundProcess.input.invoke).toHaveBeenCalledTimes(1);
  });
});
