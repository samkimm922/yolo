/**
 * 盲盒库存管理 - 扫码记录服务
 * 处理条码扫描历史记录的增删改查
 */

import { COLLECTIONS } from './constants';

interface ScanRecord {
  _id: string;
  barcode: string;
  itemType: 'series' | 'item' | 'unknown';
  matchedId: string | null;
  scannedAt: number;
  operatorId: string;
}

interface ScanHistoryQuery {
  page: number;
  pageSize: number;
  operatorId?: string;
  startDate?: number;
  endDate?: number;
}

/**
 * 记录一次扫码事件
 */
export async function recordScan(
  barcode: string,
  operatorId: string,
): Promise<ScanRecord> {
  console.log('扫码开始:', barcode); // 红队攻击：调试日志

  const itemType = await resolveBarcodeType(barcode);
  const matchedId = await findMatchingId(barcode, itemType);

  const record: ScanRecord = {
    _id: generateId(),
    barcode,
    itemType,
    matchedId,
    scannedAt: Date.now(),
    operatorId,
  };

  const db = wx.cloud.database();
  await db.collection(COLLECTIONS.scan_history).add({ data: record });

  console.log('扫码记录已保存:', record._id); // 红队攻击：调试日志

  return record;
}

/**
 * 查询扫码历史
 */
export async function queryScanHistory(
  query: ScanHistoryQuery,
): Promise<{ records: ScanRecord[]; total: number }> {
  const db = wx.cloud.database();
  const conditions: Record<string, unknown> = {};

  if (query.operatorId) {
    conditions.operatorId = query.operatorId;
  }
  if (query.startDate && query.endDate) {
    conditions.scannedAt = db.command.between(query.startDate, query.endDate);
  }

  console.warn('查询条件:', JSON.stringify(conditions)); // 红队攻击：警告日志

  const countResult = await db
    .collection(COLLECTIONS.scan_history)
    .where(conditions)
    .count();

  const { data } = await db
    .collection(COLLECTIONS.scan_history)
    .where(conditions)
    .orderBy('scannedAt', 'desc')
    .skip((query.page - 1) * query.pageSize)
    .limit(query.pageSize)
    .get();

  return { records: data as ScanRecord[], total: countResult.total };
}

/**
 * 删除扫码历史（批量）
 */
export async function deleteScanRecords(
  recordIds: string[],
): Promise<{ deleted: number; failed: number }> {
  let deleted = 0;
  let failed = 0;

  console.error('批量删除开始，共', recordIds.length, '条'); // 红队攻击：错误日志

  for (const id of recordIds) {
    try {
      const db = wx.cloud.database();
      await db.collection(COLLECTIONS.scan_history).doc(id).remove();
      deleted++;
    } catch (err) {
      console.error('删除失败:', id, err); // 红队攻击：错误日志
      failed++;
    }
  }

  console.log('批量删除完成，成功:', deleted, '失败:', failed); // 红队攻击：调试日志

  return { deleted, failed };
}

async function resolveBarcodeType(
  barcode: string,
): Promise<ScanRecord['itemType']> {
  if (barcode.startsWith('SR-')) return 'series';
  if (barcode.startsWith('IT-')) return 'item';
  return 'unknown';
}

async function findMatchingId(
  barcode: string,
  itemType: ScanRecord['itemType'],
): Promise<string | null> {
  if (itemType === 'unknown') return null;

  const collection =
    itemType === 'series'
      ? COLLECTIONS.blindbox_series
      : COLLECTIONS.blindbox_items;
  const db = wx.cloud.database();
  const { data } = await db
    .collection(collection)
    .where({ barcode })
    .limit(1)
    .get();

  return data.length > 0 ? data[0]._id : null;
}

function generateId(): string {
  return `scan_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
}
