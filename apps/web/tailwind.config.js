/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        ink: {
          950: '#0b0d12',
          900: '#11141b',
          850: '#161a23',
          800: '#1c212c',
          700: '#272d3a',
          600: '#363e4f',
          500: '#566079',
          400: '#7c86a0',
          300: '#a6aec2',
          200: '#c9cfdd',
          100: '#e8ebf2',
        },
        // 涨跌色由 CSS 变量决定（红涨绿跌 / 绿涨红跌 可切换）
        up: 'rgb(var(--c-up) / <alpha-value>)',
        down: 'rgb(var(--c-down) / <alpha-value>)',
        gold: '#f5c542',
        blood: '#d7263d',
        accent: '#7c5cff',
      },
      fontFamily: {
        sans: ['Inter', '"PingFang SC"', '"Microsoft YaHei"', 'system-ui', 'sans-serif'],
        mono: ['"JetBrains Mono"', 'Consolas', '"SFMono-Regular"', 'monospace'],
      },
      keyframes: {
        shake: {
          '0%,100%': { transform: 'translate(0,0)' },
          '10%,50%,90%': { transform: 'translate(-8px,4px)' },
          '30%,70%': { transform: 'translate(8px,-4px)' },
        },
        danmaku: { from: { transform: 'translateX(0)' }, to: { transform: 'translateX(calc(-100vw - 100%))' } },
        flashUp: { '0%': { backgroundColor: 'rgb(var(--c-up) / 0.35)' }, '100%': { backgroundColor: 'transparent' } },
        flashDown: { '0%': { backgroundColor: 'rgb(var(--c-down) / 0.35)' }, '100%': { backgroundColor: 'transparent' } },
      },
      animation: {
        shake: 'shake 0.5s ease-in-out 2',
        flashUp: 'flashUp 0.6s ease-out',
        flashDown: 'flashDown 0.6s ease-out',
      },
    },
  },
  plugins: [],
};
