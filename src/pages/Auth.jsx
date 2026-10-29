import React, { useEffect, useState } from 'react';
import { useNavigate, useSearchParams, Link } from 'react-router-dom';
import { useForm } from 'react-hook-form';
import { motion } from 'framer-motion';
import { Mail, Lock, User, ArrowRight, Sparkles, Eye, EyeOff } from 'lucide-react';
import { Logo, Btn, Field, Input, Badge } from '../components/ui';
import { useApp } from '../context/AppContext';
import { api, getApiUrl } from '../services/apiClient';
import { TAGLINE } from '../constants';

const GOOGLE_ERRORS = {
  google_cancelled: 'Google sign-in was cancelled.',
  google_failed: 'Google sign-in failed. Please try again.',
  google_unavailable: 'Google sign-in is not available right now.',
};
const legacyFlag = () => { try { return localStorage.getItem('ihub:legacyAccounts') === '1'; } catch { return false; } };

export default function Auth() {
  const [params] = useSearchParams();
  const resetToken = params.get('token') || '';
  const initial = params.get('mode') === 'reset' && resetToken ? 'reset' : params.get('mode') === 'register' ? 'register' : 'login';
  const [mode, setMode] = useState(initial); // login | register | forgot | reset
  const [showPw, setShowPw] = useState(false);
  const [serverError, setServerError] = useState(GOOGLE_ERRORS[params.get('error')] || '');
  const [notice, setNotice] = useState('');
  const [googleOn, setGoogleOn] = useState(false);
  const [legacy, setLegacy] = useState(legacyFlag);
  const { login, register, toast } = useApp();
  const navigate = useNavigate();
  const { register: reg, handleSubmit, watch, reset: resetForm, formState: { errors, isSubmitting } } = useForm();

  useEffect(() => {
    api.providers().then((p) => setGoogleOn(Boolean(p?.google))).catch(() => setGoogleOn(false));
  }, []);

  const switchMode = (m) => { setMode(m); setServerError(''); setNotice(''); resetForm(); };
  const clearLegacy = () => { try { localStorage.removeItem('ihub:legacyAccounts'); } catch { /* noop */ } setLegacy(false); };

  const onSubmit = async (values) => {
    setServerError(''); setNotice('');
    try {
      if (mode === 'register') {
        const acc = await register({ name: values.name, email: values.email, password: values.password });
        clearLegacy();
        toast('success', `Welcome, ${acc.name.split(' ')[0]}!`, 'Your account is ready.');
        navigate('/dashboard');
      } else if (mode === 'login') {
        const acc = await login({ email: values.email, password: values.password });
        clearLegacy();
        toast('success', `Welcome back, ${acc.name.split(' ')[0]}.`);
        navigate('/dashboard');
      } else if (mode === 'forgot') {
        const r = await api.forgot(values.email.trim());
        setNotice(r.message);
      } else {
        await api.reset({ token: resetToken, password: values.password });
        toast('success', 'Password updated', 'Log in with your new password.');
        navigate('/auth', { replace: true });
        switchMode('login');
      }
    } catch (e) {
      setServerError(e.message);
    }
  };

  const googleHref = `${getApiUrl()}/api/auth/google/start`;
  const title = { register: 'Create your account', login: 'Welcome back', forgot: 'Forgot your password?', reset: 'Set a new password' }[mode];
  const sub = {
    register: 'Start your preparation journey in under a minute.', login: 'Pick up right where you left off.',
    forgot: "Enter your email and we'll send you a reset link.", reset: 'Choose a new password for your account.',
  }[mode];
  const needsPassword = mode === 'register' || mode === 'login' || mode === 'reset';

  return (
    <div className="grid min-h-screen pt-16 lg:grid-cols-[1.05fr_1fr]">
      {/* Brand panel */}
      <div className="relative hidden overflow-hidden border-r border-line bg-sunken lg:block">
        <div className="absolute inset-0 spotlight" />
        <div className="absolute inset-0 grid-lines" />
        <div className="relative flex h-full flex-col justify-between p-12">
          <Link to="/"><Logo /></Link>
          <div>
            <Badge className="border border-slate-900/10 bg-white/70 px-4 py-1.5 text-xs text-slate-600 backdrop-blur dark:border-white/15 dark:bg-white/5 dark:text-slate-200">
              <Sparkles size={12} className="text-cyan-500 dark:text-cyan-300" /> Complete interview preparation
            </Badge>
            <h1 className="mt-6 font-display text-5xl font-bold leading-[1.08] text-slate-900 dark:text-white">
              {TAGLINE[0]}<br />
              <span className="bg-gradient-to-r from-blue-400 to-cyan-300 bg-clip-text text-transparent">{TAGLINE[1]}</span><br />
              <span className="bg-gradient-to-r from-pink-400 to-orange-300 bg-clip-text text-transparent">{TAGLINE[2]}</span>
            </h1>
            <p className="mt-5 max-w-md leading-relaxed text-slate-600 dark:text-slate-400">
              AI interviews, resume analysis, coding, aptitude and communication coaching — one account, five disciplines, zero fake numbers.
            </p>
          </div>
          <div className="flex gap-3">
            {['AI Interviews', 'Coding Arena', 'Aptitude', 'Resume ATS'].map((t, i) => (
              <span key={t} className={`rounded-full border border-slate-900/10 bg-white/70 px-4 py-2 text-xs font-semibold shadow-sm dark:border-white/10 dark:bg-white/5 dark:shadow-none ${['text-cyan-600 dark:text-cyan-300', 'text-emerald-600 dark:text-emerald-300', 'text-amber-600 dark:text-amber-300', 'text-orange-600 dark:text-orange-300'][i]}`}>{t}</span>
            ))}
          </div>
        </div>
      </div>

      {/* Form panel */}
      <div className="flex items-center justify-center bg-transparent px-4 py-12 sm:px-8">
        <motion.div initial={{ opacity: 0, y: 24 }} animate={{ opacity: 1, y: 0 }} className="w-full max-w-md">
          <div className="lg:hidden"><Logo /></div>
          <h2 className="mt-6 font-display text-2xl font-bold text-slate-900 dark:text-white sm:text-3xl">{title}</h2>
          <p className="mt-2 text-sm text-slate-500 dark:text-slate-400">{sub}</p>

          {legacy && (mode === 'login' || mode === 'register') && (
            <p className="mt-4 rounded-xl border border-line bg-raise px-4 py-3 text-xs leading-relaxed text-slate-500 dark:text-slate-400">
              Accounts created on this device before this update were not migrated to the server. Please create a new account.
            </p>
          )}

          <form onSubmit={handleSubmit(onSubmit)} className="mt-8 space-y-4" noValidate>
            {mode === 'register' && (
              <Field label="Full name" error={errors.name?.message}>
                <div className="relative">
                  <User size={16} className="absolute left-3.5 top-1/2 -translate-y-1/2 text-slate-400" />
                  <Input className="pl-10" placeholder="Ada Lovelace" autoComplete="name"
                    {...reg('name', { required: 'Name is required', minLength: { value: 2, message: 'At least 2 characters' } })} />
                </div>
              </Field>
            )}
            {mode !== 'reset' && (
              <Field label="Email" error={errors.email?.message}>
                <div className="relative">
                  <Mail size={16} className="absolute left-3.5 top-1/2 -translate-y-1/2 text-slate-400" />
                  <Input className="pl-10" type="email" placeholder="you@example.com" autoComplete="email"
                    {...reg('email', { required: 'Email is required', pattern: { value: /^[^\s@]+@[^\s@]+\.[^\s@]+$/, message: 'Enter a valid email' } })} />
                </div>
              </Field>
            )}
            {needsPassword && (
              <Field label={mode === 'reset' ? 'New password' : 'Password'} error={errors.password?.message}>
                <div className="relative">
                  <Lock size={16} className="absolute left-3.5 top-1/2 -translate-y-1/2 text-slate-400" />
                  <Input className="pl-10 pr-10" type={showPw ? 'text' : 'password'} placeholder="••••••••" autoComplete={mode === 'login' ? 'current-password' : 'new-password'}
                    {...reg('password', { required: 'Password is required', minLength: { value: 8, message: 'At least 8 characters' } })} />
                  <button type="button" onClick={() => setShowPw(!showPw)} className="absolute right-3.5 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-600" aria-label="Toggle password visibility">
                    {showPw ? <EyeOff size={16} /> : <Eye size={16} />}
                  </button>
                </div>
              </Field>
            )}
            {(mode === 'register' || mode === 'reset') && (
              <Field label="Confirm password" error={errors.confirm?.message}>
                <div className="relative">
                  <Lock size={16} className="absolute left-3.5 top-1/2 -translate-y-1/2 text-slate-400" />
                  <Input className="pl-10" type="password" placeholder="••••••••" autoComplete="new-password"
                    {...reg('confirm', { required: 'Please confirm your password', validate: (v) => v === watch('password') || 'Passwords do not match' })} />
                </div>
              </Field>
            )}
            {mode === 'login' && (
              <div className="text-right">
                <button type="button" onClick={() => switchMode('forgot')} className="text-xs font-semibold text-cyan-600 hover:underline dark:text-cyan-400">Forgot Password?</button>
              </div>
            )}

            {serverError && (
              <motion.p initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="rounded-xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm font-medium text-rose-600 dark:border-rose-500/30 dark:bg-rose-500/10 dark:text-rose-300">
                {serverError}
              </motion.p>
            )}
            {notice && (
              <p className="rounded-xl border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm font-medium text-emerald-700 dark:border-emerald-500/30 dark:bg-emerald-500/10 dark:text-emerald-300">{notice}</p>
            )}

            <Btn type="submit" size="lg" className="w-full" loading={isSubmitting}>
              {{ register: 'Create account', login: 'Log in', forgot: 'Send reset link', reset: 'Update password' }[mode]} <ArrowRight size={16} />
            </Btn>
          </form>

          {googleOn && (mode === 'login' || mode === 'register') && (
            <>
              <div className="my-5 flex items-center gap-3 text-xs text-slate-400"><span className="h-px flex-1 bg-slate-200 dark:bg-slate-700" />or<span className="h-px flex-1 bg-slate-200 dark:bg-slate-700" /></div>
              <a href={googleHref} className="flex w-full items-center justify-center gap-2 rounded-xl border border-line bg-raise px-4 py-3 text-sm font-semibold text-slate-700 transition-colors hover:bg-slate-50 dark:text-slate-200 dark:hover:bg-slate-800">
                <svg width="18" height="18" viewBox="0 0 48 48" aria-hidden="true"><path fill="#EA4335" d="M24 9.5c3.5 0 6.6 1.2 9.1 3.6l6.8-6.8C35.8 2.4 30.3 0 24 0 14.6 0 6.5 5.4 2.6 13.2l7.9 6.1C12.4 13.6 17.7 9.5 24 9.5z"/><path fill="#4285F4" d="M46.5 24.5c0-1.6-.1-3.1-.4-4.5H24v9h12.7c-.6 3-2.3 5.5-4.8 7.2l7.5 5.8c4.4-4.1 7.1-10.1 7.1-17.5z"/><path fill="#FBBC05" d="M10.5 28.7c-.5-1.4-.8-3-.8-4.7s.3-3.2.8-4.7l-7.9-6.1C.9 16.4 0 20.1 0 24s.9 7.6 2.6 10.8l7.9-6.1z"/><path fill="#34A853" d="M24 48c6.5 0 11.9-2.1 15.9-5.8l-7.5-5.8c-2.1 1.4-4.8 2.3-8.4 2.3-6.3 0-11.6-4.1-13.5-9.8l-7.9 6.1C6.5 42.6 14.6 48 24 48z"/></svg>
                Continue with Google
              </a>
            </>
          )}

          <p className="mt-6 text-center text-sm text-slate-500 dark:text-slate-400">
            {mode === 'forgot' || mode === 'reset' ? (
              <button className="font-bold text-cyan-600 hover:underline dark:text-cyan-400" onClick={() => switchMode('login')}>Back to log in</button>
            ) : (
              <>
                {mode === 'register' ? 'Already have an account? ' : 'New to InterviewHub? '}
                <button className="font-bold text-cyan-600 hover:underline dark:text-cyan-400" onClick={() => switchMode(mode === 'register' ? 'login' : 'register')}>
                  {mode === 'register' ? 'Log in' : 'Create one free'}
                </button>
              </>
            )}
          </p>
        </motion.div>
      </div>
    </div>
  );
}
