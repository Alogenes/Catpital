-- 市场代码 FISH → FIH：原地改名，保留持仓 / K 线 / 事件等关联（按 id 关联，不受影响）
UPDATE "markets" SET "code" = 'FIH'
WHERE "code" = 'FISH' AND NOT EXISTS (SELECT 1 FROM "markets" WHERE "code" = 'FIH');
