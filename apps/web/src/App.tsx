import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { BankruptcyPrompt, ResumeModal } from './components/bankruptcy/Bankruptcy';
import { ChartPanel } from './components/chart/ChartPanel';
import { FxLayer } from './components/fx/FxLayer';
import { LoginScreen } from './components/layout/LoginScreen';
import { MarketTabs } from './components/layout/MarketTabs';
import { TopBar } from './components/layout/TopBar';
import { SettingsModal } from './components/settings/SettingsModal';
import { BroadcastBanner } from './components/social/BroadcastBanner';
import { LiveTicker } from './components/social/LiveTicker';
import { NewsCard } from './components/social/NewsFeed';
import { Toasts } from './components/social/Toasts';
import { OrderPanel } from './components/trade/OrderPanel';
import { PositionsCard } from './components/trade/PositionsPanel';
import { ApiError, type MarketInfo, api, setToken } from './lib/api';
import { type AuthResult, authenticateWithDiscord, devLogin, isEmbedded } from './lib/discord';
import { sound } from './lib/sound';
import { startRealtime } from './realtime/bridge';
import { useMarkets, useSelectedMarket } from './stores/markets';
import { type MeResponse, useSession } from './stores/session';
import { type Settings, useSettings } from './stores/settings';

async function finishLogin(auth: AuthResult) {
  setToken(auth.token);
  const [markets, me] = await Promise.all([api.get<MarketInfo[]>('/markets'), api.get<MeResponse>('/me')]);
  useMarkets.getState().setList(markets);
  useSession.getState().hydrate(me, auth.embedded);
  useSettings.getState().hydrateFromCloud(me.user.settings as Partial<Settings>);
  startRealtime(auth.token);
}

export default function App() {
  const { t } = useTranslation();
  const status = useSession((s) => s.status);
  const setStatus = useSession((s) => s.setStatus);
  const market = useSelectedMarket();
  const [settingsOpen, setSettingsOpen] = useState(false);
  const embedded = isEmbedded();

  const login = useCallback(
    async (fn: () => Promise<AuthResult>) => {
      setStatus('authenticating');
      try {
        await finishLogin(await fn());
      } catch (e) {
        setStatus('error', e instanceof ApiError ? e.code : e instanceof Error ? e.message : String(e));
      }
    },
    [setStatus],
  );

  useEffect(() => {
    if (embedded) void login(authenticateWithDiscord);
  }, [embedded, login]);

  // 浏览器自动播放策略：首次交互后解锁音频
  useEffect(() => {
    const unlock = () => sound.unlock();
    window.addEventListener('pointerdown', unlock, { once: true });
    return () => window.removeEventListener('pointerdown', unlock);
  }, []);

  // 定期刷新市场列表（开/休市状态）
  useEffect(() => {
    if (status !== 'ready') return;
    const timer = setInterval(() => void api.get<MarketInfo[]>('/markets').then((l) => useMarkets.getState().setList(l)), 60_000);
    return () => clearInterval(timer);
  }, [status]);

  if (status !== 'ready') {
    if (!embedded && (status === 'idle' || status === 'error')) {
      return <LoginScreen onLogin={(uid, name) => void login(() => devLogin(uid, name))} />;
    }
    return (
      <div className="flex min-h-screen flex-col items-center justify-center gap-3 text-ink-400">
        <span className="animate-bounce text-4xl">🐱</span>
        <span>{status === 'error' ? t('app.authFailed', { reason: useSession.getState().error }) : t('app.loading')}</span>
      </div>
    );
  }

  return (
    <>
      <BroadcastBanner />
      <FxLayer />
      <Toasts />
      <ResumeModal />
      <SettingsModal open={settingsOpen} onClose={() => setSettingsOpen(false)} />

      {/*
        Bento 双栏：桌面端锁定单屏高度（各卡片内部滚动），不再出现大块空白。
          ┌──────── TopBar ─────────────────────────────┐
          │ 市场卡片 × N │ 全服广播 / 快讯 跑马灯（拉伸）  │
          ├──────────────────────────────┬──────────────┤
          │ K线 + 弹幕（约 3/5 高）        │              │
          ├────────────────┬─────────────┤  快捷交易面板  │
          │ 持仓 / 挂单     │ 金融快讯     │              │
          └────────────────┴─────────────┴──────────────┘
        DOM 顺序为 图表 → 下单 → 持仓/快讯，手机端自然堆叠时下单面板紧跟图表。
      */}
      <div id="shake-target" className="mx-auto flex min-h-screen max-w-[1680px] flex-col gap-3 p-3 lg:h-screen lg:min-h-[720px]">
        <TopBar onSettings={() => setSettingsOpen(true)} />
        <div className="flex flex-wrap items-stretch gap-3">
          <MarketTabs />
          <LiveTicker />
        </div>
        {market && (
          <div className="grid min-h-0 flex-1 gap-3 lg:grid-cols-[minmax(0,3fr)_minmax(320px,1fr)] lg:grid-rows-[minmax(0,1fr)_minmax(200px,36%)]">
            <ChartPanel market={market} className="min-h-[380px] lg:col-start-1 lg:row-start-1 lg:min-h-0" />
            <aside className="flex min-h-0 flex-col gap-3 lg:col-start-2 lg:row-span-2 lg:row-start-1 lg:overflow-y-auto lg:pr-0.5">
              <BankruptcyPrompt />
              <OrderPanel market={market} />
            </aside>
            <div className="grid min-h-0 gap-3 md:grid-cols-[minmax(0,3fr)_minmax(0,2fr)] lg:col-start-1 lg:row-start-2">
              <PositionsCard className="min-h-[220px] lg:min-h-0" />
              <NewsCard market={market.code} className="min-h-[220px] lg:min-h-0" />
            </div>
          </div>
        )}
      </div>
    </>
  );
}
