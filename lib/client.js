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
function Kpi({ value, label }) { return h('div', { className: 'cg-kpi' }, h('div', { className: 'cg-num' }, String(value)), h('div', { className: 'cg-label' }, label)); }

function CustomChecks({ checks, setChecks }) {
  const change = (index, key, value) => setChecks(checks.map((check, i) => i === index ? { ...check, [key]: value } : check));
  const remove = index => setChecks(checks.filter((_check, i) => i !== index));
  const add = () => setChecks([...checks, { name: '', category: 'custom', command: '', required: true }]);
  return h('div', { className: 'cg-card cg-wide' },
    h('div', { className: 'cg-row' }, h('div', null, h('h3', null, 'Custom checks'), h('div', { className: 'cg-note' }, 'Operator-defined shell checks. They run in the project workspace during the machine-evidence phase.')), h('button', { className: 'cg-btn', onClick: add }, '+ Add check')),
    checks.length ? checks.map((check, index) => h('div', { className: 'cg-custom', key: index },
      h('input', { className: 'cg-input', placeholder: 'Name', value: check.name || '', onChange: e => change(index, 'name', e.target.value) }),
      h('select', { className: 'cg-select', value: check.category || 'custom', onChange: e => change(index, 'category', e.target.value) },
        ...['custom', 'test', 'build', 'lint', 'typecheck', 'security'].map(value => h('option', { value, key: value }, value))),
      h('input', { className: 'cg-input', placeholder: 'Command, e.g. npm run test:integration', value: check.command || '', onChange: e => change(index, 'command', e.target.value) }),
      h('label', { className: 'cg-note' }, h('input', { type: 'checkbox', checked: check.required !== false, onChange: e => change(index, 'required', e.target.checked) }), ' required'),
      h('button', { className: 'cg-btn cg-danger', onClick: () => remove(index) }, 'Remove')
    )) : h('div', { className: 'cg-empty' }, 'No custom checks configured. Auto-detected project checks are still used when enabled.')
  );
}

function VerificationOverview({ verification }) {
  if (!verification?.available) return h('div', { className: 'cg-card cg-wide' }, h('h3', null, 'Chosen verification source'), h('div', { className: 'cg-note' }, 'No gate report has been generated in this DSH process yet, so no source has been chosen.'));
  const recipe = verification.recipe || {};
  const temp = verification.temporary || {};
  return h('div', { className: 'cg-card cg-wide' }, h('h3', null, 'Chosen verification source'),
    h('div', { className: 'cg-row' }, h('span', { className: 'cg-status' }, h('span', { className: 'cg-dot ' + (verification.selected === 'none' ? 'warn' : 'pass') }), `Selected: ${verification.selected}`), h('span', { className: 'cg-note' }, `Session ${String(verification.sessionId || '').slice(0, 8)}`)),
    h('div', { className: 'cg-note' }, `Canonical checks: ${verification.canonical?.exists ? verification.canonical.checks.join(', ') : 'none detected'}`),
    h('div', { className: 'cg-note' }, `External verifier: ${verification.external?.configured ? `${verification.external.name} (${verification.external.usable ? 'usable' : 'unavailable'})` : 'not configured'}`),
    h('div', { className: 'cg-note' }, `Saved recipe: ${verification.savedRecipe ? verification.savedRecipe.name : 'none'}`),
    h('div', { className: 'cg-note' }, `Detected recipe: ${recipe.name ? `${recipe.name} (${recipe.kind}), ${recipe.usable ? 'usable' : 'not verification-capable'}` : 'none'}`),
    recipe.problems?.length ? h('div', { className: 'cg-note' }, recipe.problems.join(' ')) : null,
    h('div', { className: 'cg-note' }, `Temporary verifier: ${temp.eligible ? 'eligible' : `not eligible${temp.reason ? ` because ${temp.reason}` : ''}`}`)
  );
}

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
    try { setBusy(true); setError(''); const next = await api('/settings', { method: 'POST', body: JSON.stringify({ settings: draft }) }); setState(next); setDraft(next.settings); setDirty(false); setMessage('Settings saved and applied immediately. Cached gate evidence was invalidated.'); }
    catch (e) { setError(e.message || String(e)); } finally { setBusy(false); }
  };
  const reset = async () => {
    try { setBusy(true); setError(''); const next = await api('/settings/reset', { method: 'POST', body: '{}' }); setState(next); setDraft(next.settings); setDirty(false); setMessage('Saved UI overrides removed. Profile configuration is active again.'); }
    catch (e) { setError(e.message || String(e)); } finally { setBusy(false); }
  };

  if (!state || !draft) return h('div', { className: 'cg' }, h('style', null, css), error || 'Loading Completion Gate…');
  const timeoutSeconds = Math.round((draft.commandTimeoutMs || 600000) / 1000);
  return h('div', { className: 'cg' }, h('style', null, css),
    h('div', { className: 'cg-head' },
      h('div', null, h('h2', null, 'Completion Gate'), h('div', { className: 'cg-note' }, 'Evidence-backed stop barrier for coding work: recover premature natural stops, run machine checks, require changed-file review and acceptance-criteria evidence, then allow the root agent to finish.')),
      h('div', { className: 'cg-actions' },
        h('span', { className: 'cg-status' }, h('span', { className: `cg-dot ${draft.enabled ? 'pass' : 'warn'}` }), draft.enabled ? 'Enabled' : 'Disabled'),
        state.hasSavedSettings ? h('span', { className: 'cg-status' }, 'UI override active') : h('span', { className: 'cg-status' }, 'Profile defaults'),
        h('button', { className: 'cg-btn', disabled: busy || !state.hasSavedSettings, onClick: reset }, 'Reset to profile defaults'),
        h('button', { className: 'cg-btn cg-primary', disabled: busy || !dirty, onClick: save }, busy ? 'Saving…' : 'Save settings'))),
    message ? h('div', { className: 'cg-message' }, message) : null,
    error ? h('div', { className: 'cg-message err' }, error) : null,

    h('div', { className: 'cg-grid' },
      h('div', { className: 'cg-card' }, h('h3', null, 'Behavior'),
        h(Field, { title: 'Enable Completion Gate', description: 'Master switch for premature-stop recovery and production-readiness enforcement.' }, h(Toggle, { value: draft.enabled, onChange: v => update('enabled', v) })),
        h(Field, { title: 'Mode', description: 'Strict steers the agent back when blocked. Advisory records failures without preventing completion.' }, h('select', { className: 'cg-select', value: draft.mode, onChange: e => update('mode', e.target.value) }, h('option', { value: 'strict' }, 'Strict'), h('option', { value: 'advisory' }, 'Advisory'))),
        h(Field, { title: 'Gate subagents', description: 'Off is recommended with autonomous teams. Root agent remains authoritative for final readiness.' }, h(Toggle, { value: draft.gateSubagents, onChange: v => update('gateSubagents', v) })),
        h(Field, { title: 'Premature-stop guard', description: 'Recover a naturally stopped task by scheduling a fresh follow-up turn when the model clearly says work is still pending.' }, h(Toggle, { value: draft.preventPrematureStops, onChange: v => update('preventPrematureStops', v) })),
        h(Field, { title: 'Max recovery follow-ups', description: 'Safety cap across a consecutive premature-stop recovery chain.' }, h('input', { className: 'cg-input cg-number', type: 'number', min: 0, max: 20, value: draft.prematureStopMaxContinuations, onChange: e => update('prematureStopMaxContinuations', Number(e.target.value)) }))
      ),
      h('div', { className: 'cg-card' }, h('h3', null, 'Machine evidence'),
        h(Field, { title: 'Auto-detect checks', description: 'Discover supported tests/build/lint/typecheck commands from project metadata.' }, h(Toggle, { value: draft.autoDetectChecks, onChange: v => update('autoDetectChecks', v) })),
        h(Field, { title: 'Require tests', description: 'A missing executable test command is a blocker in strict readiness.' }, h(Toggle, { value: draft.requireTests, onChange: v => update('requireTests', v) })),
        h(Field, { title: 'Require build when available' }, h(Toggle, { value: draft.requireBuildWhenAvailable, onChange: v => update('requireBuildWhenAvailable', v) })),
        h(Field, { title: 'Require lint when available' }, h(Toggle, { value: draft.requireLintWhenAvailable, onChange: v => update('requireLintWhenAvailable', v) })),
        h(Field, { title: 'Require typecheck when available' }, h(Toggle, { value: draft.requireTypecheckWhenAvailable, onChange: v => update('requireTypecheckWhenAvailable', v) })),
        h(Field, { title: 'Block new TODO/FIXME markers', description: 'Scans added lines for TODO, FIXME, HACK and XXX.' }, h(Toggle, { value: draft.blockNewTodos, onChange: v => update('blockNewTodos', v) })),
        h(Field, { title: 'Security regression scan', description: 'Narrow high-confidence tripwires for obvious newly introduced risks.' }, h(Toggle, { value: draft.securityScan, onChange: v => update('securityScan', v) }))
      ),
      h('div', { className: 'cg-card' }, h('h3', null, 'Completion evidence'),
        h(Field, { title: 'Require final attestation', description: 'Agent must review all changed files and map acceptance criteria to concrete evidence.' }, h(Toggle, { value: draft.requireAttestation, onChange: v => update('requireAttestation', v) })),
        h(Field, { title: 'Gate only changed workspaces', description: 'Skip expensive readiness checks when this session made no repository change.' }, h(Toggle, { value: draft.gateOnlyChangedWorkspaces, onChange: v => update('gateOnlyChangedWorkspaces', v) })),
        h(Field, { title: 'Maximum changed files', description: 'Safety bound for changed-file inventory and attestation.' }, h('input', { className: 'cg-input cg-number', type: 'number', min: 10, max: 5000, value: draft.maxChangedFiles, onChange: e => update('maxChangedFiles', Number(e.target.value)) }))
      ),
      h('div', { className: 'cg-card' }, h('h3', null, 'Execution limits'),
        h(Field, { title: 'Check timeout', description: 'Maximum runtime for each test/build/lint/typecheck/custom command.' }, h('div', { className: 'cg-row' }, h('input', { className: 'cg-input cg-number', type: 'number', min: 1, max: 3600, value: timeoutSeconds, onChange: e => update('commandTimeoutMs', Number(e.target.value) * 1000) }), h('span', { className: 'cg-note' }, 'sec'))),
        h(Field, { title: 'Stored command output', description: 'Maximum sanitized output retained per failed check.' }, h('div', { className: 'cg-row' }, h('input', { className: 'cg-input cg-number', type: 'number', min: 1000, max: 100000, value: draft.maxOutputChars, onChange: e => update('maxOutputChars', Number(e.target.value)) }), h('span', { className: 'cg-note' }, 'chars')))
      ),
      h('div', { className: 'cg-card' }, h('h3', null, 'Verification sources'),
        h(Field, { title: 'Auto-detect a recipe', description: 'Detect how to bootstrap, build, test and boot a project that has no canonical test command.' }, h(Toggle, { value: draft.autoDetectRecipe, onChange: v => update('autoDetectRecipe', v) })),
        h(Field, { title: 'Allow the temporary verifier', description: 'Last resort for a project with no canonical check and no usable recipe. Refused whenever a stronger verifier exists.' }, h(Toggle, { value: draft.allowTemporaryVerifier, onChange: v => update('allowTemporaryVerifier', v) })),
        h(Field, { title: 'Readiness timeout', description: 'How long a recipe start command may take to answer HTTP before the attempt is a failure. Any HTTP status counts as ready.' }, h('div', { className: 'cg-row' }, h('input', { className: 'cg-input cg-number', type: 'number', min: 1, max: 3600, value: Math.round((draft.recipeReadinessTimeoutMs || 0) / 1000), onChange: e => update('recipeReadinessTimeoutMs', Number(e.target.value) * 1000) }), h('span', { className: 'cg-note' }, 'sec'))),
        h(Field, { title: 'Verification nudge limit', description: 'How many times the gate repeats the detailed verification instruction for one change set before switching to a short reminder.' }, h('input', { className: 'cg-input cg-number', type: 'number', min: 0, max: 20, value: draft.verificationNudgeLimit, onChange: e => update('verificationNudgeLimit', Number(e.target.value)) }))
      ),
      h(CustomChecks, { checks: draft.customChecks || [], setChecks: checks => update('customChecks', checks) })
    ),

    h(VerificationOverview, { verification: state.verification }),

    h('div', null, h('h3', null, 'Runtime status'), h('div', { className: 'cg-kpis' }, h(Kpi, { value: state.passed, label: 'Passed sessions' }), h(Kpi, { value: state.blocked, label: 'Blocked sessions' }), h(Kpi, { value: draft.mode, label: 'Mode' }), h(Kpi, { value: draft.gateSubagents ? 'YES' : 'NO', label: 'Gate subagents' }))),
    h('div', { className: 'cg-note' }, 'Commands: /gate · /gate-status · /gate-reset · /gate-override <reason> · Agent tool: completion_gate'),
    (state.sessions || []).length ? h('div', { className: 'cg-grid' }, ...(state.sessions || []).map(row => h('div', { className: 'cg-card cg-session', key: row.sessionId },
      h('div', { className: 'cg-row' }, h('strong', null, row.workspaceLabel), h('span', { className: row.pass ? 'cg-pass' : 'cg-block' }, row.pass ? 'PASS' : 'BLOCKED')),
      h('div', { className: 'cg-pills' }, ...(row.checks || []).map((check, i) => h('span', { className: 'cg-pill', key: i }, `${check.pass ? '✓' : '✕'} ${check.name}`))),
      row.continuationBlocks ? h('div', { className: 'cg-note' }, `Premature stops recovered this turn: ${row.continuationBlocks}`) : null,
      row.blockers?.length ? h('div', { className: 'cg-note' }, row.blockers.slice(0, 4).join(' · ')) : null
    ))) : h('div', { className: 'cg-empty' }, 'No gate report has been generated in this DSH process yet.')
  );
}

function Header() {
  const [state, setState] = useState(null);
  useEffect(() => { let alive = true; const tick = () => getState().then(value => alive && setState(value)).catch(() => {}); void tick(); const timer = setInterval(tick, 5000); return () => { alive = false; clearInterval(timer); }; }, []);
  if (!state) return null;
  const disabled = !state.settings?.enabled;
  const status = disabled ? 'warn' : state.blocked ? 'block' : 'pass';
  const text = disabled ? 'Gate · off' : state.blocked ? `Gate · ${state.blocked} blocked` : 'Gate · ready';
  return h('span', { className: 'cg-header', title: 'Completion Gate' }, h('style', null, css), h('span', { className: `cg-dot ${status}` }), text);
}

exports.inject = ['slots'];
exports.apply = function apply(ctx) {
  ctx.slots.inject('settings.section', () => ctx.slots.register({ name: 'settings.section', id: 'completion-gate', order: 880, label: 'Completion Gate' }, Panel));
  ctx.slots.inject('conversation.session.header.actions', () => ctx.slots.register({ name: 'conversation.session.header.actions', id: 'completion-gate-status', order: 75 }, Header));
};
return module.exports; } });
