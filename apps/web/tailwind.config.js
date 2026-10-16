/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        // 「猫咪街机」夜空紫：替代原先压抑的纯黑。数字越小越亮
        ink: {
          950: '#130e24',
          900: '#1d1633',
          850: '#241b3f',
          800: '#2c2249',
          700: '#3a2e60',
          600: '#4c3e7c',
          500: '#7466a8',
          400: '#9d92cc',
          300: '#c3b9e8',
          200: '#e2dbf7',
          100: '#fbf7ff',
        },
        // 涨跌色由 CSS 变量决定（红涨绿跌 / 绿涨红跌 可切换）
        up: 'rgb(var(--c-up) / <alpha-value>)',
        down: 'rgb(var(--c-down) / <alpha-value>)',
        // 糖果色强调
        candy: {
          pink: '#ff6fae',
          mint: '#3ddc97',
          sun: '#ffd166',
          sky: '#6ec8ff',
          grape: '#a77bff',
          peach: '#ff9f6e',
        },
        gold: '#ffd166',
        blood: '#ff3b5c',
        accent: '#a77bff',
      },
      fontFamily: {
        // 圆体优先，贴合休闲风；不加载任何外部字体（Discord CSP）
        sans: ['ui-rounded', '"SF Pro Rounded"', '"Hiragino Maru Gothic ProN"', '"PingFang SC"', '"Microsoft YaHei UI"', '"Microsoft YaHei"', 'system-ui', 'sans-serif'],
        mono: ['"JetBrains Mono"', '"SF Mono"', 'Consolas', 'monospace'],
      },
      keyframes: {
        shake: {
          '0%,100%': { transform: 'translate(0,0)' },
          '10%,50%,90%': { transform: 'translate(-8px,4px)' },
          '30%,70%': { transform: 'translate(8px,-4px)' },
        },
        wiggle: {
          '0%,100%': { transform: 'rotate(0deg) translateX(0)' },
          '25%': { transform: 'rotate(-3deg) translateX(-1px)' },
          '75%': { transform: 'rotate(3deg) translateX(1px)' },
        },
        marquee: { from: { transform: 'translateX(0)' }, to: { transform: 'translateX(-50%)' } },
        jolt: {
          '0%,100%': { transform: 'translateX(0)' },
          '20%,60%': { transform: 'translateX(-4px) rotate(-1deg)' },
          '40%,80%': { transform: 'translateX(4px) rotate(1deg)' },
        },
        blink: { '0%,100%': { opacity: '1' }, '50%': { opacity: '0.35' } },
        flashUp: { '0%': { backgroundColor: 'rgb(var(--c-up) / 0.35)' }, '100%': { backgroundColor: 'transparent' } },
        flashDown: { '0%': { backgroundColor: 'rgb(var(--c-down) / 0.35)' }, '100%': { backgroundColor: 'transparent' } },
        bob: { '0%,100%': { transform: 'translateY(0)' }, '50%': { transform: 'translateY(-2px)' } },
      },
      animation: {
        shake: 'shake 0.5s ease-in-out 2',
        wiggle: 'wiggle 0.35s ease-in-out infinite',
        marquee: 'marquee var(--marquee-duration, 40s) linear infinite',
        jolt: 'jolt 0.45s ease-in-out',
        blink: 'blink 1.2s ease-in-out infinite',
        flashUp: 'flashUp 0.6s ease-out',
        flashDown: 'flashDown 0.6s ease-out',
        bob: 'bob 2.4s ease-in-out infinite',
      },
    },
  },
  plugins: [],
};
