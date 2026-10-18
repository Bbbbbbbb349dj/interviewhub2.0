import React, { useEffect, useRef, useState } from 'react';
import {
  Sun, Moon, KeyRound, ShieldCheck, Volume2, Bell, Database, Download, Upload,
  Trash2, CheckCircle2, AlertTriangle, Eye, EyeOff, PlugZap,
} from 'lucide-react';
import { Page, Container, FeatureHeader } from '../components/layout';
import { Card, Btn, Badge, Field, Select, Toggle, Modal, inputCls } from '../components/ui';
import { FEATURES } from '../constants';
import { useApp } from '../context/AppContext';
import { byok, getAIConfig, aiProviderLabel, askJSON } from '../services/aiService';
import { exportAllData, importAllData, storage, dbInfo, fmtDateTime } from '../services/storage';
import { api, getApiUrl, setApiUrl, envApiUrl, probeServer, getSession } from '../services/apiClient';
import { wipeRemoteData } from '../services/dbSync';
import { ttsSupported, speak } from '../hooks/useSpeech';

export default function Settings() {
  const { theme, toggleTheme, settings, saveSettings, toast, syncState, syncNow } = useApp();
  const [apiUrl, setApiUrlInput] = useState(() => getApiUrl());
  const [serverUp, setServerUp] = useState(null);
  const [probing, setProbing] = useState(false);
  const [openai, setOpenai] = useState('');
  const [gemini, setGemini] = useState('');
  const [showKeys, setShowKeys] = useState(false);
  const [testing, setTesting] = useState(false);
  const [voices, setVoices] = useState([]);
  const [confirmClear, setConfirmClear] = useState(false);
  const [db, setDb] = useState(null);
  const fileRef = useRef(null);
  const cfg = getAIConfig();

  useEffect(() => {
    let live = true;
    dbInfo().then((info) => { if (live) setDb(info); });
    return () => { live = false; };
  }, [confirmClear]);

  useEffect(() => {
    if (getApiUrl()) probeNow(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!ttsSupported()) return;
    const load = () => setVoices(window.speechSynthesis.getVoices().filter((v) => v.lang.startsWith('en')));
    load();
    window.speechSynthesis.onvoiceschanged = load;
    return () => { window.speechSynthesis.onvoiceschanged = null; };
  }, []);

  const saveKeys = () => {
    if (openai.trim() || gemini.trim()) {
      byok.set({ openai: openai.trim() || undefined, gemini: gemini.trim() || undefined });
      setOpenai(''); setGemini('');
      toast('success', 'AI key saved', getAIConfig() ? `Active provider: ${aiProviderLabel()}` : 'Key stored in your local database.');
    } else {
      toast('info', 'Nothing to save', 'Paste a key first.');
    }
  };

  const testConnection = async () => {
    setTesting(true);
    try {
      const r = await askJSON('Respond with JSON: {"ok":true}', 'Ping');
      toast(r.ok ? 'success' : 'info', 'Connection successful', `${aiProviderLabel()} responded correctly.`);
    } catch (e) {
      toast('error', 'Connection failed', e.message);
    } finally {
      setTesting(false);
    }
  };

  const doExport = () => {
    const blob = new Blob([JSON.stringify(exportAllData(), null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `interviewhub-export-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    URL.revokeObjectURL(url);
    toast('success', 'Data exported', 'A JSON backup of all your local data was downloaded.');
  };

  const doImport = async (file) => {
    if (!file) return;
    try {
      const text = await file.text();
      importAllData(JSON.parse(text));
      toast('success', 'Data imported', 'Reloading to apply your data…');
      setTimeout(() => window.location.reload(), 900);
    } catch (e) {
      toast('error', 'Import failed', e.message || 'That file is not a valid InterviewHub export.');
    }
  };

  const doClear = async () => {
    /* Server mode: delete the account + all synced rows in PostgreSQL too. */
    const session = getSession();
    if (session?.mode === 'server') {
      try { await wipeRemoteData(); } catch { /* best effort */ }
      try { await api.deleteAccount(); } catch { /* best effort */ }
    }
    storage.clearAll();
    setConfirmClear(false);
    toast('info', 'All data cleared', 'Your local database and synced server data were removed.');
    setTimeout(() => { window.location.href = '#/auth'; window.location.reload(); }, 900);
  };

  const probeNow = async (quiet = false) => {
    setProbing(true);
    const up = await probeServer(true);
    setServerUp(up);
    setProbing(false);
    if (!quiet) {
      toast(up ? 'success' : 'error', up ? 'Connected to PostgreSQL' : 'Server unreachable',
        up ? 'The API answered and its PostgreSQL database is up.' : 'Check that the API is running (docker compose up) and the URL is correct.');
    }
    return up;
  };

  const saveApiUrl = async () => {
    setApiUrl(apiUrl);
    toast('success', 'API URL saved', apiUrl.trim() ? 'Testing the connection…' : 'Server sync disabled — running on the local database only.');
    if (apiUrl.trim()) await probeNow();
    else setServerUp(null);
  };

  const doSyncNow = async () => {
    const result = await syncNow({ pull: true });
    if (result.status === 'synced') toast('success', 'Synced with PostgreSQL', 'Your local replica and the server database are in agreement.');
    else toast('error', 'Sync did not complete', result.lastError || 'The server could not be reached.');
  };

  return (
    <Page>
      <Container className="max-w-3xl space-y-6 pt-8">
        <FeatureHeader feature="analytics" title="Settings" desc="Theme, AI provider, voice and full control over your data." />

        {/* Appearance */}
        <Card className="p-6">
          <SectionTitle icon={theme === 'dark' ? Moon : Sun} title="Appearance" />
          <div className="mt-4 grid grid-cols-2 gap-3">
            {[['light', Sun, 'Light', 'Bright, colorful surfaces'], ['dark', Moon, 'Dark', 'Cinematic deep neutrals']].map(([m, Icon, l, d]) => (
              <button
                key={m}
                onClick={() => theme !== m && toggleTheme()}
                className={`rounded-2xl border-2 p-4 text-left transition-all ${theme === m ? 'border-cyan-500 bg-cyan-50 dark:bg-cyan-400/10' : 'border-slate-200 hover:border-slate-300 dark:border-slate-700'}`}
              >
                <Icon size={18} className={theme === m ? 'text-cyan-500' : 'text-slate-400'} />
                <p className="mt-2 text-sm font-bold text-slate-800 dark:text-slate-100">{l}</p>
                <p className="text-xs text-slate-400">{d}</p>
              </button>
            ))}
          </div>
        </Card>

        {/* AI provider */}
        <Card className="p-6">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <SectionTitle icon={KeyRound} title="AI provider" />
            <Badge className={cfg ? 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400' : 'bg-rose-500/10 text-rose-500'}>
              {cfg ? <><CheckCircle2 size={12} /> Active: {aiProviderLabel()}</> : <><AlertTriangle size={12} /> No key configured</>}
            </Badge>
          </div>
          <p className="mt-2 text-sm leading-relaxed text-slate-500 dark:text-slate-400">
            Interviews, resume deep-analysis and code review call a real LLM. Paste a key below — it is stored in <b>your browser's local IndexedDB database</b> and sent only to the provider you choose. Keys <b>never</b> leave this device.
          </p>
          <div className="mt-5 grid gap-4">
            <Field label="OpenAI API key" hint="Preferred provider when present. e.g. sk-…">
              <div className="relative">
                <input type={showKeys ? 'text' : 'password'} value={openai} onChange={(e) => setOpenai(e.target.value)} placeholder={byok.has() ? 'A key is saved in your local database' : 'sk-…'} className={`${inputCls} pr-12`} autoComplete="off" />
                <button type="button" onClick={() => setShowKeys(!showKeys)} className="absolute right-3.5 top-1/2 -translate-y-1/2 text-slate-400" aria-label="Toggle key visibility">{showKeys ? <EyeOff size={15} /> : <Eye size={15} />}</button>
              </div>
            </Field>
            <Field label="Google Gemini API key" hint="Used when no OpenAI key is present.">
              <input type={showKeys ? 'text' : 'password'} value={gemini} onChange={(e) => setGemini(e.target.value)} placeholder="AIza…" className={inputCls} autoComplete="off" />
            </Field>
          </div>
          <div className="mt-5 flex flex-wrap gap-3">
            <Btn size="sm" icon={ShieldCheck} onClick={saveKeys}>Save key</Btn>
            <Btn size="sm" variant="outline" icon={PlugZap} onClick={testConnection} loading={testing} disabled={!cfg}>Test connection</Btn>
            {byok.has() && <Btn size="sm" variant="ghost" className="text-rose-500" onClick={() => { byok.clear(); toast('info', 'Saved keys removed'); }}>Remove saved keys</Btn>}
          </div>
          <div className="mt-5 rounded-xl bg-slate-50 p-4 text-xs leading-relaxed text-slate-500 dark:bg-slate-800/60 dark:text-slate-400">
            <b className="text-slate-700 dark:text-slate-200">Developers:</b> bake keys in at build time with <code className="rounded bg-slate-200 px-1.5 py-0.5 dark:bg-slate-700">VITE_OPENAI_API_KEY</code> / <code className="rounded bg-slate-200 px-1.5 py-0.5 dark:bg-slate-700">VITE_GEMINI_API_KEY</code> (see <code className="rounded bg-slate-200 px-1.5 py-0.5 dark:bg-slate-700">.env.example</code>). Note: keys bundled into a client build are visible to anyone with the bundle — for production, proxy through a server. Optional model overrides: <code className="rounded bg-slate-200 px-1.5 py-0.5 dark:bg-slate-700">VITE_OPENAI_MODEL</code>, <code className="rounded bg-slate-200 px-1.5 py-0.5 dark:bg-slate-700">VITE_GEMINI_MODEL</code>.
          </div>
        </Card>

        {/* Voice */}
        <Card className="p-6">
          <SectionTitle icon={Volume2} title="Voice & speech" />
          {!ttsSupported() && <p className="mt-2 text-sm text-amber-600 dark:text-amber-400">This browser does not support speech synthesis — AI answers will be text-only.</p>}
          <div className="mt-4 space-y-5">
            <div className="flex items-center justify-between gap-4">
              <div>
                <p className="text-sm font-semibold text-slate-700 dark:text-slate-200">Read AI questions aloud</p>
                <p className="text-xs text-slate-400">Text-to-speech during interviews</p>
              </div>
              <Toggle checked={settings.ttsEnabled} onChange={(v) => saveSettings({ ttsEnabled: v })} label="Read questions aloud" />
            </div>
            <div>
              <div className="flex items-center justify-between text-sm">
                <p className="font-semibold text-slate-700 dark:text-slate-200">Speech rate</p>
                <span className="font-mono text-xs text-slate-400">{settings.ttsRate}×</span>
              </div>
              <input type="range" min="0.6" max="1.4" step="0.1" value={settings.ttsRate} onChange={(e) => saveSettings({ ttsRate: +e.target.value })} className="mt-2 w-full" aria-label="Speech rate" />
            </div>
            {voices.length > 0 && (
              <Field label="Voice">
                <Select value={settings.ttsVoice || ''} onChange={(e) => saveSettings({ ttsVoice: e.target.value || null })}>
                  <option value="">System default</option>
                  {voices.slice(0, 14).map((v) => <option key={v.voiceURI} value={v.voiceURI}>{v.name} ({v.lang})</option>)}
                </Select>
              </Field>
            )}
            <Btn size="sm" variant="outline" onClick={() => speak('Hi, I am Iris, your InterviewHub interviewer. Let us begin whenever you are ready.', { rate: settings.ttsRate, voiceURI: settings.ttsVoice })}>Preview voice</Btn>
          </div>
        </Card>

        {/* Preferences */}
        <Card className="p-6">
          <SectionTitle icon={Bell} title="Preferences" />
          <div className="mt-4 flex items-center justify-between gap-4">
            <div>
              <p className="text-sm font-semibold text-slate-700 dark:text-slate-200">Practice reminders</p>
              <p className="text-xs text-slate-400">Preference stored locally; used for in-app nudges</p>
            </div>
            <Toggle checked={settings.notif} onChange={(v) => saveSettings({ notif: v })} label="Practice reminders" />
          </div>
        </Card>

        {/* Server database (PostgreSQL) */}
        <Card className="p-6">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <SectionTitle icon={Database} title="Server database — PostgreSQL" />
            <Badge className={
              syncState?.status === 'synced' ? 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400'
              : syncState?.status === 'syncing' ? 'bg-cyan-500/10 text-cyan-600 dark:text-cyan-400'
              : serverUp ? 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400'
              : 'bg-slate-500/10 text-slate-500 dark:text-slate-400'
            }>
              {syncState?.status === 'syncing' ? 'Syncing…'
                : syncState?.status === 'synced' ? 'Synced with PostgreSQL'
                : !getApiUrl() ? 'Local database only'
                : serverUp === null ? 'Checking server…'
                : serverUp ? 'Server reachable' : 'Server unreachable'}
            </Badge>
          </div>
          <p className="mt-2 text-sm leading-relaxed text-slate-500 dark:text-slate-400">
            InterviewHub's system of record is <b>PostgreSQL</b>, served by the API in the <code className="rounded bg-slate-200 px-1.5 py-0.5 dark:bg-slate-700">server/</code> folder — start both with <code className="rounded bg-slate-200 px-1.5 py-0.5 dark:bg-slate-700">docker compose up</code>, then point the app at the API below. Your device keeps a local IndexedDB replica so everything keeps working offline and syncs when the server returns.
          </p>
          <div className="mt-5">
            <Field label="API URL" hint={envApiUrl() ? 'Set at build time via VITE_API_URL.' : 'Where the InterviewHub API runs, e.g. http://localhost:4000'}>
              <input
                value={apiUrl}
                onChange={(e) => setApiUrlInput(e.target.value)}
                placeholder="http://localhost:4000"
                disabled={Boolean(envApiUrl())}
                className={inputCls}
                autoComplete="off"
              />
            </Field>
          </div>
          <div className="mt-4 flex flex-wrap gap-3">
            <Btn size="sm" icon={ShieldCheck} onClick={saveApiUrl} disabled={Boolean(envApiUrl())}>Save API URL</Btn>
            <Btn size="sm" variant="outline" icon={PlugZap} onClick={() => probeNow()} loading={probing} disabled={!getApiUrl()}>Test connection</Btn>
            <Btn size="sm" variant="outline" icon={Database} onClick={doSyncNow} disabled={!getApiUrl() || syncState?.status === 'syncing'}>Sync now</Btn>
          </div>
          <div className="mt-4 flex flex-wrap items-center gap-x-5 gap-y-1 text-xs text-slate-400">
            <span>Status: <b className="text-slate-600 dark:text-slate-300">{syncState?.status || 'local'}</b></span>
            {syncState?.lastSyncedAt && <span>Last synced: <b className="text-slate-600 dark:text-slate-300">{fmtDateTime(syncState.lastSyncedAt)}</b></span>}
            {syncState?.lastError && <span className="text-rose-500">{syncState.lastError}</span>}
          </div>
          <div className="mt-4 rounded-xl bg-slate-50 p-4 text-xs leading-relaxed text-slate-500 dark:bg-slate-800/60 dark:text-slate-400">
            When an API URL is set, <b className="text-slate-700 dark:text-slate-200">sign-ups & logins run against PostgreSQL</b> (bcrypt + JWT) and your interviews, submissions, tests and analyses sync into their tables automatically. AI provider keys are never synced — they stay on this device.
          </div>
        </Card>

        {/* Data management */}
        <Card className="p-6">
          <SectionTitle icon={Database} title="Your data" />
          <p className="mt-2 text-sm text-slate-500 dark:text-slate-400">Your on-device IndexedDB replica (and anything synced to PostgreSQL) is fully under your control. Back it up, move it, or wipe it.</p>
          {db && (
            <div className="mt-4 flex flex-wrap items-center gap-2">
              <Badge className={db.engine === 'indexeddb' ? 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400' : 'bg-amber-500/10 text-amber-600 dark:text-amber-400'}>
                <Database size={11} /> {db.engine === 'indexeddb' ? 'IndexedDB engine connected' : 'In-memory fallback (this session only)'}
              </Badge>
              {db.engine === 'indexeddb' && (
                <>
                  <Badge className="bg-slate-500/10 text-slate-500 dark:text-slate-400">{db.dbName}</Badge>
                  <Badge className="bg-slate-500/10 text-slate-500 dark:text-slate-400">{db.documents} document{db.documents === 1 ? '' : 's'} stored</Badge>
                </>
              )}
            </div>
          )}
          <div className="mt-5 grid gap-3 sm:grid-cols-3">
            <Btn variant="outline" icon={Download} onClick={doExport}>Export JSON</Btn>
            <Btn variant="outline" icon={Upload} onClick={() => fileRef.current?.click()}>Import JSON</Btn>
            <Btn variant="danger" icon={Trash2} onClick={() => setConfirmClear(true)}>Clear all data</Btn>
          </div>
          <input ref={fileRef} type="file" accept=".json" className="hidden" onChange={(e) => { doImport(e.target.files?.[0]); e.target.value = ''; }} />
          <p className="mt-3 text-xs text-slate-400">Import validates the file structure before applying it. You will stay signed in after import.</p>
        </Card>

        <Modal open={confirmClear} onClose={() => setConfirmClear(false)} title="Clear everything?">
          <div className="rounded-xl border border-rose-200 bg-rose-50 p-4 text-sm text-rose-700 dark:border-rose-500/30 dark:bg-rose-500/10 dark:text-rose-300">
            This permanently deletes your account, interviews, submissions, tests, resume analyses, achievements and settings from this browser. Export first if you want a backup.
          </div>
          <div className="mt-6 flex justify-end gap-3">
            <Btn variant="ghost" onClick={() => setConfirmClear(false)}>Keep my data</Btn>
            <Btn variant="danger" icon={Trash2} onClick={doClear}>Delete everything</Btn>
          </div>
        </Modal>
      </Container>
    </Page>
  );
}

function SectionTitle({ icon: Icon, title }) {
  return (
    <h3 className="flex items-center gap-2.5 font-display text-lg font-bold text-slate-900 dark:text-white">
      <span className="grid h-8 w-8 place-items-center rounded-lg bg-gradient-to-br from-slate-600 to-slate-500 text-white"><Icon size={15} /></span>
      {title}
    </h3>
  );
}
