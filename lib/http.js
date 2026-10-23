import { isIP } from 'node:net';
import { run, readPrompt, savePrompt } from './service.js';

const prefix = '/ruic-dsh-purge';
function localConnection(request) {
  const address = request.socket?.remoteAddress;
  if (typeof address !== 'string') return false;
  const normalized = address.toLowerCase();
  const ipv4 = normalized.startsWith('::ffff:') ? normalized.slice(7) : normalized;
  const loopback = normalized === '::1' || (isIP(ipv4) === 4 && ipv4.startsWith('127.'));
  // Host raw routes do not inherit the RPC gateway's authentication. Keep this
  // maintenance surface local and never trust a proxy-supplied identity.
  return loopback && !Object.hasOwn(request.headers, 'forwarded') && !Object.hasOwn(request.headers, 'x-forwarded-for');
}
export function sendJson(response, code, body) {
  response.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
  response.end(JSON.stringify(body));
}
async function bodyJson(request) {
  if (!/^application\/json(?:;|$)/i.test(request.headers['content-type'] || '')) throw new Error('Expected application/json');
  let length = 0;
  const chunks = [];
  for await (const chunk of request) {
    const data = Buffer.from(chunk);
    length += data.length;
    if (length > 160 * 1024) throw new Error('Request body exceeds 160 KiB');
    chunks.push(data);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
}
export function handler(operation, options = {}) {
  return async (request, response) => {
    if (!localConnection(request)) {
      sendJson(response, 403, { ok: false, error: 'Use a direct localhost connection to DSH. Remote or proxied maintenance is available through the CLI only.' });
      return;
    }
    const method = request.method;
    const allowed = operation === 'override' ? ['GET', 'POST'] : ['apply', 'revert'].includes(operation) ? ['POST'] : ['GET'];
    if (!allowed.includes(method)) {
      response.writeHead(405, { allow: allowed.join(', ') }); response.end(); return;
    }
    // Same-origin UI only, in addition to the direct loopback connection check.
    const origin = request.headers.origin;
    let sameOrigin = true;
    if (origin) {
      try { const url = new URL(origin); sameOrigin = ['http:', 'https:'].includes(url.protocol) && url.host === request.headers.host; }
      catch { sameOrigin = false; }
    }
    if (!sameOrigin || request.headers['sec-fetch-site'] === 'cross-site' || (method === 'POST' && request.headers['x-ruic-request'] !== '1')) {
      sendJson(response, 403, { ok: false, error: 'Use the RuiC settings panel from the same DSH origin.' }); return;
    }
    try {
      const body = method === 'POST' ? await bodyJson(request) : {};
      const result = operation === 'override'
        ? method === 'GET' ? await readPrompt(options) : await savePrompt(body.content, body.hash, options)
        : await run(operation, options, body.id);
      // Status/plan includes incompatible evidence so the UI can render it.
      sendJson(response, result.ok || method === 'GET' ? 200 : 409, result);
    } catch (e) {
      sendJson(response, 400, { ok: false, error: e.message });
    }
  };
}
export function installHttp(ctx, options) {
  ctx.inject(['webServer'], host => {
    host.effect(() => {
      const disposers = [];
      try {
        for (const operation of ['status', 'plan', 'snapshots', 'apply', 'revert', 'override']) {
          disposers.push(host.webServer.register({ kind: 'exact', path: `${prefix}/${operation}`, handler: handler(operation, options) }));
        }
      } catch (e) {
        for (const stop of disposers.reverse()) if (typeof stop === 'function') stop();
        throw e;
      }
      return () => { for (const stop of disposers.reverse()) if (typeof stop === 'function') stop(); };
    }, 'ruic-dsh-purge: http');
  });
}
