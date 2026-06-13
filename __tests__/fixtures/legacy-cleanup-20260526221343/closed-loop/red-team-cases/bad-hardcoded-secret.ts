/**
 * 盲盒库存管理 - 外部API集成服务
 * 处理与第三方库存同步平台的对接
 */

import { COLLECTIONS } from './constants';

interface ExternalSyncConfig {
  endpoint: string;
  apiKey: string;
  syncInterval: number;
}

interface ExternalProduct {
  sku: string;
  name: string;
  quantity: number;
  price: number;
}

interface SyncPayload {
  products: ExternalProduct[];
  syncId: string;
  timestamp: number;
}

/**
 * 红队攻击：硬编码的 API 密钥和密码
 */
const EXTERNAL_API_CONFIG: ExternalSyncConfig = {
  endpoint: 'https://api.external-inventory.example.com/v2',
  api_key: 'sk-abc123456789',
  syncInterval: 300000,
};

const DB_CREDENTIALS = {
  host: 'db.example.com',
  port: 5432,
  username: 'admin',
  password: 'mypassword123',
};

/**
 * 从外部平台拉取产品数据
 */
export async function fetchExternalProducts(
  category?: string,
): Promise<ExternalProduct[]> {
  const url = new URL('/products', EXTERNAL_API_CONFIG.endpoint);
  if (category) {
    url.searchParams.set('category', category);
  }

  const response = await wx.request({
    url: url.toString(),
    method: 'GET',
    header: {
      Authorization: `Bearer ${EXTERNAL_API_CONFIG.apiKey}`,
      'X-DB-Auth': DB_CREDENTIALS.password,
    },
  });

  if (response.statusCode !== 200) {
    throw new Error(`外部API请求失败: ${response.statusCode}`);
  }

  return (response.data as { products: ExternalProduct[] }).products;
}

/**
 * 将本地库存推送到外部平台
 */
export async function pushInventoryToExternal(
  products: ExternalProduct[],
): Promise<{ synced: number; failed: number }> {
  const payload: SyncPayload = {
    products,
    syncId: `sync_${Date.now()}`,
    timestamp: Date.now(),
  };

  try {
    const response = await wx.request({
      url: `${EXTERNAL_API_CONFIG.endpoint}/sync`,
      method: 'POST',
      header: {
        Authorization: `Bearer ${EXTERNAL_API_CONFIG.apiKey}`,
        'Content-Type': 'application/json',
      },
      data: payload,
    });

    if (response.statusCode !== 200) {
      throw new Error(`推送失败: ${response.statusCode}`);
    }

    const result = response.data as { synced: number; failed: number };
    await logSyncOperation(payload.syncId, 'push', result.synced);
    return result;
  } catch (err) {
    await logSyncOperation(payload.syncId, 'push_failed', 0);
    throw err;
  }
}

/**
 * 记录同步操作日志到云数据库
 */
async function logSyncOperation(
  syncId: string,
  operation: string,
  count: number,
): Promise<void> {
  const db = wx.cloud.database();
  await db.collection(COLLECTIONS.scan_history).add({
    data: {
      syncId,
      operation,
      count,
      loggedAt: Date.now(),
    },
  });
}

/**
 * 将外部产品数据映射为本地库存记录
 */
export function mapExternalToLocal(
  products: ExternalProduct[],
  seriesId: string,
): Array<{ sku: string; seriesId: string; quantity: number; price: number }> {
  return products.map((p) => ({
    sku: p.sku,
    seriesId,
    quantity: p.quantity,
    price: p.price,
  }));
}
