let csrf = '';
export class ApiError extends Error {
  constructor(message: string, public code: string, public status: number) { super(message); }
}
export async function api<T = any>(url: string, body?: unknown, options?: { signal?: AbortSignal }): Promise<T> {
  const networkError = () => new ApiError(body === undefined ? '网络连接中断，请检查网络或稍后重试' : '网络连接中断，操作结果待核实', 'NETWORK_UNCONFIRMED', 0);
  let response: Response;
  try {
    response = await fetch(url, { method: body === undefined ? 'GET' : 'POST', headers: body === undefined ? {} : { 'Content-Type': 'application/json', 'X-Agent-Control-Csrf': csrf }, body: body === undefined ? undefined : JSON.stringify(body), credentials: 'same-origin', redirect: 'manual', ...(options?.signal ? { signal: options.signal } : {}) });
  } catch { throw networkError(); }
  if (response.type === 'opaqueredirect' || (response.status >= 300 && response.status < 400)) throw new ApiError('登录状态已更新，请刷新页面重新登录', 'LOGIN_REQUIRED', 401);
  const value = await response.json().catch(() => ({}));
  if (options?.signal?.aborted) throw networkError();
  if (!response.ok) {
    const error = typeof value.error === 'object' ? value.error : value;
    if (response.status === 401 && error?.code === 'LOGIN_REQUIRED' && typeof window !== 'undefined') window.dispatchEvent(new Event('ac:login-required'));
    throw new ApiError(error?.message || `请求未完成（${response.status}）`, error?.code || 'REQUEST_FAILED', response.status);
  }
  return value as T;
}
export async function initializeSession(options?: { signal?: AbortSignal }) { const session = await api('/api/session', undefined, options); csrf = session.csrf; return session; }
export async function initializeAuthSession() { const session = await api('/api/auth/bootstrap'); csrf = session.csrf; return session; }
