/**
 * 唯一管理员（硬编码）。斜杠命令 /admin_*、管理接口 /api/v1/admin、临时管理面板都只认这个 Discord UID；
 * 服务器"管理服务器"权限、数据库 users.isAdmin、GuildConfig.adminRoleIds 都不再授予管理权限。
 */
export const OWNER_DISCORD_ID = '626797305567248398';

export const isOwner = (userId: string | null | undefined) => userId === OWNER_DISCORD_ID;
