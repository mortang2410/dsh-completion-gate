window.__ModuleLoader__.load({ id: 'dsh-completion-gate', factory: (require) => {
var module = { exports: {} }; var exports = module.exports;
const React = require('react');
const { useEffect, useMemo, useState } = React;
const h = React.createElement;
const API = '/api/completion-gate/v1';

const css = `
.cg{--t:var(--dsw-alias-label-primary,#171717);--m:var(--dsw-alias-label-secondary,#606773);--bg:var(--dsw-alias-bg-base,#fff);--surf:var(--dsw-alias-bg-layer-1,#f7f7f7);--surf2:var(--dsw-alias-bg-layer-2,#eee);--b:var(--dsw-alias-border-l1,#ddd);--ok:#1f9d60;--err:#d94b55;--warn:#b7791f;--brand:var(--dsw-alias-brand-primary,#4f72ff);color:var(--t);display:flex;flex-direction:column;gap:16px;min-width:0;max-width:100%;overflow-x:hidden}.cg *{box-sizing:border-box;min-width:0}body[data-ds-dark-theme] .cg{--t:var(--dsw-alias-label-primary,#ececec);--m:var(--dsw-alias-label-secondary,#c1c5cd);--bg:var(--dsw-alias-bg-base,#171717);--surf:var(--dsw-alias-bg-layer-1,#232323);--surf2:var(--dsw-alias-bg-layer-2,#2d2d2d);--b:var(--dsw-alias-border-l1,#404040);--ok:#61d69b;--err:#ff858c;--warn:#ffc063}
.cg-head{display:flex;justify-content:space-between;gap:12px;align-items:flex-start;flex-wrap:wrap}.cg h2{font-size:22px;margin:0}.cg h3{font-size:14px;margin:0 0 9px}.cg-note{font-size:11px;color:var(--m);line-height:1.5}.cg-actions{display:flex;gap:7px;align-items:center;flex-wrap:wrap}.cg-btn,.cg-input,.cg-select{border:1px solid var(--b);background:var(--bg);color:var(--t);border-radius:8px;padding:8px 9px;font:inherit;font-size:12px}.cg-btn{cursor:pointer}.cg-btn:hover{background:var(--surf2)}.cg-btn:disabled{opacity:.55;cursor:not-allowed}.cg-primary{border-color:var(--brand);background:color-mix(in srgb,var(--brand) 12%,var(--bg))}.cg-danger{border-color:color-mix(in srgb,var(--err) 55%,var(--b))}.cg-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:12px}.cg-card{border:1px solid var(--b);background:var(--surf);border-radius:11px;padding:13px;display:flex;flex-direction:column;gap:9px}.cg-wide{grid-column:1/-1}.cg-field{display:flex;justify-content:space-between;align-items:flex-start;gap:14px;border-top:1px solid color-mix(in srgb,var(--b) 65%,transparent);padding-top:9px}.cg-field:first-of-type{border-top:0;padding-top:0}.cg-fieldtext{flex:1}.cg-fieldtitle{font-size:12px;font-weight:610}.cg-fielddesc{font-size:10px;color:var(--m);line-height:1.4;margin-top:2px}.cg-control{flex:0 0 auto;max-width:180px}.cg-check{width:17px;height:17px;accent-color:var(--brand)}.cg-number{width:100px}.cg-select{min-width:112px}.cg-kpis{display:grid;grid-template-columns:repeat(auto-fit,minmax(110px,1fr));gap:8px}.cg-kpi{border:1px solid var(--b);background:var(--surf);border-radius:10px;padding:10px}.cg-num{font-size:21px;font-weight:700}.cg-label{font-size:9px;color:var(--m);text-transform:uppercase;letter-spacing:.05em}.cg-status{display:inline-flex;gap:6px;align-items:center;font-size:10px;border:1px solid var(--b);border-radius:999px;padding:3px 7px}.cg-dot{width:7px;height:7px;border-radius:50%;background:var(--m)}.cg-dot.pass{background:var(--ok)}.cg-dot.block{background:var(--err)}.cg-dot.warn{background:var(--warn)}.cg-message{font-size:11px;padding:8px 10px;border-radius:8px;border-left:3px solid var(--brand);background:color-mix(in srgb,var(--brand) 7%,transparent)}.cg-message.err{border-left-color:var(--err);background:color-mix(in srgb,var(--err) 7%,transparent)}.cg-custom{display:grid;grid-template-columns:minmax(120px,.8fr) minmax(90px,.5fr) minmax(220px,2fr) auto auto;gap:7px;align-items:center;padding:7px 0;border-top:1px solid var(--b)}.cg-custom:first-of-type{border-top:0}.cg-custom .cg-input,.cg-custom .cg-select{width:100%}.cg-session{display:flex;flex-direction:column;gap:6px}.cg-row{display:flex;justify-content:space-between;gap:10px;flex-wrap:wrap}.cg-pass{color:var(--ok);font-weight:650}.cg-block{color:var(--err);font-weight:650}.cg-pills{display:flex;gap:5px;flex-wrap:wrap}.cg-pill{border:1px solid var(--b);border-radius:999px;padding:2px 6px;font-size:9px;color:var(--m)}.cg-header{border:1px solid rgba(127,127,127,.35);border-radius:999px;padding:4px 8px;font-size:11px;display:inline-flex;gap:6px;align-items:center}.cg-header .cg-dot{width:8px;height:8px}.cg-empty{border:1px dashed var(--b);border-radius:9px;padding:16px;text-align:center;color:var(--m);font-size:11px}
@media(max-width:760px){.cg-grid{grid-template-columns:1fr}.cg-wide{grid-column:auto}.cg-field{flex-direction:column}.cg-control{max-width:none;width:100%}.cg-custom{grid-template-columns:1fr}.cg-number,.cg-select{width:100%}}
`;

async function api(path, options = {}) {
  const response = await fetch(`${API}${path}`, { cache: 'no-store', ...options, headers: { 'Content-Type': 'application/json', ...(options.headers || {}) } });
  const body = await response.json();
  if (!response.ok || body.ok === false) throw new Error(body.error || `HTTP ${response.status}`);
  return body;
}
const getState = () => api('/state');

function Toggle({ value, onChange }) { return h('input', { className: 'cg-check', type: 'checkbox', checked: Boolean(value), onChange: e => onChange(e.target.checked) }); }
function Field({ title, description, children }) { return h('div', { className: 'cg-field' }, h('div', { className: 'cg-fieldtext' }, h('div', { className: 'cg-fieldtitle' }, title), description ? h('div', { className: 'cg-fielddesc' }, description) : null), h('div', { className: 'cg-control' }, children)); }



function Panel() {
  const [state, setState] = useState(null);
  const [draft, setDraft] = useState(null);
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');

  const refresh = async ({ replaceDraft = false } = {}) => {
    const next = await getState(); setState(next);
    if (replaceDraft || !draft || !dirty) setDraft(next.settings);
    return next;
  };
  useEffect(() => {
    let alive = true, timer;
    const tick = async () => {
      try { const next = await getState(); if (alive) { setState(next); setError(''); setDraft(current => current || next.settings); } }
      catch (e) { if (alive) setError(e.message || String(e)); }
      if (alive) timer = setTimeout(tick, 2500);
    };
    void tick(); return () => { alive = false; if (timer) clearTimeout(timer); };
  }, []);

  const update = (key, value) => { setDraft({ ...draft, [key]: value }); setDirty(true); setMessage(''); };
  const save = async () => {
    try { setBusy(true); setError(''); const next = await api('/settings', { method: 'POST', body: JSON.stringify({ settings: draft }) }); setState(next); setDraft(next.settings); setDirty(false); setMessage('Settings saved and applied immediately.'); }
    catch (e) { setError(e.message || String(e)); } finally { setBusy(false); }
  };
  const reset = async () => {
    try { setBusy(true); setError(''); const next = await api('/settings/reset', { method: 'POST', body: '{}' }); setState(next); setDraft(next.settings); setDirty(false); setMessage('Saved UI overrides removed. Profile configuration is active again.'); }
    catch (e) { setError(e.message || String(e)); } finally { setBusy(false); }
  };

  if (!state || !draft) return h('div', { className: 'cg' }, h('style', null, css), error || 'Loading Completion Gate…');
  return h('div', { className: 'cg' }, h('style', null, css),
    h('div', { className: 'cg-head' },
      h('div', null, h('h2', null, 'Completion Gate'), h('div', { className: 'cg-note' }, 'Advisory tracker for coding work: resolves the changed files of each turn to their repositories, keeps your claims and attestations, and sends one batched advisory stop message.')),
      h('div', { className: 'cg-actions' },
        h('span', { className: 'cg-status' }, h('span', { className: `cg-dot ${draft.enabled ? 'pass' : 'warn'}` }), draft.enabled ? 'Enabled' : 'Disabled'),
        state.hasSavedSettings ? h('span', { className: 'cg-status' }, 'UI override active') : h('span', { className: 'cg-status' }, 'Profile defaults'),
        h('button', { className: 'cg-btn', disabled: busy || !state.hasSavedSettings, onClick: reset }, 'Reset to profile defaults'),
        h('button', { className: 'cg-btn cg-primary', disabled: busy || !dirty, onClick: save }, busy ? 'Saving…' : 'Save settings'))),
    message ? h('div', { className: 'cg-message' }, message) : null,
    error ? h('div', { className: 'cg-message err' }, error) : null,

    h('div', { className: 'cg-grid' },
      h('div', { className: 'cg-card' }, h('h3', null, 'Behavior'),
        h(Field, { title: 'Enable Completion Gate', description: 'Master switch for repository tracking, premature-stop recovery, and the advisory stop message.' }, h(Toggle, { value: draft.enabled, onChange: v => update('enabled', v) })),
        h(Field, { title: 'Gate subagents', description: 'Off is recommended with autonomous teams. Root agent remains authoritative for final readiness.' }, h(Toggle, { value: draft.gateSubagents, onChange: v => update('gateSubagents', v) })),
        h(Field, { title: 'Premature-stop guard', description: 'Recover a naturally stopped task by scheduling a fresh follow-up turn when the model clearly says work is still pending.' }, h(Toggle, { value: draft.preventPrematureStops, onChange: v => update('preventPrematureStops', v) })),
        h(Field, { title: 'Max recovery follow-ups', description: 'Safety cap across a consecutive premature-stop recovery chain.' }, h('input', { className: 'cg-input cg-number', type: 'number', min: 0, max: 20, value: draft.prematureStopMaxContinuations, onChange: e => update('prematureStopMaxContinuations', Number(e.target.value)) }))
      ),
      h('div', { className: 'cg-card' }, h('h3', null, 'Advisory'),
        h(Field, { title: 'Security regression scan', description: 'Scans added lines for high-confidence credential and secret patterns.' }, h(Toggle, { value: draft.securityScan, onChange: v => update('securityScan', v) })),
        h(Field, { title: 'Maximum changed files', description: 'Safety bound for the changed-file inventory and attestation.' }, h('input', { className: 'cg-input cg-number', type: 'number', min: 10, max: 5000, value: draft.maxChangedFiles, onChange: e => update('maxChangedFiles', Number(e.target.value)) })),
      )
    ),

    h('div', { className: 'cg-note' }, 'Commands: /gate · /gate-status · /gate-reset · Agent tool: completion_gate')
  );
}

function Header() {
  const [state, setState] = useState(null);
  useEffect(() => { let alive = true; const tick = () => getState().then(value => alive && setState(value)).catch(() => {}); void tick(); const timer = setInterval(tick, 5000); return () => { alive = false; clearInterval(timer); }; }, []);
  if (!state) return null;
  const disabled = !state.settings?.enabled;
  const status = disabled ? 'warn' : 'pass';
  const text = disabled ? 'Gate · off' : 'Gate · on';
  return h('span', { className: 'cg-header', title: 'Completion Gate' }, h('style', null, css), h('span', { className: `cg-dot ${status}` }), text);
}

exports.inject = ['slots'];
exports.apply = function apply(ctx) {
  ctx.slots.inject('settings.section', () => ctx.slots.register({ name: 'settings.section', id: 'completion-gate', order: 880, label: 'Completion Gate' }, Panel));
  ctx.slots.inject('conversation.session.header.actions', () => ctx.slots.register({ name: 'conversation.session.header.actions', id: 'completion-gate-status', order: 75 }, Header));
};
exports.name = 'dsh-completion-gate';
return module.exports; } });
