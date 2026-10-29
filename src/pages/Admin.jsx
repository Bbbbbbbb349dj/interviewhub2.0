import React, { useCallback, useEffect, useState } from 'react';
import { KeyRound, CheckCircle2, AlertTriangle, Trash2, ShieldCheck } from 'lucide-react';
import { Page, Container } from '../components/layout';
import { Card, Btn, Badge, Field, inputCls } from '../components/ui';
import { useApp } from '../context/AppContext';
import { api } from '../services/apiClient';
import { refreshAIStatus } from '../services/aiService';

const PROVIDERS = [
  { id: 'openai', label: 'OpenAI API key', placeholder: 'sk-…', hint: 'Preferred provider when both are configured.' },
  { id: 'gemini', label: 'Google Gemini API key', placeholder: 'AIza…', hint: 'Used when no OpenAI key is configured.' },
];

export default function Admin() {
  const { toast } = useApp();
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const [values, setValues] = useState({ openai: '', gemini: '' });
  const [busy, setBusy] = useState('');

  const load = useCallback(async () => {
    try { setData(await api.adminAi()); setError(''); } catch (e) { setError(e.message); }
  }, []);
  useEffect(() => { load(); }, [load]);

  const run = async (id, fn, okMsg) => {
    setBusy(id);
    try {
      setData(await fn());
      setValues((v) => ({ ...v, [id]: '' }));
      await refreshAIStatus();
      toast('success', okMsg);
    } catch (e) {
      toast('error', 'Request failed', e.message);
    } finally { setBusy(''); }
  };

  return (
    <Page>
      <Container className="max-w-3xl space-y-6 pt-8">
        <h1 className="flex items-center gap-2 font-display text-2xl font-bold text-slate-900 dark:text-white"><ShieldCheck size={22} /> Admin</h1>
        <Card className="p-6">
          <div className="flex items-center gap-2"><KeyRound size={18} /><h2 className="font-display text-lg font-bold text-slate-900 dark:text-white">AI providers</h2></div>
          <p className="mt-2 text-sm text-slate-500 dark:text-slate-400">Keys are encrypted on the server and never sent back to the browser. They power the AI interview, resume and coding features.</p>
          {error && <p className="mt-4 rounded-xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-600 dark:border-rose-500/30 dark:bg-rose-500/10 dark:text-rose-300">{error}</p>}
          {!data && !error && <p className="mt-4 text-sm text-slate-400">Loading…</p>}
          {data && !data.encryptionReady && (
            <p className="mt-4 rounded-xl border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-700 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-300">SETTINGS_ENCRYPTION_KEY is not set on the server, so keys cannot be saved yet.</p>
          )}
          {data && PROVIDERS.map((p) => {
            const st = data.providers[p.id];
            return (
              <div key={p.id} className="mt-6 border-t border-line pt-5">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span className="text-sm font-semibold text-slate-700 dark:text-slate-200">{p.label}</span>
                  <Badge className={st.configured ? 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400' : 'bg-rose-500/10 text-rose-500'}>
                    {st.configured ? <><CheckCircle2 size={12} /> Configured {st.hint}</> : <><AlertTriangle size={12} /> Not configured</>}
                  </Badge>
                </div>
                <Field label={st.configured ? 'Replace key' : 'Add key'} hint={p.hint}>
                  <input type="password" autoComplete="off" value={values[p.id]} placeholder={p.placeholder} className={inputCls}
                    onChange={(e) => setValues((v) => ({ ...v, [p.id]: e.target.value }))} />
                </Field>
                <div className="mt-3 flex gap-3">
                  <Btn size="sm" icon={ShieldCheck} loading={busy === p.id} disabled={!values[p.id].trim() || !data.encryptionReady}
                    onClick={() => run(p.id, () => api.adminSetKey(p.id, values[p.id].trim()), 'Key saved')}>Save key</Btn>
                  {st.configured && <Btn size="sm" variant="ghost" icon={Trash2} className="text-rose-500" loading={busy === p.id + 'rm'}
                    onClick={() => run(p.id + 'rm', () => api.adminRemoveKey(p.id), 'Key removed')}>Remove</Btn>}
                </div>
              </div>
            );
          })}
        </Card>
      </Container>
    </Page>
  );
}
