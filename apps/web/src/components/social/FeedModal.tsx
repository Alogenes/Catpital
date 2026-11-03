import type { BroadcastPayload, FeedItem, ReactionSummary, ServerMessage } from '@catpital/shared';
import { AnimatePresence, motion } from 'framer-motion';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { errorText } from '../../i18n';
import { ApiError, api } from '../../lib/api';
import { sound } from '../../lib/sound';
import { realtime } from '../../lib/ws';
import { useFeed } from '../../stores/feed';
import { Avatar } from '../common/Avatar';
import { Modal } from '../common/Modal';
import { useBroadcastText } from './BroadcastBanner';
import { KIND_STYLE } from './LiveTicker';

type Vote = 1 | -1 | 0;
const EMPTY: FeedItem['reactions'] = { up: 0, down: 0, users: [], mine: 0 };

/**
 * 📡 24 小时全服动态：点跑马灯打开。每条可以 👍 / 👎（再点一次撤回），
 * 下面一排是评价过的玩家头像（最新在前，绿圈 = 👍，红圈 = 👎）。
 * 打开期间订阅 reactions 频道，别人投票、新战报出现都会实时刷新。
 */
export function FeedModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { t } = useTranslation();
  const text = useBroadcastText();
  const toast = useFeed((s) => s.toast);
  const [items, setItems] = useState<FeedItem[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    let alive = true;
    setItems(null);
    api
      .get<FeedItem[]>('/broadcasts/feed?hours=24')
      .then((list) => alive && setItems(list))
      .catch(() => alive && setItems([]));

    const patch = (id: string, fn: (r: FeedItem['reactions']) => FeedItem['reactions']) =>
      setItems((list) => list?.map((i) => (i.id === id ? { ...i, reactions: fn(i.reactions) } : i)) ?? list);
    realtime.subscribe(['reactions']);
    const off = realtime.on((msg: ServerMessage) => {
      if (!('ch' in msg)) return;
      if (msg.ch === 'reactions') {
        const { broadcastId, ...sum } = msg.d;
        // 推送里没有“我投的票”，保留本地的
        patch(broadcastId, (r) => ({ ...sum, mine: r.mine }));
      } else if (msg.ch === 'broadcast') {
        const b: BroadcastPayload = msg.d;
        setItems((list) => (list && !list.some((i) => i.id === b.id) ? [{ ...b, reactions: EMPTY }, ...list] : list));
      }
    });
    return () => {
      alive = false;
      off();
      realtime.unsubscribe(['reactions']);
    };
  }, [open]);

  const vote = async (item: FeedItem, value: 1 | -1) => {
    const next: Vote = item.reactions.mine === value ? 0 : value;
    setBusy(item.id);
    try {
      const r = await api.post<ReactionSummary & { mine: Vote }>(`/broadcasts/${item.id}/reaction`, { value: next });
      setItems((list) => list?.map((i) => (i.id === item.id ? { ...i, reactions: r } : i)) ?? list);
      sound.play('click');
    } catch (err) {
      toast('error', errorText(err instanceof ApiError ? err.code : 'error.network'));
    } finally {
      setBusy(null);
    }
  };

  return (
    <Modal open={open} onClose={onClose} className="!max-w-xl">
      <div className="flex max-h-[88vh] select-none flex-col p-5" data-testid="feed-modal">
        <div className="mb-1 flex items-center gap-2">
          <span className="relative flex h-2.5 w-2.5">
            <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-candy-pink opacity-75" />
            <span className="relative inline-flex h-2.5 w-2.5 rounded-full bg-candy-pink" />
          </span>
          <h2 className="mr-auto text-lg font-black">{t('feed.title')}</h2>
          {items && <span className="rounded-full bg-candy-pink/15 px-2.5 py-0.5 font-mono text-xs font-black text-candy-pink">{items.length}</span>}
          <button className="chip" onClick={onClose} aria-label={t('settings.close')} data-testid="feed-close">
            ✕
          </button>
        </div>
        <p className="mb-3 text-xs text-ink-400">{t('feed.hint')}</p>

        <div className="-mx-1 min-h-[160px] flex-1 overflow-y-auto px-1">
          {!items && (
            <div className="flex justify-center py-16">
              <span className="h-8 w-8 animate-spin rounded-full border-4 border-ink-700 border-t-candy-pink" />
            </div>
          )}
          {items && items.length === 0 && <p className="py-16 text-center text-sm text-ink-400">{t('feed.empty')}</p>}
          <ol className="space-y-2" data-testid="feed-list">
            <AnimatePresence initial={false}>
              {items?.map((item) => (
                <motion.li
                  key={item.id}
                  layout
                  initial={{ opacity: 0, y: -8 }}
                  animate={{ opacity: 1, y: 0 }}
                  className="rounded-2xl border-2 border-ink-700/70 bg-ink-850/80 px-3 py-2.5 shadow-[0_4px_0_0_rgba(10,6,22,0.6)]"
                  data-testid={`feed-item-${item.id}`}
                >
                  <div className="flex items-start gap-2">
                    <p className={`min-w-0 flex-1 text-sm font-semibold leading-snug ${KIND_STYLE[item.kind]}`}>{text(item)}</p>
                    <span className="shrink-0 font-mono text-[10px] text-ink-500">
                      {new Date(item.ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                    </span>
                  </div>
                  <div className="mt-2 flex items-center gap-2">
                    <VoteButton icon="👍" n={item.reactions.up} active={item.reactions.mine === 1} tone="up" disabled={busy === item.id} onClick={() => void vote(item, 1)} testId={`feed-up-${item.id}`} />
                    <VoteButton icon="👎" n={item.reactions.down} active={item.reactions.mine === -1} tone="down" disabled={busy === item.id} onClick={() => void vote(item, -1)} testId={`feed-down-${item.id}`} />
                    <AvatarStack reactions={item.reactions} />
                  </div>
                </motion.li>
              ))}
            </AnimatePresence>
          </ol>
        </div>
      </div>
    </Modal>
  );
}

function VoteButton({
  icon,
  n,
  active,
  tone,
  disabled,
  onClick,
  testId,
}: {
  icon: string;
  n: number;
  active: boolean;
  tone: 'up' | 'down';
  disabled: boolean;
  onClick: () => void;
  testId: string;
}) {
  const on = tone === 'up' ? 'border-candy-mint bg-candy-mint/20 text-candy-mint shadow-[0_0_12px_-3px_#3ddc97]' : 'border-blood bg-blood/20 text-blood shadow-[0_0_12px_-3px_#ff3b5c]';
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      aria-pressed={active}
      className={`flex items-center gap-1 rounded-full border-2 px-2.5 py-0.5 font-mono text-xs font-black transition-all active:scale-90 disabled:opacity-50 ${
        active ? on : 'border-ink-700 bg-ink-900 text-ink-300 hover:-translate-y-0.5 hover:border-ink-500'
      }`}
      data-testid={testId}
    >
      <span className="text-sm">{icon}</span>
      {n}
    </button>
  );
}

/** 评价过的玩家头像叠成一排；比显示的多时在最后补 +N */
function AvatarStack({ reactions }: { reactions: FeedItem['reactions'] }) {
  const extra = reactions.up + reactions.down - reactions.users.length;
  if (!reactions.users.length) return null;
  return (
    <div className="ml-auto flex items-center" data-testid="feed-avatars">
      <div className="flex -space-x-2">
        {reactions.users.map((u) => (
          <span key={u.id} title={`${u.value === 1 ? '👍' : '👎'} ${u.name}`} className={`rounded-full ring-2 ${u.value === 1 ? 'ring-candy-mint' : 'ring-blood'}`}>
            <Avatar userId={u.id} avatarHash={u.avatarHash} name={u.name} size={22} className="h-[22px] w-[22px] rounded-full" />
          </span>
        ))}
      </div>
      {extra > 0 && <span className="ml-1.5 font-mono text-[10px] font-bold text-ink-400">+{extra}</span>}
    </div>
  );
}
