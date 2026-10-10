import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { configService } from '@/common/config/configService';

describe('configService transport', () => {
  beforeEach(() => {
    delete window.__backendPort;
    document.cookie = 'aionui-csrf-token=csrf-token; path=/';
    vi.spyOn(console, 'debug').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    delete window.__backendPort;
    document.cookie = 'aionui-csrf-token=; max-age=0; path=/';
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('uses the authenticated WebUI CSRF contract when persisting client settings', async () => {
    const fetchSpy = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));
    vi.stubGlobal('fetch', fetchSpy);

    await configService.set('theme.activeId', 'dark');

    expect(fetchSpy).toHaveBeenCalledWith('/api/settings/client', {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        'x-csrf-token': 'csrf-token',
      },
      body: JSON.stringify({ 'theme.activeId': 'dark' }),
      credentials: 'include',
    });
  });

  it('keeps the native loopback settings transport free of browser cookies and CSRF headers', async () => {
    window.__backendPort = 24680;
    const fetchSpy = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));
    vi.stubGlobal('fetch', fetchSpy);

    await configService.set('theme.activeId', 'light');

    expect(fetchSpy).toHaveBeenCalledWith('http://127.0.0.1:24680/api/settings/client', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ 'theme.activeId': 'light' }),
    });
  });
});
