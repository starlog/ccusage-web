const base = (server) => server.replace(/\/+$/, '');

async function request(url, options, timeoutMs) {
  try {
    return await fetch(url, { ...options, signal: AbortSignal.timeout(timeoutMs) });
  } catch (error) {
    const reason = error.name === 'TimeoutError' ? '응답 시간 초과' : (error.cause?.code ?? error.cause?.message ?? error.message);
    throw new Error(`${url}에 연결하지 못했습니다 (${reason})`);
  }
}

/** Token requirement and the current client package path, from the usage server. */
export async function clientInfo(server, timeoutMs = 10_000) {
  const url = `${base(server)}/api/client-info`;
  const res = await request(url, {}, timeoutMs);
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  return res.json();
}

export async function uploadReport(server, token, payload, timeoutMs = 60_000) {
  const url = `${base(server)}/api/reports`;
  const res = await request(
    url,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json; charset=utf-8', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      body: JSON.stringify(payload),
    },
    timeoutMs,
  );
  const text = await res.text();
  if (!res.ok) {
    let message = text.slice(0, 500);
    try {
      message = JSON.parse(text).error ?? message;
    } catch {
      // not JSON
    }
    throw new Error(`서버가 보고서를 거부했습니다: HTTP ${res.status} ${message}`);
  }
  return JSON.parse(text);
}

export const packageUrl = (server, path = '/client/cc-usage-client.tgz') => `${base(server)}${path}`;
