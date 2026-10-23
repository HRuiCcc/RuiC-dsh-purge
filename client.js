// Adapted from dsh-purge's DSH settings slot (MIT, 小杨). See NOTICE.md.
window.__ModuleLoader__.load({ id: 'ruic-dsh-purge', factory: require => {
  const React = require('react');
  const h = React.createElement;
  const { useState, useEffect, useRef } = React;
  const prefix = '/ruic-dsh-purge/';
  const labels = {
    applied: '已应用', pending: '待应用', incompatible: '宿主不兼容',
    pattern_not_found: '未匹配原文', ambiguous: '匹配不唯一',
    missing_or_unreadable: '文件缺失或不可读', recovery_required: '需要恢复',
    prepared: '已备份', applying: '写入中', reverting: '恢复中', reverted: '已还原', rolled_back: '失败已撤回', sealed: '桌面归档 · 只读检查', native_setting: '由 DSH 原生权限管理',
  };
  async function request(op, body) {
    const response = await fetch(prefix + op, {
      cache: 'no-store', signal: AbortSignal.timeout(30000),
      ...(body === undefined ? {} : {
        method: 'POST', headers: { 'content-type': 'application/json', 'x-ruic-request': '1' }, body: JSON.stringify(body),
      }),
    });
    const value = await response.json();
    if (!response.ok || (!value.ok && !['status', 'plan'].includes(op))) throw new Error(value.error || '请求失败，请刷新状态后重试。');
    return value;
  }
  function Panel() {
    const [state, setState] = useState(null);
    const [content, setContent] = useState('');
    const [saved, setSaved] = useState(null);
    const [busy, setBusy] = useState(false);
    const [notice, setNotice] = useState('');
    const [failure, setFailure] = useState(false);
    const [preview, setPreview] = useState(null);
    const [selected, setSelected] = useState('');
    const [confirm, setConfirm] = useState(false);
    const active = useRef(true);
    const running = useRef(false);
    const dirty = saved !== null && content !== saved.content;
    async function action(work) {
      if (running.current) return;
      running.current = true;
      setBusy(true); setNotice(''); setFailure(false);
      try { await work(); }
      catch (e) { if (active.current) { setNotice(e.message); setFailure(true); } }
      finally { running.current = false; if (active.current) setBusy(false); }
    }
    async function loadStatus() {
      const result = await request('status');
      if (active.current) setState(result);
    }
    async function loadPrompt() {
      const result = await request('override');
      if (active.current) { setSaved(result); setContent(result.content); }
    }
    useEffect(() => {
      active.current = true;
      action(async () => {
        const results = await Promise.allSettled([loadStatus(), loadPrompt()]);
        const errors = results.filter(r => r.status === 'rejected').map(r => r.reason.message);
        if (errors.length) throw new Error(errors.join('；'));
      });
      return () => { active.current = false; };
    }, []);
    useEffect(() => {
      if (!dirty) return;
      const warn = event => { event.preventDefault(); event.returnValue = ''; };
      window.addEventListener('beforeunload', warn);
      return () => window.removeEventListener('beforeunload', warn);
    }, [dirty]);
    const button = (text, onClick, disabled = false, className = '') => h('button', {
      type: 'button', className, disabled: busy || disabled, onClick,
    }, text);
    return h('section', { className: 'ruic-purge', 'aria-label': 'RuiC DSH Purge', 'aria-busy': busy },
      h('style', null, `
        .ruic-purge{max-width:780px;line-height:1.6;font-size:16px;color:inherit;overflow-wrap:anywhere}
        .ruic-purge h2{font-size:24px;margin:0 0 8px}.ruic-purge h3{font-size:18px;margin:28px 0 8px}
        .ruic-purge p{margin:8px 0}.ruic-purge .actions{display:flex;flex-wrap:wrap;align-items:center;gap:8px;margin:12px 0}
        .ruic-purge button,.ruic-purge select{font:inherit;color:inherit;background:transparent;border:1px solid currentColor;border-radius:6px;padding:8px 14px;min-height:44px}
        .ruic-purge button{cursor:pointer}.ruic-purge button:hover:not(:disabled){background:var(--color-background-secondary,rgba(128,128,128,.12))}
        .ruic-purge button:disabled{opacity:.5;cursor:default}.ruic-purge :focus-visible{outline:2px solid currentColor;outline-offset:3px}
        .ruic-purge .primary{font-weight:700;border-width:2px}.ruic-purge textarea{width:100%;box-sizing:border-box;min-height:220px;background:transparent;color:inherit;caret-color:currentColor;font:16px/1.6 ui-monospace,monospace;border:1px solid currentColor;border-radius:6px;padding:12px;resize:vertical}
        .ruic-purge table{width:100%;border-collapse:collapse;font-size:14px;text-align:left}.ruic-purge th,.ruic-purge td{padding:10px 6px;border-bottom:1px solid rgba(128,128,128,.35)}
        .ruic-purge .scroll{overflow-x:auto}.ruic-purge .message{border:1px solid currentColor;padding:12px}.ruic-purge code{font-size:14px}
        .ruic-purge select{max-width:100%}.ruic-purge details{margin:16px 0}.ruic-purge summary{cursor:pointer}.ruic-purge pre{white-space:pre-wrap;font-size:13px}
      `),
      h('h2', null, 'RuiC DSH Purge'),
      h('p', null, '预览改动，保存快照，再应用。每一步都有记录可查。'),
      h('div', { className: 'actions' },
        h('strong', null, state ? `${labels[state.state] || state.state} · ${state.applied}/${state.total}` : busy ? '正在读取宿主状态…' : '尚未读取状态'),
        button('刷新状态', () => action(loadStatus)),
      ),
      state && !state.ok && h('p', { className: 'message' }, state.state === 'recovery_required' ? '存在未完成操作。请在下方选择对应快照恢复。' : '部分补丁与当前宿主不匹配。请查看明细；应用会停止且保留原文件。'),
      state?.state === 'sealed' && h('p', { className: 'message' }, '已识别桌面版归档。提示词可正常保存；宿主补丁只做预检，不改签名归档。权限请在会话使用 /permission 设置。'),
      state && h('div', { className: 'scroll' }, h('table', null,
        h('caption', null, '补丁匹配结果'),
        h('thead', null, h('tr', null, h('th', { scope: 'col' }, '补丁'), h('th', { scope: 'col' }, '状态'))),
        h('tbody', null, state.report.map(r => h('tr', { key: r.id },
          h('td', null, h('code', null, r.name || r.id)),
          h('td', { title: r.detail || r.path }, labels[r.status] || r.status))),
        ),
      )),
      h('div', { className: 'actions' },
        button('预览改动', () => action(async () => { setPreview(await request('plan')); }), !state),
        button('应用补丁', () => action(async () => {
          const result = await request('apply', {});
          setNotice(result.snapshot ? `已写入，快照 ${result.snapshot}。请手动重启 DSH。` : '补丁已全部应用，无需重复写入。');
          setPreview(null); await loadStatus();
        }), !state?.ok || !state.host?.writable || state.state === 'applied', 'primary'),
      ),
      preview && h('details', { open: true }, h('summary', null, `改动预览 · ${preview.changes.length} 个文件`),
        h('p', null, '预览为路径与前后 SHA256，不会写入文件。'), h('pre', null, JSON.stringify(preview, null, 2))),
      h('h3', null, '恢复快照'),
      h('p', null, '回滚会保留提示词和快照；文件有后续修改时停止恢复。'),
      state?.snapshots.length ? h('div', { className: 'actions' },
        h('select', { 'aria-label': '选择快照', value: selected, disabled: busy, onChange: e => { setSelected(e.target.value); setConfirm(false); } },
          h('option', { value: '' }, '选择快照'),
          ...state.snapshots.map(s => h('option', { key: s.id, value: s.id }, `${new Date(s.created).toLocaleString()} · ${labels[s.state] || s.state} · ${s.id.slice(0, 8)}`))),
        button('恢复所选快照', () => setConfirm(true), !selected),
      ) : h('p', null, '还没有快照。首次应用有改动时会自动创建。'),
      confirm && h('div', { className: 'message' },
        h('p', null, `将恢复快照 ${selected} 中的宿主文件。`),
        h('div', { className: 'actions' },
          button('确认恢复', () => action(async () => { const r = await request('revert', { id: selected }); setNotice(r.note); setConfirm(false); await loadStatus(); })),
          button('取消', () => setConfirm(false)))),
      h('h3', null, h('label', { htmlFor: 'ruic-purge-prompt' }, '会话提示词')),
      h('p', null, '默认为空；独立保存，不覆盖原插件的 prompt-inject.md。'),
      h('textarea', { id: 'ruic-purge-prompt', value: content, disabled: busy || saved === null, spellCheck: false,
        onChange: e => setContent(e.target.value), 'aria-describedby': 'ruic-purge-draft', placeholder: '填写你的工作偏好、项目约定或回复格式。' }),
      h('div', { className: 'actions' },
        button('保存提示词', () => action(async () => {
          const result = await request('override', { content, hash: saved.hash });
          setSaved({ ...result, content }); setNotice('提示词已保存。');
        }), !dirty, 'primary'),
        button('读取已保存内容', () => action(loadPrompt), dirty),
        h('span', { id: 'ruic-purge-draft' }, saved === null ? '提示词尚未加载，可重试读取。' : dirty ? '有未保存修改' : '已与磁盘同步')),
      notice && h('p', { className: 'message', role: failure ? 'alert' : 'status' }, (failure ? '操作未完成：' : '') + notice),
      state && h('details', null, h('summary', null, '路径与版本'), h('p', null, '版本 ' + state.version), h('code', null, state.base), h('p', null, h('code', null, state.promptPath))),
      state?.permissions && h('details', null, h('summary', null, '权限证据（不代表已有会话）'), h('pre', null, JSON.stringify(state.permissions, null, 2))),
    );
  }
  return {
    name: 'ruic-dsh-purge', inject: ['slots'],
    apply: ctx => ctx.slots.inject('settings.section', () => ctx.slots.register({
      name: 'settings.section', id: 'ruic-dsh-purge', order: 40, label: () => 'RuiC Purge',
    }, () => h(Panel))),
  };
} });
