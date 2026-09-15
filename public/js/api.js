// Thin fetch wrapper: JSON in, JSON out, errors with a readable message.

export class ApiError extends Error {
  constructor(message, status) {
    super(message);
    this.status = status;
  }
}

let onUnauthorized = () => {};
export function setUnauthorizedHandler(fn) {
  onUnauthorized = fn;
}

function withQuery(path, params) {
  if (!params) return path;
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null && v !== '' && v !== false) qs.set(k, String(v));
  }
  const s = qs.toString();
  return s ? `${path}?${s}` : path;
}

export async function api(path, { method = 'GET', body, params } = {}) {
  const init = { method, headers: {}, credentials: 'same-origin' };
  if (body instanceof FormData) {
    init.body = body;
  } else if (body !== undefined) {
    init.headers['Content-Type'] = 'application/json';
    init.body = JSON.stringify(body);
  }

  let res;
  try {
    res = await fetch(`/api${withQuery(path, params)}`, init);
  } catch {
    throw new ApiError('Could not reach the server. Check that Tailscale is connected.', 0);
  }

  if (res.status === 401 && path !== '/auth/login') {
    onUnauthorized();
    throw new ApiError('Your session ended. Sign in again.', 401);
  }

  const isJson = (res.headers.get('content-type') || '').includes('application/json');
  const data = isJson ? await res.json() : null;

  if (!res.ok) {
    let message = data && data.error;
    if (!message && (res.status === 502 || res.status === 504)) {
      message = 'The server took too long to answer. It may still have finished — check Accounts → Upload history.';
    }
    throw new ApiError(message || `Something went wrong (${res.status}).`, res.status);
  }
  return data;
}

export const get = (path, params) => api(path, { params });
export const post = (path, body) => api(path, { method: 'POST', body });
export const patch = (path, body) => api(path, { method: 'PATCH', body });
export const put = (path, body) => api(path, { method: 'PUT', body });
export const del = (path) => api(path, { method: 'DELETE' });
