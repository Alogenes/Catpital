import { D, type Decimal, STORAGE_SCALE } from '@catpital/shared';
import DecimalBase from 'decimal.js';
import type { Prisma } from '@prisma/client';

/** Prisma.Decimal / string → 项目 Decimal */
export const fromDb = (v: Prisma.Decimal | DecimalBase | string): Decimal => D(v.toString());
export const fromDbOpt = (v: Prisma.Decimal | null | undefined): Decimal | null => (v == null ? null : fromDb(v));

/** 写库：先按 NUMERIC(36,8) 舍入再以字符串交给 Prisma（不会经过 JS number） */
export const toDb = (v: Decimal): string => v.toDecimalPlaces(STORAGE_SCALE, DecimalBase.ROUND_HALF_EVEN).toFixed();
export const toDbOpt = (v: Decimal | null | undefined): string | null => (v == null ? null : toDb(v));

/** 线上传输 */
export const wire = (v: Decimal): string => toDb(v);
export const wireOpt = (v: Decimal | null | undefined): string | null => (v == null ? null : toDb(v));
