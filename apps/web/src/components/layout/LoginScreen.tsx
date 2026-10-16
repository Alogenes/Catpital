import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useSession } from '../../stores/session';

/** 不在 Discord 内运行时的本地调试登录（后端 DEV_LOGIN=1） */
export function LoginScreen({ onLogin }: { onLogin: (userId: string, username: string) => void }) {
  const { t } = useTranslation();
  const error = useSession((s) => s.error);
  const [userId, setUserId] = useState(() => localStorageGet('catpital.dev.uid') ?? String(100000000000000000n + BigInt(Math.floor(Math.random() * 1e9))));
  const [username, setUsername] = useState(() => localStorageGet('catpital.dev.name') ?? 'tester');

  return (
    <div className="flex min-h-screen items-center justify-center p-4">
      <form
        className="w-full max-w-sm rounded-2xl border border-ink-700 bg-ink-900 p-6"
        onSubmit={(e) => {
          e.preventDefault();
          localStorageSet('catpital.dev.uid', userId);
          localStorageSet('catpital.dev.name', username);
          onLogin(userId, username);
        }}
      >
        <h1 className="text-2xl font-black">
          🐱 Cat<span className="text-gold">pital</span>
        </h1>
        <p className="mt-1 text-sm font-semibold">{t('app.devLogin')}</p>
        <p className="mt-1 text-xs text-ink-400">{t('app.devLoginHint')}</p>
        <label className="mt-4 block text-xs text-ink-400">
          {t('app.userId')}
          <input value={userId} onChange={(e) => setUserId(e.target.value.replace(/\D/g, ''))} className="mt-1 w-full rounded-md border border-ink-700 bg-ink-850 px-3 py-2 font-mono text-sm text-ink-100" data-testid="login-uid" />
        </label>
        <label className="mt-3 block text-xs text-ink-400">
          {t('app.username')}
          <input value={username} onChange={(e) => setUsername(e.target.value)} maxLength={32} className="mt-1 w-full rounded-md border border-ink-700 bg-ink-850 px-3 py-2 text-sm text-ink-100" data-testid="login-name" />
        </label>
        {error && <p className="mt-3 text-xs text-blood">{t('app.authFailed', { reason: error })}</p>}
        <button className="mt-5 w-full rounded-lg bg-accent py-2.5 font-semibold text-white" data-testid="login-submit">
          {t('app.enter')}
        </button>
      </form>
    </div>
  );
}

function localStorageGet(k: string) {
  try {
    return localStorage.getItem(k);
  } catch {
    return null;
  }
}
function localStorageSet(k: string, v: string) {
  try {
    localStorage.setItem(k, v);
  } catch {
    /* ignore */
  }
}
