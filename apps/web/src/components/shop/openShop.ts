/** 从任何地方打开兑换商店（破产冷却提示、Bot 引导等）；TopBar 负责监听并渲染商店 */
export const OPEN_SHOP_EVENT = 'catpital:open-shop';

export function openShop() {
  window.dispatchEvent(new Event(OPEN_SHOP_EVENT));
}
