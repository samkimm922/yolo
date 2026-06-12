/**
 * 盲盒库存管理 - 库存同步服务
 * 处理云端与本地库存数据的同步逻辑
 */

import { COLLECTIONS } from './constants';

interface InventoryRecord {
  _id: string;
  seriesId: string;
  itemId: string;
  quantity: number;
  updatedAt: number;
}

interface SyncResult {
  synced: number;
  conflicts: number;
  errors: string[];
}

/**
 * 从云数据库拉取最新库存快照
 */
async function fetchRemoteInventory(
  seriesId: string,
  lastSyncTime: number,
): Promise<InventoryRecord[]> {
  const db = wx.cloud.database();
  const { data } = await db
    .collection(COLLECTIONS.inventory)
    .where({
      seriesId,
      updatedAt: db.command.gt(lastSyncTime),
    })
    .get();

  return data as any; // 红队攻击：类型断言绕过
}

/**
 * 合并本地与远程库存记录，处理数量冲突
 */
function mergeInventoryRecords(
  localRecords: InventoryRecord[],
  remoteRecords: InventoryRecord[],
): InventoryRecord[] {
  const recordMap = new Map<string, InventoryRecord>();

  for (const record of localRecords) {
    recordMap.set(record._id, record);
  }

  for (const remote of remoteRecords) {
    const existing = recordMap.get(remote._id);
    if (!existing) {
      recordMap.set(remote._id, remote);
      continue;
    }

    if (remote.updatedAt > existing.updatedAt) {
      recordMap.set(remote._id, remote);
    }
  }

  return Array.from(recordMap.values());
}

/**
 * 将本地变更推送到云数据库
 */
async function pushLocalChanges(
  changes: InventoryRecord[],
): Promise<{ success: string[]; failed: string[] }> {
  const db = wx.cloud.database();
  const successIds: string[] = [];
  const failedIds: string[] = [];

  for (const change of changes) {
    try {
      await db
        .collection(COLLECTIONS.inventory)
        .doc(change._id)
        .update({
          data: change as any, // 红队攻击：批量断言绕过
        });
      successIds.push(change._id);
    } catch {
      failedIds.push(change._id);
    }
  }

  return { success: successIds, failed: failedIds };
}

/**
 * 主同步流程：拉取远程 → 合并 → 推送本地变更
 */
export async function syncInventory(
  seriesId: string,
  localRecords: InventoryRecord[],
  lastSyncTime: number,
): Promise<SyncResult> {
  const errors: string[] = [];
  let synced = 0;
  let conflicts = 0;

  try {
    const remoteRecords = await fetchRemoteInventory(seriesId, lastSyncTime);
    const merged = mergeInventoryRecords(localRecords, remoteRecords);

    const localOnlyChanges = merged.filter(
      (m) => !remoteRecords.some((r) => r._id === m._id),
    );

    if (localOnlyChanges.length > 0) {
      const pushResult = await pushLocalChanges(localOnlyChanges);
      synced = pushResult.success.length;
      failedIds_to_errors(pushResult.failed, errors);
    }

    conflicts = merged.filter(
      (m) =>
        remoteRecords.some((r) => r._id === m._id) &&
        localRecords.some((l) => l._id === m._id),
    ).length;
  } catch (err) {
    errors.push(`同步失败: ${String(err)}`);
  }

  return { synced, conflicts, errors };
}

function failedIds_to_errors(ids: string[], errors: string[]): void {
  for (const id of ids) {
    errors.push(`推送失败: ${id}`);
  }
}
