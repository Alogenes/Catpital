/**
 * 临时管理面板的白名单：ADMIN_PANEL_USERS="<Discord UID>:<Discord 用户名>,..."
 *   - UID 与用户名必须同时匹配（用户名不区分大小写）
 *   - 留空 = 面板完全不存在：路由不注册（404），/me 不返回 panel 字段，前端不渲染入口
 */
export class PanelAccess {
  private readonly allow = new Map<string, string>();

  constructor(raw: string) {
    for (const entry of raw.split(',')) {
      const [uid, ...rest] = entry.trim().split(':');
      const name = rest.join(':').trim().toLowerCase();
      if (uid && /^\d{5,25}$/.test(uid.trim()) && name) this.allow.set(uid.trim(), name);
    }
  }

  get enabled() {
    return this.allow.size > 0;
  }

  allows(user: { id: string; username: string } | null | undefined): boolean {
    if (!user) return false;
    const name = this.allow.get(user.id);
    return name !== undefined && name === user.username.toLowerCase();
  }
}
