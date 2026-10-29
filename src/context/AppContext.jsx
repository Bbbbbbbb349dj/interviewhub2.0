import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { CheckCircle2, AlertTriangle, Info, Trophy, X } from 'lucide-react';
import { storage, KEYS, logActivity } from '../services/storage';
import { evaluateAchievements, getUnlocked } from '../services/gamification';
import { computeAll } from '../services/analyticsService';
import { api, setSignedIn } from '../services/apiClient';
import { refreshAIStatus } from '../services/aiService';
import { startSyncSession, stopSyncSession, getSyncState, subscribeSync, syncNow } from '../services/dbSync';

const AppCtx = createContext(null);
export const useApp = () => useContext(AppCtx);

export function AppProvider({ children }) {
  const [user, setUser] = useState(null);
  const [authReady, setAuthReady] = useState(false);
  const [aiVersion, setAiVersion] = useState(0);
  const [theme, setTheme] = useState(() => storage.get(KEYS.theme) || 'dark');
  const [settings, setSettings] = useState(() => storage.get(KEYS.settings, { ttsRate: 1, ttsVoice: null, notif: true, ttsEnabled: true }));
  const [toasts, setToasts] = useState([]);
  const [statsVersion, setStatsVersion] = useState(0);
  const [syncState, setSyncState] = useState(getSyncState);
  const toastId = useRef(0);

  /* Resume server sync for a restored server session + track sync status. */
  useEffect(() => {
    const unsubscribe = subscribeSync((next) => {
      setSyncState(next);
      if (next.status === 'synced') {
        // A pull may have merged newer docs — reflect them in live state.
        const freshSettings = storage.get(KEYS.settings);
        if (freshSettings) setSettings((s) => ({ ...s, ...freshSettings }));
        const freshTheme = storage.get(KEYS.theme);
        if (freshTheme) setTheme(freshTheme);
        setStatsVersion((v) => v + 1);
      }
    });
    return unsubscribe;
  }, []);

  /* Restore the server session (httpOnly cookie) on load. */
  const enterSession = useCallback((u) => {
    setSignedIn(true);
    setUser(u);
    startSyncSession();
    refreshAIStatus().then(() => setAiVersion((v) => v + 1));
  }, []);

  useEffect(() => {
    let live = true;
    api.me()
      .then(({ user: u }) => { if (live) enterSession(u); })
      .catch(() => { /* not signed in */ })
      .finally(() => { if (live) setAuthReady(true); });
    return () => { live = false; };
  }, [enterSession]);

  useEffect(() => {
    document.documentElement.classList.toggle('dark', theme === 'dark');
    storage.set(KEYS.theme, theme);
  }, [theme]);

  const toast = useCallback((type, title, msg) => {
    const id = ++toastId.current;
    setToasts((t) => [...t, { id, type, title, msg }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), 5200);
  }, []);

  const toggleTheme = useCallback(() => setTheme((t) => (t === 'dark' ? 'light' : 'dark')), []);

  const register = useCallback(async ({ name, email, password }) => {
    const { user: u } = await api.register({ name: name.trim(), email: email.trim().toLowerCase(), password });
    enterSession(u);
    logActivity('account', 'Created account');
    return u;
  }, [enterSession]);

  const login = useCallback(async ({ email, password }) => {
    const { user: u } = await api.login({ email: email.trim().toLowerCase(), password });
    enterSession(u);
    return u;
  }, [enterSession]);

  const logout = useCallback(async () => {
    try { await api.logout(); } catch { /* cookie is cleared server-side when reachable */ }
    stopSyncSession();
    setSignedIn(false);
    setUser(null);
    refreshAIStatus(true);
  }, []);

  const updateProfile = useCallback(async (patch) => {
    const { user: updated } = await api.updateProfile({ name: patch.name, profile: patch.profile });
    setUser(updated);
  }, []);

  const saveSettings = useCallback((patch) => {
    setSettings((s) => {
      const next = { ...s, ...patch };
      storage.set(KEYS.settings, next);
      return next;
    });
  }, []);

  /** Call after saving activity — recomputes achievements & bumps stats. */
  const commitActivity = useCallback((kind, label) => {
    logActivity(kind, label);
    const stats = computeAll();
    const fresh = evaluateAchievements(stats);
    fresh.forEach((a) => toast('gold', `Achievement unlocked — ${a.title}`, a.desc));
    setStatsVersion((v) => v + 1);
  }, [toast]);

  const stats = useMemo(() => computeAll(), [statsVersion, user]);
  const achievements = useMemo(() => getUnlocked(), [statsVersion]);
  const refreshStats = useCallback(() => setStatsVersion((v) => v + 1), []);

  const value = {
    user, authReady, aiVersion, register, login, logout, updateProfile,
    theme, toggleTheme, toast,
    settings, saveSettings,
    stats, achievements, commitActivity, refreshStats,
    syncState, syncNow,
  };

  const dismissToast = useCallback((id) => setToasts((t) => t.filter((x) => x.id !== id)), []);

  return (
    <AppCtx.Provider value={value}>
      {children}
      <ToastViewport toasts={toasts} onDismiss={dismissToast} />
    </AppCtx.Provider>
  );
}

const TOAST_META = {
  success: { icon: CheckCircle2, bar: 'from-emerald-500 to-teal-400' },
  error: { icon: AlertTriangle, bar: 'from-rose-500 to-orange-400' },
  info: { icon: Info, bar: 'from-blue-500 to-cyan-400' },
  gold: { icon: Trophy, bar: 'from-yellow-400 to-orange-400' },
};

function ToastViewport({ toasts, onDismiss }) {
  return (
    <div className="fixed bottom-20 sm:bottom-6 right-4 z-[100] flex w-[min(92vw,360px)] flex-col gap-2" role="status" aria-live="polite">
      <AnimatePresence>
        {toasts.map((t) => {
          const M = TOAST_META[t.type] || TOAST_META.info;
          return (
            <motion.div
              key={t.id}
              initial={{ opacity: 0, x: 60, scale: 0.95 }}
              animate={{ opacity: 1, x: 0, scale: 1 }}
              exit={{ opacity: 0, x: 40, scale: 0.95 }}
              className="overflow-hidden rounded-xl border border-line bg-raise shadow-xl shadow-slate-900/10 dark:shadow-black/40"
            >
              <div className={`h-1 w-full bg-gradient-to-r ${M.bar}`} />
              <div className="flex items-start gap-3 p-3.5">
                <M.icon size={20} className="mt-0.5 shrink-0 text-slate-700 dark:text-slate-200" />
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-semibold text-slate-900 dark:text-white">{t.title}</p>
                  {t.msg && <p className="mt-0.5 text-xs leading-relaxed text-slate-500 dark:text-slate-400">{t.msg}</p>}
                </div>
                <button onClick={() => onDismiss?.(t.id)} className="text-slate-400 hover:text-slate-600 dark:hover:text-slate-200" aria-label="Dismiss">
                  <X size={15} />
                </button>
              </div>
            </motion.div>
          );
        })}
      </AnimatePresence>
    </div>
  );
}
