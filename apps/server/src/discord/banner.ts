import { Resvg } from '@resvg/resvg-js';

/**
 * /launch 欢迎卡片的主题横幅（960×320 PNG）。
 * Discord 不渲染 SVG，这里用 resvg 把内置 SVG 光栅化一次并缓存；不依赖任何外部图片。
 * 文字只用拉丁字符，避免服务器缺少中文字体时出现方块。
 */
let cached: Buffer | null = null;

const W = 960;
const H = 320;

function candles(): string {
  // 一段"先跌后暴涨"的 K 线，纯装饰
  const closes = [150, 158, 146, 139, 147, 131, 122, 128, 112, 118, 104, 96, 108, 99, 86, 92, 74, 66, 80, 61];
  let open = 165;
  return closes
    .map((c, i) => {
      const x = 604 + i * 17;
      const up = c < open; // SVG y 轴向下：数值越小越高
      const top = Math.min(open, c);
      const h = Math.max(4, Math.abs(open - c));
      const color = up ? '#3ddc97' : '#ff5c7a';
      const wick = `<line x1="${x + 5}" y1="${top - 8}" x2="${x + 5}" y2="${top + h + 8}" stroke="${color}" stroke-width="2"/>`;
      open = c;
      return `${wick}<rect x="${x}" y="${top}" width="10" height="${h}" rx="2" fill="${color}"/>`;
    })
    .join('');
}

function paws(): string {
  const spots = [
    [70, 250], [190, 60], [470, 270], [880, 250], [910, 60], [330, 40],
  ];
  return spots
    .map(
      ([x, y]) => `<g fill="#ffffff" fill-opacity="0.05" transform="translate(${x} ${y})">
        <ellipse cx="0" cy="10" rx="14" ry="12"/><circle cx="-14" cy="-8" r="6"/><circle cx="-4" cy="-16" r="6"/><circle cx="8" cy="-16" r="6"/><circle cx="17" cy="-7" r="6"/></g>`,
    )
    .join('');
}

const SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#241b3f"/><stop offset="0.55" stop-color="#17112b"/><stop offset="1" stop-color="#2c1a3d"/>
    </linearGradient>
    <radialGradient id="glow1" cx="0.15" cy="0" r="0.6"><stop offset="0" stop-color="#a77bff" stop-opacity="0.45"/><stop offset="1" stop-color="#a77bff" stop-opacity="0"/></radialGradient>
    <radialGradient id="glow2" cx="0.95" cy="0.1" r="0.5"><stop offset="0" stop-color="#ff6fae" stop-opacity="0.35"/><stop offset="1" stop-color="#ff6fae" stop-opacity="0"/></radialGradient>
    <linearGradient id="title" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="#ffd166"/><stop offset="1" stop-color="#ff6fae"/></linearGradient>
  </defs>
  <rect width="${W}" height="${H}" rx="28" fill="url(#bg)"/>
  <rect width="${W}" height="${H}" rx="28" fill="url(#glow1)"/>
  <rect width="${W}" height="${H}" rx="28" fill="url(#glow2)"/>
  ${paws()}
  <!-- 猫脸 -->
  <g transform="translate(130 160)">
    <polygon points="-62,-30 -48,-92 -12,-52" fill="#ffd166"/>
    <polygon points="62,-30 48,-92 12,-52" fill="#ffd166"/>
    <polygon points="-52,-40 -46,-76 -24,-52" fill="#ff9f6e"/>
    <polygon points="52,-40 46,-76 24,-52" fill="#ff9f6e"/>
    <ellipse cx="0" cy="0" rx="72" ry="62" fill="#ffd166"/>
    <ellipse cx="-26" cy="-8" rx="9" ry="13" fill="#17112b"/>
    <ellipse cx="26" cy="-8" rx="9" ry="13" fill="#17112b"/>
    <circle cx="-23" cy="-13" r="3" fill="#fff"/><circle cx="29" cy="-13" r="3" fill="#fff"/>
    <polygon points="-7,12 7,12 0,20" fill="#ff6fae"/>
    <path d="M0 20 Q -10 32 -20 26 M0 20 Q 10 32 20 26" stroke="#17112b" stroke-width="3" fill="none" stroke-linecap="round"/>
    <line x1="-40" y1="14" x2="-80" y2="6" stroke="#17112b" stroke-width="2"/><line x1="-40" y1="22" x2="-80" y2="26" stroke="#17112b" stroke-width="2"/>
    <line x1="40" y1="14" x2="80" y2="6" stroke="#17112b" stroke-width="2"/><line x1="40" y1="22" x2="80" y2="26" stroke="#17112b" stroke-width="2"/>
  </g>
  <text x="240" y="150" font-family="Arial Black, Segoe UI Black, Arial, sans-serif" font-weight="900" font-size="78" fill="#fbf7ff">Cat<tspan fill="url(#title)">pital</tspan></text>
  <text x="244" y="196" font-family="Segoe UI, Arial, sans-serif" font-weight="700" font-size="24" fill="#c3b9e8">Paper trading for cats · up to 200x · no safety net</text>
  <g font-family="Segoe UI, Arial, sans-serif" font-weight="800" font-size="20">
    <rect x="244" y="222" width="104" height="38" rx="19" fill="#3ddc97" fill-opacity="0.18"/><text x="262" y="248" fill="#3ddc97">MEOW</text>
    <rect x="358" y="222" width="104" height="38" rx="19" fill="#ff6fae" fill-opacity="0.18"/><text x="376" y="248" fill="#ff6fae">WOOF</text>
    <rect x="472" y="222" width="92" height="38" rx="19" fill="#6ec8ff" fill-opacity="0.18"/><text x="492" y="248" fill="#6ec8ff">FIH</text>
  </g>
  ${candles()}
</svg>`;

export function launchBanner(): Buffer {
  if (!cached) {
    const png = new Resvg(SVG, { fitTo: { mode: 'width', value: W }, font: { loadSystemFonts: true } }).render().asPng();
    cached = Buffer.from(png);
  }
  return cached;
}

export const BANNER_FILE = 'catpital-banner.png';
