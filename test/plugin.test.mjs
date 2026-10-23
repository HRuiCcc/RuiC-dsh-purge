import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { handler, installHttp } from '../lib/http.js';
import { apply } from '../lib/index.js';

async function request(operation, { method = 'POST', headers = {}, body = '{}', address = '127.0.0.1' } = {}) {
  const req = Readable.from([body]); req.method = method;
  if (address !== null) req.socket = { remoteAddress: address };
  req.headers = { host: '127.0.0.1:3000', 'content-type': 'application/json', ...headers };
  const response = { writeHead(status) { this.status = status; }, end(data) { this.body = data ? JSON.parse(data) : null; } };
  await handler(operation, { base: '/nonexistent-ruic-test-host', home: '/nonexistent-ruic-test-home' })(req, response);
  return response;
}
test('mutations reject cross-site, missing header, hostile origin and null origin', async () => {
  for (const headers of [{}, { 'x-ruic-request': '1', origin: 'https://evil.example' }, { 'x-ruic-request': '1', origin: 'null' }, { 'x-ruic-request': '1', 'sec-fetch-site': 'cross-site' }]) {
    assert.equal((await request('apply', { headers })).status, 403);
  }
});
test('maintenance routes require a direct loopback socket and reject proxies', async () => {
  for (const address of ['127.0.0.1', '127.9.8.7', '::1', '::ffff:127.0.0.1']) {
    const response = await request('override', { method: 'GET', address });
    assert.notEqual(response.status, 403, address);
  }
  for (const address of [null, '', '192.168.0.10', '8.8.8.8', '::ffff:192.168.0.1', 'fe80::1', '127.999.0.1']) {
    assert.equal((await request('override', { method: 'GET', address })).status, 403, String(address));
  }
  for (const headers of [{ forwarded: 'for=127.0.0.1' }, { 'x-forwarded-for': '127.0.0.1' }, { 'x-forwarded-for': '' }]) {
    assert.equal((await request('override', { method: 'GET', headers })).status, 403);
  }
});
test('HTTP methods, malformed JSON, content type and body limit', async () => {
  assert.equal((await request('apply', { method: 'GET' })).status, 405);
  assert.equal((await request('apply', { headers: { 'x-ruic-request': '1' }, body: '{broken' })).status, 400);
  assert.equal((await request('apply', { headers: { 'x-ruic-request': '1', 'content-type': 'text/plain' } })).status, 400);
  const tooLarge = await request('override', { headers: { 'x-ruic-request': '1' }, body: 'x'.repeat(170000) });
  assert.match(tooLarge.body.error, /160 KiB/);
});
test('same-origin failures are reported instead of claiming success', async () => {
  const result = await request('apply', { headers: { 'x-ruic-request': '1', origin: 'http://127.0.0.1:3000' } });
  assert.equal(result.status, 400); assert.equal(result.body.ok, false);
});
test('HTTP route lifetime removes registrations, including partial install failure', () => {
  const live = new Set(); let cleanup;
  const host = { effect: fn => { cleanup = fn(); }, webServer: { register: route => { live.add(route.path); return () => live.delete(route.path); } } };
  installHttp({ inject: (_, fn) => fn(host) }, {}); assert.equal(live.size, 6);
  cleanup(); assert.equal(live.size, 0);
  let n = 0;
  host.webServer.register = route => { if (++n === 3) throw new Error('duplicate'); live.add(route.path); return () => live.delete(route.path); };
  assert.throws(() => installHttp({ inject: (_, fn) => fn(host) }, {}), /duplicate/);
  assert.equal(live.size, 0);
});
test('plugin uses upstream section API and independent command/tool namespaces', async () => {
  const sections = [], tools = [], commands = [];
  const ctx = { systemPrompt: { section: s => sections.push(s) }, tools: { register: t => tools.push(t) }, inject(deps, callback) { if (deps.includes('commands')) callback({ commands: { register: c => commands.push(c) } }); } };
  apply(ctx, { home: '/nonexistent-ruic-test-home' });
  assert.equal(sections[0].interpolate, false); assert.equal(sections[0].name, 'ruic-dsh-purge'); assert.equal(sections[0].text(), '');
  assert.equal(commands[0].name, 'ruic-purge'); assert.equal(tools.length, 5);
  assert.ok(tools.every(t => t.name.startsWith('ruic_purge_')));
  assert.equal((await commands[0].handler({ rawInput: 'unknown' })).kind, 'error');
  const before = sections.length; apply(ctx, { enabled: false }); assert.equal(sections.length, before);
});

// Optional contract suite against an extracted DSH release, without starting
// the app, opening ports, or touching an installed DSH profile.
// DSH_RUNTIME_ROOT=/path/to/node_modules/@deepseek-ai node --test
const runtimeRoot = process.env.DSH_RUNTIME_ROOT;
test('real DSH runtime: tools, literal prompt, late services and unload/reload', { skip: !runtimeRoot }, async () => {
  const { pathToFileURL } = await import('node:url');
  const path = await import('node:path');
  const fs = await import('node:fs/promises');
  const os = await import('node:os');
  const load = name => import(pathToFileURL(path.join(runtimeRoot, name, 'lib/index.js')).href);
  const [{ Context, Service }, { default: SystemPrompt, renderPrompt }, { default: Tools, validateJsonSchemaValue }, { default: Commands }, { default: WebServer }] = await Promise.all([
    load('cordis'), load('dsh-system-prompt'), load('dsh-tools'), load('dsh-commands'), load('dsh-host-webserver'),
  ]);
  const { default: plugin } = await import('../lib/index.js');
  // Retain the real web service route implementation; disable only its socket
  // binding lifecycle hook so the test is independent of network permissions.
  class RouteRegistry extends WebServer { [Service.init]() {} }
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'ruic-plugin-runtime-'));
  const ctx = new Context();
  const settle = () => new Promise(resolve => setImmediate(resolve));
  try {
    await fs.mkdir(path.join(home, 'ruic-dsh-purge'));
    const literal = 'Project notes: keep {{user_template}} literal.';
    await fs.writeFile(path.join(home, 'ruic-dsh-purge', 'prompt.md'), literal);
    await ctx.plugin(SystemPrompt, { includeHarnessIdentity: false });
    await ctx.plugin(Tools);
    let pluginFiber = await ctx.plugin(plugin, { home, base: '/nonexistent-ruic-runtime-host' });
    const assembly = await ctx.systemPrompt.assemble();
    assert.equal(renderPrompt(assembly), literal);
    assert.equal(assembly.tools.length, 5);
    assert.ok(assembly.tools.every(tool => tool.name.startsWith('ruic_purge_')));
    // Services may arrive after this plugin, or be replaced during hot reload.
    let commandFiber = await ctx.plugin(Commands);
    let webFiber = await ctx.plugin(RouteRegistry, { host: '127.0.0.1', port: 0 });
    await settle();
    assert.equal(ctx.commands.list(undefined).length, 1);
    assert.equal(ctx.webServer.exact.size, 6);
    const command = ctx.commands.find(undefined, 'ruic-purge');
    assert.equal((await command.handler({ rawInput: 'unknown' })).kind, 'error');
    const snapshotTool = ctx.tools.layers.global.tools.get('ruic_purge_snapshots');
    const value = await snapshotTool.execute({});
    assert.equal(JSON.parse(value.text).ok, true);
    assert.deepEqual(validateJsonSchemaValue(snapshotTool.output.schema, value), []);
    assert.deepEqual(snapshotTool.output.render({}, value), [{ type: 'text', text: value.text }]);
    await commandFiber.dispose();
    await webFiber.dispose();
    commandFiber = await ctx.plugin(Commands);
    webFiber = await ctx.plugin(RouteRegistry, { host: '127.0.0.1', port: 0 });
    await settle();
    assert.equal(ctx.commands.list(undefined).length, 1);
    assert.equal(ctx.webServer.exact.size, 6);
    await pluginFiber.dispose();
    assert.equal((await ctx.systemPrompt.assemble()).tools.length, 0);
    assert.equal(ctx.commands.list(undefined).length, 0);
    assert.equal(ctx.webServer.exact.size, 0);
    assert.equal(renderPrompt(await ctx.systemPrompt.assemble()), '');
    pluginFiber = await ctx.plugin(plugin, { home });
    await settle();
    assert.equal((await ctx.systemPrompt.assemble()).tools.length, 5);
    assert.equal(ctx.commands.list(undefined).length, 1);
    assert.equal(ctx.webServer.exact.size, 6);
  } finally {
    await ctx.fiber.dispose();
    await fs.rm(home, { recursive: true, force: true });
  }
});
