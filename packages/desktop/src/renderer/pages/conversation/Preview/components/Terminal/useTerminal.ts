import { ipcBridge } from '@/common';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { useEffect, useRef } from 'react';
import '@xterm/xterm/css/xterm.css';

/** One emulator attaches to the Core-owned PTY; unmount only detaches the view. */
export function useTerminal(conversationId: string, processId: string, generation: number, onError: () => void) {
  const container = useRef<HTMLDivElement>(null);
  const failure = useRef(onError);
  failure.current = onError;
  useEffect(() => {
    if (!container.current) return;
    const host = container.current;
    const terminal = new Terminal({ cursorBlink: true, scrollback: 2000, fontSize: 13, screenReaderMode: true });
    const fit = new FitAddon();
    terminal.loadAddon(fit);
    terminal.open(host);
    // No OSC clipboard handlers, link openers or escape-triggered host actions.
    const theme = () => {
      const css = getComputedStyle(host);
      const color = (name: string) => css.getPropertyValue(name).trim();
      terminal.options.theme = {
        background: color('--bg-base'),
        foreground: color('--text-primary'),
        cursor: color('--text-primary'),
        selectionBackground: color('--bg-active'),
        black: color('--text-secondary'),
        red: color('--danger'),
        green: color('--success'),
        yellow: color('--warning'),
        blue: color('--primary'),
        magenta: color('--brand'),
        cyan: color('--info'),
        white: color('--text-primary'),
        brightBlack: color('--text-secondary'),
        brightWhite: color('--text-primary'),
      };
    };
    theme();
    const themes = new MutationObserver(theme);
    themes.observe(document.documentElement, { attributes: true });
    themes.observe(document.body, { attributes: true });
    const target = { conversation_id: conversationId, process_id: processId };
    let disposed = false;
    let connected = false;
    let inputFailed = false;
    let queuedBytes = 0;
    let input = Promise.resolve();
    let after: number | undefined;
    let screenRevision: number | undefined;
    let timer: ReturnType<typeof setTimeout>;
    const typing = terminal.onData((data) => {
      if (!connected || inputFailed || disposed) return;
      queuedBytes += data.length;
      if (queuedBytes > 65536) {
        inputFailed = true;
        failure.current();
        return;
      }
      input = input.then(async () => {
        if (disposed || inputFailed) return;
        try {
          await ipcBridge.backgroundProcess.input.invoke({ ...target, data });
        } catch {
          inputFailed = true;
          failure.current();
        } finally {
          queuedBytes -= data.length;
        }
      });
    });
    let resizing = Promise.resolve();
    let dimensions = '';
    const resize = () => {
      if (disposed || !host.clientWidth || !host.clientHeight) return;
      const proposed = fit.proposeDimensions();
      if (!proposed) return;
      const cols = Math.max(2, Math.min(500, proposed.cols));
      const rows = Math.max(2, Math.min(300, proposed.rows));
      const key = `${rows}:${cols}`;
      if (key === dimensions) return;
      dimensions = key;
      terminal.resize(cols, rows);
      resizing = resizing.then(async () => {
        if (disposed) return;
        try {
          await ipcBridge.backgroundProcess.resize.invoke({ ...target, rows, cols });
        } catch {
          dimensions = '';
          failure.current();
        }
      });
    };
    const observer = new ResizeObserver(resize);
    observer.observe(host);
    resize();
    const poll = async () => {
      if (disposed) return;
      try {
        const chunk = await ipcBridge.backgroundProcess.output.invoke({
          ...target,
          after,
          screen_revision: screenRevision,
        });
        if (disposed) return;
        if (chunk.reset) {
          terminal.resize(chunk.cols, chunk.rows);
          terminal.reset();
          dimensions = `${chunk.rows}:${chunk.cols}`;
        }
        const bytes = Uint8Array.from(atob(chunk.data), (ch) => ch.charCodeAt(0));
        // Wait for emulator parsing before advancing the output cursor.
        await new Promise<void>((resolve) => terminal.write(bytes, resolve));
        after = chunk.next_offset;
        screenRevision = chunk.screen_revision;
        resize();
        connected = chunk.running;
        terminal.options.disableStdin = !chunk.running || inputFailed;
      } catch {
        connected = false;
        failure.current();
      }
      if (!disposed) timer = setTimeout(() => void poll(), 100);
    };
    void poll();
    return () => {
      disposed = true;
      clearTimeout(timer);
      observer.disconnect();
      themes.disconnect();
      typing.dispose();
      terminal.dispose();
    };
  }, [conversationId, processId, generation]);
  return container;
}
