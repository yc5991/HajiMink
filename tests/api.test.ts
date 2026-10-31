import { afterEach, it, expect, vi } from 'vitest';
import { api, initializeSession } from '../src/api';
afterEach(() => vi.unstubAllGlobals());
it('retains action error codes from both gateway and framework error envelopes', async () => {
  for (const value of [{ error: { code: 'OPERATION_UNCONFIRMED', message: '待核实' } }, { error: 'Conflict', code: 'OPERATION_UNCONFIRMED', message: '待核实' }]) {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify(value), { status: 409 })));
    await expect(api('/api/threads/test/messages', {})).rejects.toMatchObject({ code: 'OPERATION_UNCONFIRMED', status: 409, message: '待核实' });
  }
});
it('asks for renewed login after Access redirects and distinguishes read failures from uncertain writes', async () => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(null, { status: 302 })));
  await expect(api('/api/session')).rejects.toMatchObject({ code: 'LOGIN_REQUIRED', status: 401 });
  vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('offline')));
  await expect(api('/api/session')).rejects.toMatchObject({ message: '网络连接中断，请检查网络或稍后重试' });
  await expect(api('/api/threads/test/messages', {})).rejects.toMatchObject({ message: '网络连接中断，操作结果待核实', status: 0 });
});
it('leaves a recent-owner reauthentication error to the current page and dispatches an event only for an expired login', async () => {
  const target = new EventTarget(), listener = vi.fn(); target.addEventListener('ac:login-required', listener);
  vi.stubGlobal('window', target);
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({ error: { code: 'REAUTHENTICATE', message: '请重新验证' } }), { status: 401 })));
  await expect(api('/api/auth/device/list')).rejects.toMatchObject({ code: 'REAUTHENTICATE' });
  expect(listener).not.toHaveBeenCalled();
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({ error: { code: 'LOGIN_REQUIRED', message: '请登录' } }), { status: 401 })));
  await expect(api('/api/auth/device/list')).rejects.toMatchObject({ code: 'LOGIN_REQUIRED' });
  expect(listener).toHaveBeenCalledTimes(1);
});

it('aborts session initialization without replacing the CSRF value from a newer session', async () => {
  let finish: ((value: unknown) => void) | undefined;
  const controller = new AbortController();
  const fetchMock = vi.fn().mockResolvedValueOnce(new Response(JSON.stringify({ csrf: 'previous-csrf' }), { status: 200 }))
    .mockResolvedValueOnce({ ok: true, status: 200, type: 'basic', json: () => new Promise(resolve => { finish = resolve; }) })
    .mockResolvedValueOnce(new Response(JSON.stringify({ ok: true }), { status: 200 }));
  vi.stubGlobal('fetch', fetchMock);
  await initializeSession();
  const pending = initializeSession({ signal: controller.signal });
  await vi.waitFor(() => expect(finish).toBeDefined());
  controller.abort(); finish!({ csrf: 'stale-csrf' });
  await expect(pending).rejects.toMatchObject({ code: 'NETWORK_UNCONFIRMED', status: 0 });
  await api('/api/preferences', { theme: 'dark' });
  expect(fetchMock.mock.calls[2][1].headers['X-Agent-Control-Csrf']).toBe('previous-csrf');
  expect(fetchMock.mock.calls[1][1].signal).toBe(controller.signal);
});

it('preserves uncertain-write messaging if an aborted request already received a response', async () => {
  const controller = new AbortController();
  vi.stubGlobal('fetch', vi.fn().mockImplementation(async () => {
    controller.abort();
    return new Response(JSON.stringify({ ok: true }), { status: 200 });
  }));
  await expect(api('/api/threads', { prompt: 'fixture' }, { signal: controller.signal })).rejects.toMatchObject({ code: 'NETWORK_UNCONFIRMED', status: 0, message: '网络连接中断，操作结果待核实' });
});
