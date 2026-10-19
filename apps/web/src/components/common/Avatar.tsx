import { useEffect, useState } from 'react';
import { avatarUrl } from '../../lib/discord';

/** 首字母头像的底色：按 UID 固定取一种糖果色 */
const TONES = ['bg-candy-grape', 'bg-candy-pink', 'bg-candy-mint', 'bg-candy-sun', 'bg-candy-sky', 'bg-ink-600'];

/**
 * Discord 头像（经 /.proxy/discord-cdn 代理）。没有头像或图片加载失败
 * （URL Mapping 没配好、代理超时等）时，降级为纯色首字母头像，绝不显示破图。
 */
export function Avatar({
  userId,
  avatarHash,
  name,
  size = 32,
  className = '',
}: {
  userId: string;
  avatarHash: string | null | undefined;
  name?: string | null;
  size?: number;
  className?: string;
}) {
  const [failed, setFailed] = useState(false);
  useEffect(() => setFailed(false), [userId, avatarHash]);

  if (failed) {
    const initial = Array.from((name ?? '').trim())[0]?.toUpperCase() ?? '🐱';
    let tone = 0;
    try {
      tone = Number(BigInt(userId) % BigInt(TONES.length));
    } catch {
      /* 非数字 UID：用默认色 */
    }
    return (
      <span
        className={`inline-flex shrink-0 select-none items-center justify-center rounded-full font-black text-ink-950 ${TONES[tone]} ${className}`}
        style={{ fontSize: Math.max(10, Math.round(size * 0.45)) }}
        aria-hidden
        data-testid="avatar-fallback"
      >
        {initial}
      </span>
    );
  }
  return (
    <img
      src={avatarUrl(userId, avatarHash, size <= 32 ? 32 : size <= 64 ? 64 : 128)}
      alt=""
      loading="lazy"
      className={`shrink-0 rounded-full object-cover ${className}`}
      onError={() => setFailed(true)}
    />
  );
}
