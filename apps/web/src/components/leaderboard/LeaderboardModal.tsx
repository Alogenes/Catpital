import { D } from "@catpital/shared";
import { motion } from "framer-motion";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { type LeaderboardResponse, api } from "../../lib/api";
import { Avatar } from "../common/Avatar";
import { fmt } from "../../lib/format";
import { useSession } from "../../stores/session";
import { Modal } from "../common/Modal";
import { UserProfileModal } from "./UserProfileModal";

type Period = LeaderboardResponse["period"];
type Board = LeaderboardResponse["board"];

const PERIODS: Period[] = ["DAILY", "WEEKLY", "MONTHLY"];
const MEDALS = ["🥇", "🥈", "🥉"];
const PAGE_SIZE = 10;

const formatValue = (board: Board, v: string) => {
  if (board === "NET_WORTH") return fmt(v);
  const d = D(v);
  return `${d.gt(0) ? "+" : ""}${fmt(d, 2)}%`;
};

/**
 * 🏆 排行榜：日 / 周 / 月 × 收益率榜 / 富豪榜（当前周期实时计算，打开时每 10 秒刷新当前页）。
 * 每页 10 人，底部翻页；点头像 / 名字打开玩家主页（五维雷达图）。
 */
export function LeaderboardModal({
  open,
  onClose,
}: {
  open: boolean;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const me = useSession((s) => s.user?.id);
  const [period, setPeriod] = useState<Period>("DAILY");
  const [board, setBoard] = useState<Board>("RETURN_PCT");
  const [page, setPage] = useState(1);
  const [data, setData] = useState<LeaderboardResponse | null>(null);
  /** 切换周期 / 榜单 / 页码时的加载状态（后台定时刷新不显示） */
  const [loading, setLoading] = useState(false);
  const [profile, setProfile] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    let alive = true;
    const load = (visible: boolean) => {
      if (visible) setLoading(true);
      return api
        .get<LeaderboardResponse>(
          `/leaderboard?period=${period}&board=${board}&limit=${PAGE_SIZE}&page=${page}`,
        )
        .then((d) => {
          if (!alive) return;
          setData(d);
          // 人数变少时服务端会把页码夹到最后一页
          if (d.page !== page) setPage(d.page);
        })
        .catch(() => {})
        .finally(() => alive && visible && setLoading(false));
    };
    void load(true);
    const timer = setInterval(() => void load(false), 10_000);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, [open, period, board, page]);

  const seg = (active: boolean) =>
    `flex-1 rounded-full py-1.5 text-sm font-bold transition-colors ${active ? "bg-candy-grape text-white shadow-[0_2px_0_0_#6b4bc4]" : "text-ink-400 hover:text-ink-100"}`;
  const meOnPage = data?.entries.some((e) => e.userId === me);
  // 列表按返回数据自己的榜单类型格式化：切换榜单、新数据还没到时不会把净值显示成百分比
  const shown = data?.board ?? board;

  return (
    <>
      {/* 玩家主页叠在上面时，Esc / 点背景只关主页，不连排行榜一起关 */}
      <Modal
        open={open}
        onClose={profile ? undefined : onClose}
        className="max-w-lg"
      >
        <div className="p-5" data-testid="leaderboard-modal">
          <div className="mb-4 flex items-center justify-between">
            <h2 className="text-lg font-black">🏆 {t("leaderboard.title")}</h2>
            <button className="chip" onClick={onClose}>
              ✕
            </button>
          </div>

          <div className="mb-2 flex gap-1 rounded-full bg-ink-850 p-1">
            {PERIODS.map((p) => (
              <button
                key={p}
                className={seg(p === period)}
                onClick={() => {
                  setPeriod(p);
                  setPage(1);
                }}
              >
                {t(`leaderboard.period.${p}`)}
              </button>
            ))}
          </div>
          <div className="mb-4 grid grid-cols-2 gap-2">
            {(["RETURN_PCT", "NET_WORTH"] as Board[]).map((b) => (
              <button
                key={b}
                onClick={() => {
                  setBoard(b);
                  setPage(1);
                }}
                className={`arcade-btn py-2 text-sm ${b === board ? "border-[#b8336e] bg-candy-pink text-white" : "border-ink-950/60 bg-ink-800 text-ink-300"}`}
              >
                {t(`leaderboard.board.${b}`)}
              </button>
            ))}
          </div>

          <div className="relative min-h-[120px]">
            {!data && (
              <p className="py-10 text-center text-sm text-ink-500">…</p>
            )}
            {data && data.entries.length === 0 && (
              <p className="py-10 text-center text-sm text-ink-400">
                {t("leaderboard.empty")}
              </p>
            )}

            {/* 加载新一页时旧列表变暗（包一层普通 div，免得和淡入动画的内联 opacity 打架），新数据到了再淡入 */}
            {data && (
              <div
                className={`transition-opacity duration-200 ${loading ? "opacity-40" : "opacity-100"}`}
                data-testid="leaderboard-dim"
              >
                <motion.ol
                  key={`${data.period}:${data.board}:${data.page}`}
                  className="space-y-1.5"
                  initial={{ opacity: 0, y: 8 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ duration: 0.2 }}
                  data-testid="leaderboard-list"
                >
                  {data.entries.map((e) => {
                    const mine = e.userId === me;
                    const top = e.rank <= 3;
                    return (
                      <li
                        key={e.userId}
                        className={`flex items-center gap-3 rounded-2xl px-3 py-2 ${mine ? "border-2 border-candy-sun/70 bg-candy-sun/10" : top ? "bg-ink-800" : "bg-ink-850"}`}
                      >
                        <span
                          className={`w-8 shrink-0 text-center font-black ${top ? "text-2xl" : "font-mono text-sm text-ink-400"}`}
                        >
                          {top ? MEDALS[e.rank - 1] : `#${e.rank}`}
                        </span>
                        {/* 头像 + 名字：点开玩家主页 */}
                        <button
                          className="group flex min-w-0 flex-1 items-center gap-3 text-left"
                          onClick={() => setProfile(e.userId)}
                          title={t("profile.open")}
                          data-testid={`leaderboard-user-${e.userId}`}
                        >
                          <Avatar
                            userId={e.userId}
                            avatarHash={e.avatarHash}
                            name={e.name}
                            size={32}
                            className="h-8 w-8 shrink-0 rounded-full ring-2 ring-transparent transition-shadow group-hover:ring-candy-grape"
                          />
                          <span className="min-w-0 flex-1 leading-tight">
                            <span className="block truncate text-sm font-bold group-hover:text-candy-grape">
                              {e.name}
                            </span>
                            <span className="text-[10px] text-ink-500">
                              {t("wallet.generation", { n: e.generation })}
                            </span>
                          </span>
                        </button>
                        <span
                          className={`font-mono text-base font-black tabular-nums ${
                            shown === "NET_WORTH"
                              ? "text-candy-sun"
                              : D(e.value).gte(0)
                                ? "text-up"
                                : "text-down"
                          }`}
                        >
                          {formatValue(shown, e.value)}
                        </span>
                      </li>
                    );
                  })}
                </motion.ol>
              </div>
            )}

            {loading && data && (
              <div
                className="absolute inset-0 flex items-center justify-center"
                data-testid="leaderboard-loading"
              >
                <span className="h-8 w-8 animate-spin rounded-full border-4 border-ink-700 border-t-candy-grape" />
              </div>
            )}
          </div>

          {/* 翻页 */}
          {data && data.total > 0 && (
            <div
              className="mt-3 flex items-center justify-between gap-2"
              data-testid="leaderboard-pager"
            >
              <button
                className="chip"
                disabled={loading || page <= 1}
                onClick={() => setPage((p) => Math.max(1, p - 1))}
                data-testid="leaderboard-prev"
              >
                ‹ {t("leaderboard.prev")}
              </button>
              <span className="text-xs font-bold text-ink-400">
                {t("leaderboard.page", {
                  page: data.page,
                  total: data.totalPages,
                  count: data.total,
                })}
              </span>
              <button
                className="chip"
                disabled={loading || page >= data.totalPages}
                onClick={() => setPage((p) => Math.min(data.totalPages, p + 1))}
                data-testid="leaderboard-next"
              >
                {t("leaderboard.next")} ›
              </button>
            </div>
          )}

          {data?.me && !meOnPage && (
            <div className="mt-3 flex items-center justify-between rounded-2xl border-2 border-dashed border-candy-sun/50 px-3 py-2 text-sm">
              <span className="font-bold">🐾 {t("leaderboard.me")}</span>
              <span className="font-mono">
                {data.me.rank
                  ? `#${data.me.rank} · ${formatValue(shown, data.me.value!)}`
                  : shown === "RETURN_PCT" && !data.me.eligible
                    ? t("leaderboard.ineligible", {
                        min: fmt(data.minCapital, 0),
                      })
                    : t("leaderboard.unranked")}
              </span>
            </div>
          )}

          {data && (
            <p className="mt-4 text-center text-[11px] text-ink-500">
              {data.periodKey} ·{" "}
              {t("leaderboard.resetsAt", {
                time: new Date(data.periodEnd).toLocaleString(),
              })}
              {shown === "RETURN_PCT" && (
                <>
                  {" "}
                  ·{" "}
                  {t("leaderboard.formulaHint", {
                    min: fmt(data.minCapital, 0),
                  })}
                </>
              )}
            </p>
          )}
        </div>
      </Modal>
      <UserProfileModal userId={profile} onClose={() => setProfile(null)} />
    </>
  );
}
