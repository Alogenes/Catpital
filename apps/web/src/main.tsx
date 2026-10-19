import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import './i18n';
import './index.css';
import App from './App';

// Discord 手机端：Activity 顶部有悬浮控制条，需要额外的顶部安全区（见 index.css --safe-top）
if (new URLSearchParams(window.location.search).get('platform') === 'mobile') {
  document.documentElement.dataset.discordMobile = 'true';
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
