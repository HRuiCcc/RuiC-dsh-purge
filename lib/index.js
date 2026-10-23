import fs from 'node:fs';
import { run, promptPath } from './service.js';
import { installHttp } from './http.js';

export const name = 'ruic-dsh-purge';
export const inject = ['systemPrompt', 'tools'];

export function apply(ctx, config = {}) {
  if (config.enabled === false) return;
  let permissionPresets;
  const options = {
    base: config.base, home: config.home, shimDir: config.shimDir,
    permissionState: () => {
      if (!permissionPresets) return { source: 'unavailable', defaultPreset: null, scope: 'future_sessions' };
      try {
        const defaultPreset = permissionPresets.defaultPreset;
        return typeof defaultPreset === 'string'
          ? { source: 'runtime', defaultPreset, scope: 'future_sessions' }
          : { source: 'unavailable', defaultPreset: null, scope: 'future_sessions' };
      } catch {
        return { source: 'unavailable', defaultPreset: null, scope: 'future_sessions' };
      }
    },
  };
  // Observe the official service; never change the user's permission defaults.
  // A process-level default is not evidence of the current session's policy.
  ctx.inject(['permissionPresets'], host => host.effect(() => {
    permissionPresets = host.permissionPresets;
    return () => { permissionPresets = undefined; };
  }, 'ruic-dsh-purge: permission defaults'));
  ctx.systemPrompt.section({
    name: 'ruic-dsh-purge', order: 100,
    // User-authored text is literal, including {{template}} examples.
    interpolate: false,
    text: () => {
      try { return fs.readFileSync(promptPath(options), 'utf8').trim(); }
      catch (e) {
        if (e.code !== 'ENOENT') console.warn('[ruic-dsh-purge] prompt:', e.message);
        return '';
      }
    },
  });
  // Commands are optional (headless compositions may omit them). Injection also
  // re-registers correctly when the host loads or replaces the service later.
  ctx.inject(['commands'], host => host.commands.register({
    name: 'ruic-purge', description: 'RuiC DSH: status / plan / apply / snapshots / revert <id>',
    input: { hint: 'status | plan | apply | snapshots | revert <id>' },
    handler: async invocation => {
      try {
        const [command = 'status', argument] = String(invocation.rawInput || '').trim().split(/\s+/).filter(Boolean);
        const result = await run(command, options, argument);
        return { kind: result.ok ? 'success' : 'error', text: JSON.stringify(result, null, 2) };
      } catch (e) { return { kind: 'error', text: e.message }; }
    },
  }));
  for (const operation of ['status', 'plan', 'apply', 'snapshots', 'revert']) {
    ctx.tools.register({
      name: `ruic_purge_${operation}`,
      description: `RuiC DSH ${operation}. Apply/revert change local installation files; restart DSH manually afterward.`,
      parameters: {
        type: 'object', additionalProperties: false,
        properties: operation === 'revert' ? { id: { type: 'string', description: 'Snapshot ID from ruic_purge_snapshots' } } : {},
        ...(operation === 'revert' ? { required: ['id'] } : {}),
      },
      output: {
        schema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'], additionalProperties: false },
        render: (_args, value) => [{ type: 'text', text: String(value?.text || '') }],
      },
      execute: async args => {
        try { return { text: JSON.stringify(await run(operation, options, args?.id), null, 2) }; }
        catch (e) { return { text: JSON.stringify({ ok: false, error: e.message }) }; }
      },
    });
  }
  installHttp(ctx, options);
  if (config.autoApplyOnStart === true) {
    run('apply', options).then(result => {
      if (!result.ok) console.warn('[ruic-dsh-purge] auto-apply failed:', JSON.stringify(result));
    }).catch(e => console.warn('[ruic-dsh-purge] auto-apply:', e.message));
  }
}
export default { name, inject, apply };
