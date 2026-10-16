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
import { useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { type CandleRow, type MarketInfo, api } from '../../lib/api';
import { decimalsOf } from '../../lib/format';
import { onCandle } from '../../realtime/bridge';
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
  const previewValueRef = useRef<number | null>(null);
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
      // 自动缩放默认只看 K 线；把持仓的斩杀线/止盈止损纳入可视范围，确保"斩杀线"始终看得见
      autoscaleInfoProvider: (original: () => AutoscaleInfo | null) => {
        const res = original();
        const extra = previewValueRef.current !== null ? [...lineValuesRef.current, previewValueRef.current] : lineValuesRef.current;
        if (!res?.priceRange || extra.length === 0) return res;
        return {
          ...res,
          priceRange: {
            minValue: Math.min(res.priceRange.minValue, ...extra),
            maxValue: Math.max(res.priceRange.maxValue, ...extra),
          },
        };
      },
    });
    seriesRef.current = series;
    previewLineRef.current = null; // 旧系列上的预览线随系列一起被移除
    barsRef.current = [];

    let cancelled = false;
    void api.get<{ candles: CandleRow[] }>(`/markets/${market.code}/candles?interval=${interval}&limit=500`).then(({ candles }) => {
      if (cancelled) return;
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
    });

    const off = onCandle(market.code, interval, (c) => {
      const bar: Bar = { time: toTime(c.openTime), open: toChartNum(c.open), high: toChartNum(c.high), low: toChartNum(c.low), close: toChartNum(c.close) };
      const last = barsRef.current[barsRef.current.length - 1];
      if (last && bar.time < last.time) return; // 乱序丢弃
      if (last && last.time === bar.time) barsRef.current[barsRef.current.length - 1] = bar;
      else barsRef.current.push(bar);
      series.update(toPoint(chartType, bar));
    });
    return () => {
      cancelled = true;
      off();
    };
  }, [market.code, market.tickSize, interval, chartType, up, down]);

  // ---- 价格线：开仓均价 / 止盈 / 止损 / 斩杀线 / 挂单 ----
  useEffect(() => {
    const series = seriesRef.current;
    if (!series) return;
    for (const l of linesRef.current) series.removePriceLine(l);
    linesRef.current = [];
    lineValuesRef.current = [];
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

  return <div ref={containerRef} className="absolute inset-0" data-testid="price-chart" />;
}
