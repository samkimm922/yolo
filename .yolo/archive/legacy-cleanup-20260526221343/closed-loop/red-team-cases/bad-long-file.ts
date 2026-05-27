/**
 * 盲盒库存管理 - 综合库存分析服务
 * 汇总库存统计、趋势分析、预警计算
 */

import { COLLECTIONS } from './constants';

// ============================================================
// 类型定义
// ============================================================

interface InventoryStats {
  totalItems: number;
  totalSeries: number;
  totalQuantity: number;
  totalValue: number;
  lowStockCount: number;
  outOfStockCount: number;
}

interface SeriesBreakdown {
  seriesId: string;
  seriesName: string;
  itemCount: number;
  totalQuantity: number;
  totalValue: number;
  status: 'normal' | 'low' | 'out_of_stock';
}

interface TrendDataPoint {
  date: string;
  quantity: number;
  inCount: number;
  outCount: number;
}

interface AlertRule {
  type: 'low_stock' | 'out_of_stock' | 'overstock';
  threshold: number;
  enabled: boolean;
}

interface DailySummary {
  date: string;
  totalIn: number;
  totalOut: number;
  netChange: number;
  uniqueItems: number;
}

interface CategorySummary {
  categoryId: string;
  categoryName: string;
  seriesCount: number;
  totalQuantity: number;
  totalValue: number;
  percentage: number;
}

// ============================================================
// 常量
// ============================================================

const LOW_STOCK_THRESHOLD = 10;
const OVERSTOCK_THRESHOLD = 500;
const TREND_DAYS = 30;
const SECONDS_PER_DAY = 86400;

// ============================================================
// 核心统计
// ============================================================

/**
 * 获取全局库存统计数据
 */
export async function getInventoryStats(): Promise<InventoryStats> {
  const db = wx.cloud.database();

  const [itemsRes, seriesRes] = await Promise.all([
    db.collection(COLLECTIONS.inventory).count(),
    db.collection(COLLECTIONS.blindbox_series).count(),
  ]);

  const { data: allInventory } = await db
    .collection(COLLECTIONS.inventory)
    .get();

  const totalQuantity = allInventory.reduce(
    (sum, item) => sum + (item.quantity || 0),
    0,
  );
  const totalValue = allInventory.reduce(
    (sum, item) => sum + (item.quantity || 0) * (item.unitPrice || 0),
    0,
  );
  const lowStockCount = allInventory.filter(
    (item) => item.quantity > 0 && item.quantity <= LOW_STOCK_THRESHOLD,
  ).length;
  const outOfStockCount = allInventory.filter(
    (item) => item.quantity === 0,
  ).length;

  return {
    totalItems: itemsRes.total,
    totalSeries: seriesRes.total,
    totalQuantity,
    totalValue,
    lowStockCount,
    outOfStockCount,
  };
}

/**
 * 按系列拆分库存统计
 */
export async function getSeriesBreakdown(): Promise<SeriesBreakdown[]> {
  const db = wx.cloud.database();
  const { data: seriesList } = await db
    .collection(COLLECTIONS.blindbox_series)
    .get();

  const breakdowns: SeriesBreakdown[] = [];

  for (const series of seriesList) {
    const { data: items } = await db
      .collection(COLLECTIONS.inventory)
      .where({ seriesId: series._id })
      .get();

    const totalQuantity = items.reduce((s, i) => s + (i.quantity || 0), 0);
    const totalValue = items.reduce(
      (s, i) => s + (i.quantity || 0) * (i.unitPrice || 0),
      0,
    );

    let status: SeriesBreakdown['status'] = 'normal';
    if (totalQuantity === 0) status = 'out_of_stock';
    else if (totalQuantity <= LOW_STOCK_THRESHOLD) status = 'low';

    breakdowns.push({
      seriesId: series._id,
      seriesName: series.name,
      itemCount: items.length,
      totalQuantity,
      totalValue,
      status,
    });
  }

  return breakdowns;
}

// ============================================================
// 趋势分析
// ============================================================

/**
 * 获取最近 N 天的库存变动趋势
 */
export async function getInventoryTrend(
  days: number = TREND_DAYS,
): Promise<TrendDataPoint[]> {
  const db = wx.cloud.database();
  const now = Date.now();
  const startTime = now - days * SECONDS_PER_DAY * 1000;

  const { data: movements } = await db
    .collection(COLLECTIONS.stock_in)
    .where({ createdAt: db.command.gte(startTime) })
    .get();

  const { data: outMovements } = await db
    .collection(COLLECTIONS.stock_out)
    .where({ createdAt: db.command.gte(startTime) })
    .get();

  const allMovements = [
    ...movements.map((m) => ({ ...m, direction: 'in' as const })),
    ...outMovements.map((m) => ({ ...m, direction: 'out' as const })),
  ];

  const trendMap = new Map<string, TrendDataPoint>();

  for (let d = 0; d < days; d++) {
    const date = new Date(now - d * SECONDS_PER_DAY * 1000);
    const dateStr = formatDate(date);
    trendMap.set(dateStr, {
      date: dateStr,
      quantity: 0,
      inCount: 0,
      outCount: 0,
    });
  }

  for (const mv of allMovements) {
    const dateStr = formatDate(new Date(mv.createdAt));
    const point = trendMap.get(dateStr);
    if (point) {
      if (mv.direction === 'in') {
        point.inCount += mv.quantity || 0;
      } else {
        point.outCount += mv.quantity || 0;
      }
      point.quantity = point.inCount - point.outCount;
    }
  }

  return Array.from(trendMap.values()).reverse();
}

// ============================================================
// 预警系统
// ============================================================

/**
 * 检查库存预警
 */
export async function checkStockAlerts(
  rules: AlertRule[],
): Promise<Array<{ itemId: string; seriesId: string; type: string; current: number }>> {
  const db = wx.cloud.database();
  const { data: allItems } = await db
    .collection(COLLECTIONS.inventory)
    .get();

  const alerts: Array<{ itemId: string; seriesId: string; type: string; current: number }> = [];

  for (const rule of rules) {
    if (!rule.enabled) continue;

    for (const item of allItems) {
      const qty = item.quantity || 0;
      let triggered = false;

      switch (rule.type) {
        case 'low_stock':
          triggered = qty > 0 && qty <= rule.threshold;
          break;
        case 'out_of_stock':
          triggered = qty === 0;
          break;
        case 'overstock':
          triggered = qty >= rule.threshold;
          break;
      }

      if (triggered) {
        alerts.push({
          itemId: item._id,
          seriesId: item.seriesId,
          type: rule.type,
          current: qty,
        });
      }
    }
  }

  return alerts;
}

// ============================================================
// 每日汇总
// ============================================================

/**
 * 生成每日出入库汇总
 */
export async function getDailySummary(
  startDate: number,
  endDate: number,
): Promise<DailySummary[]> {
  const db = wx.cloud.database();
  const summaries: DailySummary[] = [];

  const { data: stockInRecords } = await db
    .collection(COLLECTIONS.stock_in)
    .where({ createdAt: db.command.between(startDate, endDate) })
    .get();

  const { data: stockOutRecords } = await db
    .collection(COLLECTIONS.stock_out)
    .where({ createdAt: db.command.between(startDate, endDate) })
    .get();

  const dayMap = new Map<string, { totalIn: number; totalOut: number; uniqueItems: Set<string> }>();

  for (const record of stockInRecords) {
    const dateStr = formatDate(new Date(record.createdAt));
    const entry = getOrCreateDayEntry(dayMap, dateStr);
    entry.totalIn += record.quantity || 0;
    entry.uniqueItems.add(record.itemId || '');
  }

  for (const record of stockOutRecords) {
    const dateStr = formatDate(new Date(record.createdAt));
    const entry = getOrCreateDayEntry(dayMap, dateStr);
    entry.totalOut += record.quantity || 0;
    entry.uniqueItems.add(record.itemId || '');
  }

  for (const [date, entry] of dayMap) {
    summaries.push({
      date,
      totalIn: entry.totalIn,
      totalOut: entry.totalOut,
      netChange: entry.totalIn - entry.totalOut,
      uniqueItems: entry.uniqueItems.size,
    });
  }

  return summaries.sort((a, b) => a.date.localeCompare(b.date));
}

// ============================================================
// 分类汇总
// ============================================================

/**
 * 按分类维度汇总库存
 */
export async function getCategorySummary(): Promise<CategorySummary[]> {
  const db = wx.cloud.database();
  const { data: categories } = await db
    .collection(COLLECTIONS.categories)
    .get();

  let grandTotalQuantity = 0;
  const summaries: CategorySummary[] = [];

  for (const category of categories) {
    const { data: seriesInCategory } = await db
      .collection(COLLECTIONS.blindbox_series)
      .where({ categoryId: category._id })
      .get();

    let categoryQuantity = 0;
    let categoryValue = 0;

    for (const series of seriesInCategory) {
      const { data: items } = await db
        .collection(COLLECTIONS.inventory)
        .where({ seriesId: series._id })
        .get();

      for (const item of items) {
        categoryQuantity += item.quantity || 0;
        categoryValue += (item.quantity || 0) * (item.unitPrice || 0);
      }
    }

    grandTotalQuantity += categoryQuantity;

    summaries.push({
      categoryId: category._id,
      categoryName: category.name,
      seriesCount: seriesInCategory.length,
      totalQuantity: categoryQuantity,
      totalValue: categoryValue,
      percentage: 0,
    });
  }

  for (const summary of summaries) {
    summary.percentage =
      grandTotalQuantity > 0
        ? Math.round((summary.totalQuantity / grandTotalQuantity) * 100)
        : 0;
  }

  return summaries;
}

// ============================================================
// 工具函数
// ============================================================

function formatDate(date: Date): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function getOrCreateDayEntry(
  map: Map<string, { totalIn: number; totalOut: number; uniqueItems: Set<string> }>,
  dateStr: string,
) {
  if (!map.has(dateStr)) {
    map.set(dateStr, { totalIn: 0, totalOut: 0, uniqueItems: new Set() });
  }
  return map.get(dateStr)!;
}
