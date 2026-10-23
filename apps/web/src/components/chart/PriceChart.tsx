import { D } from '@catpital/shared';
import {
  type AutoscaleInfo,
  type IChartApi,
  type IPriceLine,
  type ISeriesApi,
  type SeriesType,
  type Time,
  type UTCTimestamp,
  ColorType,
  CrosshairMode,
  LineStyle,
  createChart,
} from 'lightweight-charts';
import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { type CandleRow, type MarketInfo, api } from '../../lib/api';
import { decimalsOf } from '../../lib/format';
import { onCandle, onHistoryReset } from '../../realtime/bridge';
import { useSession } from '../../stores/session';
import { useTradePreview } from '../../stores/tradePreview';
import { type ChartType, type Interval, useSettings } from '../../stores/settings';

/**
 * 精度说明：lightweight-charts 的 API 只接受 JS number。
 * 这里是全前端唯一把 Decimal 字符串转为 number 的地方，结果只用于绘图，不参与任何计算。
 */
const toChartNum = (s: string) => Number(s);
const toTime = (ms: number) => Math.floor(ms / 1000) as UTCTimestamp;

export const UP_RED = '#ff5c7a';
export const DOWN_GREEN = '#3ddc97';
export const palette = (redUp: boolean) => (redUp ? { up: UP_RED, down: DOWN_GREEN } : { up: DOWN_GREEN, down: UP_RED });

interface Bar {
  time: UTCTimestamp;
  open: number;
  high: number;
  low: number;
  close: number;
}

function addSeries(chart: IChartApi, type: ChartType, up: string, down: string): ISeriesApi<SeriesType> {
  if (type === 'candle') {
    return chart.addCandlestickSeries({ upColor: up, downColor: down, borderUpColor: up, borderDownColor: down, wickUpColor: up, wickDownColor: down });
  }
  if (type === 'area') {
    return chart.addAreaSeries({ lineColor: '#a77bff', topColor: 'rgba(167,123,255,0.4)', bottomColor: 'rgba(255,111,174,0.02)', lineWidth: 3 });
  }
  return chart.addLineSeries({ color: '#a77bff', lineWidth: 3 });
}

const toPoint = (type: ChartType, b: Bar) => (type === 'candle' ? b : { time: b.time, value: b.close });

export function PriceChart({ market, interval, chartType }: { market: MarketInfo; interval: Interval; chartType: ChartType }) {
  const { t } = useTranslation();
  const containerRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const seriesRef = useRef<ISeriesApi<SeriesType> | null>(null);
  const barsRef = useRef<Bar[]>([]);
  const linesRef = useRef<IPriceLine[]>([]);
  const lineValuesRef = useRef<number[]>([]);
  const previewLineRef = useRef<IPriceLine | null>(null);
  /** "回正"后只按 K 线自适应，持仓线变化时恢复 */
  const fitOnlyRef = useRef(false);
  /** 价格轴滚轮缩放倍数（1 = 自适应原始范围；>1 拉远，<1 放大） */
  const yZoomRef = useRef(1);
  /** 视口外的斩杀线提示 */
  const [offscreen, setOffscreen] = useState<{ price: string; dir: 'up' | 'down'; preview: boolean } | null>(null);
  const previewValueRef = useRef<number | null>(null);
  /** K 线历史加载状态：失败显示重试，空数据显示等待行情 */
  const [load, setLoad] = useState<'loading' | 'ok' | 'empty' | 'error'>('loading');
  const [reloadKey, setReloadKey] = useState(0);
  // 管理员清除了这个市场的 K 线：重新加载（历史为空时显示"等待行情数据"，下一根 K 线到来后正常绘制）
  useEffect(() => onHistoryReset(market.code, () => setReloadKey((k) => k + 1)), [market.code]);
  const previewLiq = useTradePreview((s) => (s.market === market.code ? s.liq : null));
  const redUp = useSettings((s) => s.redUp);
  const position = useSession((s) => s.positions[market.code]);
  const orders = useSession((s) => s.orders);
  const { up, down } = palette(redUp);

  // ---- 图表实例（只创建一次）----
  useEffect(() => {
    const chart = createChart(containerRef.current!, {
      autoSize: true,
      // 图上的 TradingView 徽标是指向外部域名的链接；关闭后在设置页以文字形式保留署名（Apache-2.0 NOTICE 要求）
      layout: {
        background: { type: ColorType.Solid, color: 'transparent' },
        textColor: '#9d92cc',
        fontFamily: 'Inter, system-ui, sans-serif',
        attributionLogo: false,
      },
      grid: { vertLines: { color: 'rgba(76,62,124,0.25)' }, horzLines: { color: 'rgba(76,62,124,0.25)' } },
      crosshair: { mode: CrosshairMode.Normal },
      // 缩放：滚轮/双指缩放时间轴；按住并拖动价格轴或时间轴可分别拉伸 Y / X；双击坐标轴复位
      handleScale: { mouseWheel: true, pinch: true, axisPressedMouseMove: { time: true, price: true }, axisDoubleClickReset: { time: true, price: true } },
      handleScroll: { mouseWheel: true, pressedMouseMove: true, horzTouchDrag: true, vertTouchDrag: true },
      rightPriceScale: { borderColor: 'rgba(76,62,124,0.5)' },
      timeScale: {
        borderColor: 'rgba(76,62,124,0.5)',
        timeVisible: true,
        secondsVisible: false,
        // 数据是 UTC 时间戳，刻度按浏览器本地时间显示
        tickMarkFormatter: (time: Time) => {
          const d = new Date((time as number) * 1000);
          return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
        },
      },
      localization: { timeFormatter: (time: Time) => new Date((time as number) * 1000).toLocaleString() },
    });
    chartRef.current = chart;
    return () => {
      chart.remove();
      chartRef.current = null;
      seriesRef.current = null;
    };
  }, []);

  // ---- 系列（市场/周期/类型/配色变化时重建）+ 历史数据 + 实时订阅 ----
  useEffect(() => {
    const chart = chartRef.current;
    if (!chart) return;
    if (seriesRef.current) chart.removeSeries(seriesRef.current);
    linesRef.current = [];
    const series = addSeries(chart, chartType, up, down);
    const precision = decimalsOf(market.tickSize);
    series.applyOptions({
      priceFormat: { type: 'price', precision, minMove: toChartNum(market.tickSize) },
      /**
       * 自动缩放：以可见 K 线为基准；
       *   - 只把"附近"的持仓线（斩杀/止盈/止损/预览斩杀）纳入视野：距 K 线区间不超过其高度 1.5 倍，
       *     远端的线不再把整张图压扁（可拖动 Y 轴或看右上角提示去找）
       *   - 点"回正"后（fitOnly）完全只看 K 线
       *   - 滚轮在价格轴上 → 围绕中点按 yZoom 比例缩放
       */
      autoscaleInfoProvider: (original: () => AutoscaleInfo | null) => {
        const res = original();
        if (!res?.priceRange) return res;
        let { minValue, maxValue } = res.priceRange;
        if (!fitOnlyRef.current) {
          const extra = previewValueRef.current !== null ? [...lineValuesRef.current, previewValueRef.current] : lineValuesRef.current;
          const reach = Math.max(maxValue - minValue, maxValue * 0.002) * 1.5;
          for (const v of extra) {
            if (v < minValue - reach || v > maxValue + reach) continue;
            minValue = Math.min(minValue, v);
            maxValue = Math.max(maxValue, v);
          }
        }
        const z = yZoomRef.current;
        if (z !== 1) {
          // 以最新价为中心缩放（历史里有远端尖刺时，以区间中点缩放会把现价挤出视野）
          const last = barsRef.current[barsRef.current.length - 1]?.close;
          const mid = last ?? (minValue + maxValue) / 2;
          const half = ((maxValue - minValue) / 2) * z;
          minValue = mid - half;
          maxValue = mid + half;
        }
        return { ...res, priceRange: { minValue, maxValue } };
      },
    });
    seriesRef.current = series;
    previewLineRef.current = null; // 旧系列上的预览线随系列一起被移除
    barsRef.current = [];

    let cancelled = false;
    setLoad('loading');
    void api
      .get<{ candles: CandleRow[] }>(`/markets/${market.code}/candles?interval=${interval}&limit=500`)
      .then(({ candles }) => {
      if (cancelled) return;
      setLoad(candles.length ? 'ok' : 'empty');
      const bars = candles.map((c) => ({
        time: toTime(c.openTime),
        open: toChartNum(c.open),
        high: toChartNum(c.high),
        low: toChartNum(c.low),
        close: toChartNum(c.close),
      }));
      barsRef.current = bars;
      series.setData(bars.map((b) => toPoint(chartType, b)));
      chart.timeScale().scrollToRealTime();
      })
      .catch(() => {
        if (!cancelled) setLoad('error');
      });

    const off = onCandle(market.code, interval, (c) => {
      const bar: Bar = { time: toTime(c.openTime), open: toChartNum(c.open), high: toChartNum(c.high), low: toChartNum(c.low), close: toChartNum(c.close) };
      const last = barsRef.current[barsRef.current.length - 1];
      if (last && bar.time < last.time) return; // 乱序丢弃
      if (last && last.time === bar.time) barsRef.current[barsRef.current.length - 1] = bar;
      else barsRef.current.push(bar);
      series.update(toPoint(chartType, bar));
      setLoad((cur) => (cur === 'empty' ? 'ok' : cur));
    });
    return () => {
      cancelled = true;
      off();
    };
  }, [market.code, market.tickSize, interval, chartType, up, down, reloadKey]);

  // ---- 价格线：开仓均价 / 止盈 / 止损 / 斩杀线 / 挂单 ----
  useEffect(() => {
    const series = seriesRef.current;
    if (!series) return;
    for (const l of linesRef.current) series.removePriceLine(l);
    linesRef.current = [];
    lineValuesRef.current = [];
    fitOnlyRef.current = false; // 持仓线变化：恢复"附近的线纳入视野"
    const add = (price: string | null | undefined, color: string, title: string, style: LineStyle, width: 1 | 2 | 3 = 1, scale = false) => {
      if (!price || D(price).lte(0)) return;
      if (scale) lineValuesRef.current.push(toChartNum(price));
      linesRef.current.push(
        series.createPriceLine({ price: toChartNum(price), color, title, lineStyle: style, lineWidth: width, axisLabelVisible: true }),
      );
    };
    if (position) {
      add(position.entryPrice, '#c3b9e8', `${t('chart.entry')} ${t(`position.${position.side}`)}`, LineStyle.Dashed);
      add(position.takeProfitPrice, up, t('chart.tp'), LineStyle.Dotted, 2, true);
      add(position.stopLossPrice, '#ff9f6e', t('chart.sl'), LineStyle.Dotted, 2, true);
      add(position.liquidationPrice, '#ff3b5c', `☠ ${t('chart.liq')}`, LineStyle.Solid, 3, true);
    }
    // 价格线变化后触发一次重新缩放
    chartRef.current?.priceScale('right').applyOptions({ autoScale: true });
    for (const o of orders) {
      if (o.market === market.code && o.limitPrice) add(o.limitPrice, '#6ec8ff', `${t('chart.limit')} ${o.side}`, LineStyle.SparseDotted);
    }
  }, [position, orders, market.code, up, t, interval, chartType, down]);

  // ---- 💀 预览斩杀线：下单前随本金/杠杆实时移动，半透明闪烁；纳入自动缩放确保看得见 ----
  useEffect(() => {
    const series = seriesRef.current;
    if (!series) return;
    if (!previewLiq) {
      if (previewLineRef.current) series.removePriceLine(previewLineRef.current);
      previewLineRef.current = null;
      previewValueRef.current = null;
      chartRef.current?.priceScale('right').applyOptions({ autoScale: true });
      return;
    }
    const price = toChartNum(previewLiq);
    previewValueRef.current = price;
    fitOnlyRef.current = false;
    const opts = { price, title: `💀 ${t('chart.previewLiq')}`, lineStyle: LineStyle.LargeDashed, lineWidth: 2 as const, axisLabelVisible: true };
    if (previewLineRef.current) previewLineRef.current.applyOptions(opts);
    else previewLineRef.current = series.createPriceLine({ ...opts, color: 'rgba(255,59,92,0.85)' });
    chartRef.current?.priceScale('right').applyOptions({ autoScale: true });
  }, [previewLiq, t, interval, chartType, up, down]);

  useEffect(() => {
    if (!previewLiq) return;
    let bright = true;
    const timer = setInterval(() => {
      bright = !bright;
      previewLineRef.current?.applyOptions({ color: bright ? 'rgba(255,59,92,0.85)' : 'rgba(255,59,92,0.25)' });
    }, 550);
    return () => clearInterval(timer);
  }, [previewLiq]);

  // ---- 价格轴上的滚轮 → Y 轴按比例缩放（图表区域内的滚轮仍是时间轴缩放）----
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      const chart = chartRef.current;
      if (!chart) return;
      const rect = el.getBoundingClientRect();
      const axisWidth = chart.priceScale('right').width();
      const overPriceAxis = e.clientX >= rect.right - axisWidth;
      if (!overPriceAxis && !e.shiftKey) return; // Shift + 滚轮在图表任意位置也缩放 Y
      e.preventDefault();
      e.stopPropagation();
      yZoomRef.current = Math.min(20, Math.max(0.05, yZoomRef.current * (e.deltaY > 0 ? 1.12 : 1 / 1.12)));
      chart.priceScale('right').applyOptions({ autoScale: true });
    };
    el.addEventListener('wheel', onWheel, { passive: false, capture: true });
    return () => el.removeEventListener('wheel', onWheel, { capture: true });
  }, []);

  // ---- 斩杀线（或预览斩杀线）在视口外时，在右上角给出方向提示 ----
  useEffect(() => {
    const timer = setInterval(() => {
      const series = seriesRef.current;
      const el = containerRef.current;
      const target = previewLiq ?? (position && D(position.liquidationPrice).gt(0) ? position.liquidationPrice : null);
      if (!series || !el || !target) return setOffscreen(null);
      const y = series.priceToCoordinate(toChartNum(target));
      const height = el.clientHeight - 30; // 去掉时间轴高度
      if (y === null || (y >= 0 && y <= height)) return setOffscreen(null);
      setOffscreen({ price: target, dir: y < 0 ? 'up' : 'down', preview: Boolean(previewLiq) });
    }, 400);
    return () => clearInterval(timer);
  }, [previewLiq, position]);

  const reset = () => {
    const chart = chartRef.current;
    if (!chart) return;
    fitOnlyRef.current = true;
    yZoomRef.current = 1;
    chart.priceScale('right').applyOptions({ autoScale: true });
    chart.timeScale().resetTimeScale();
    chart.timeScale().scrollToRealTime();
  };

  return (
    <>
      <div ref={containerRef} className="absolute inset-0" data-testid="price-chart" />
      {(load === 'error' || load === 'empty') && (
        <div className="absolute inset-0 z-10 flex flex-col items-center justify-center gap-2 text-sm text-ink-400" data-testid="chart-status">
          <span className="text-3xl">{load === 'error' ? '😿' : '📡'}</span>
          <span>{load === 'error' ? t('chart.loadFailed') : t('chart.waiting')}</span>
          {load === 'error' && (
            <button
              type="button"
              className="arcade-btn border-ink-950/60 bg-candy-grape px-3 py-1 text-xs font-bold text-ink-950"
              onClick={() => setReloadKey((k) => k + 1)}
              data-testid="chart-retry"
            >
              ⟳ {t('chart.retry')}
            </button>
          )}
        </div>
      )}
      <div className="pointer-events-none absolute right-16 top-2 z-20 flex flex-col items-end gap-1">
        <button
          type="button"
          onClick={reset}
          title={t('chart.resetHint')}
          className="pointer-events-auto flex items-center gap-1 rounded-full border border-ink-700 bg-ink-900/85 px-2.5 py-1 text-xs font-bold text-ink-200 shadow-[0_2px_0_0_rgba(10,6,22,0.6)] backdrop-blur hover:border-candy-grape hover:text-white"
          data-testid="chart-reset"
        >
          ⟲ {t('chart.reset')}
        </button>
        {offscreen && (
          <span className="rounded-full bg-blood/20 px-2 py-0.5 font-mono text-[11px] font-bold text-blood" data-testid="liq-offscreen">
            💀 {offscreen.preview ? t('chart.previewLiq') : t('chart.liq')} {offscreen.price} {offscreen.dir === 'up' ? '↑' : '↓'}
          </span>
        )}
      </div>
    </>
  );
}
