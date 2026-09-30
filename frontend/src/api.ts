const apiBase = (import.meta.env.VITE_API_URL || '/api').replace(/\/$/, '');
let csrfToken = '';

export class ApiError extends Error {
  constructor(message: string, public readonly status: number) { super(message); this.name = 'ApiError'; }
}
export async function api<T>(path: string, options: RequestInit = {}): Promise<T> {
  const method = (options.method ?? 'GET').toUpperCase();
  const headers = new Headers(options.headers);
  if (options.body && !headers.has('Content-Type')) headers.set('Content-Type', 'application/json');
  if (!['GET','HEAD','OPTIONS'].includes(method)) {
    if (!csrfToken) {
      const csrfResponse = await fetch(`${apiBase}/csrf`, { credentials: 'include' });
      if (!csrfResponse.ok) throw new ApiError('Could not start a secure session. Please refresh and try again.', csrfResponse.status);
      csrfToken = (await csrfResponse.json() as { token: string }).token;
    }
    headers.set('X-CSRF-Token', csrfToken);
  }
  const response = await fetch(`${apiBase}${path}`, { ...options, method, headers, credentials: 'include' });
  if (response.status === 403 && !['GET','HEAD','OPTIONS'].includes(method)) csrfToken = '';
  const body = await response.json().catch(() => ({})) as { error?: string };
  if (!response.ok) throw new ApiError(body.error || 'The request could not be completed.', response.status);
  return body as T;
}
export const money = (cents: number) => new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(cents / 100);
