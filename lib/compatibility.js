import { ALL_PATCHES } from './patches.js';

// 0.2.1-rc.2 verified against the shipped Desktop artifact. Later releases
// still require exact anchor evidence; version alone never implies a match.
export function compatibility(version) {
  const parsed = /^(\d+)\.(\d+)\./.exec(version || '');
  const modern = parsed && (Number(parsed[1]) > 0 || Number(parsed[2]) >= 2);
  if (!modern) return { id: 'legacy-8', patches: ALL_PATCHES, nativeSettings: [] };
  const patches = ALL_PATCHES.slice(0, 4).map(p => ({ ...p, patterns: [...p.patterns] }));
  for (const [index, from, to] of [
    [0, 'WORKSPACE_CONTEXT_INTRO', 'AGENT_INSTRUCTIONS_INTRO'],
    [1, 'REPLACEMENT_WORKSPACE_CONTEXT_INTRO', 'REPLACEMENT_AGENT_INSTRUCTIONS_INTRO'],
  ]) {
    patches[index].patterns = patches[index].patterns.map(s => s.replace(from, to));
    patches[index].replace = patches[index].replace.replace(from, to);
  }
  patches[3].patterns = ['personaPrefix: >-\n      You are a coding agent powered by the {{model}} model.'];
  patches[3].replace = patches[3].patterns[0] + '\n\n      Follow the operator\'s project conventions and task requirements. Complete requested work, report concrete results, and preserve user changes.';
  return {
    id: 'dsh-0.2-native-permissions', patches,
    nativeSettings: ALL_PATCHES.slice(4).map(p => ({
      id: p.id, name: p.name, status: 'native_setting',
      detail: p.id === 5
        ? 'Modern never policy still rejects requests requiring approval; the old full-access wording is not applied.'
        : 'Use the official /permission command or permission defaultPreset. Existing session permissions do not follow default changes.',
    })),
  };
}
