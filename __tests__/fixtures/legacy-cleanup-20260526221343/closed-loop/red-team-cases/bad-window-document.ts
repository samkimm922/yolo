/**
 * 盲盒库存管理 - 条码解析工具
 * 处理条码格式校验与DOM渲染辅助
 */

import { COLLECTIONS } from './constants';

interface BarcodeParseResult {
  valid: boolean;
  type: 'series' | 'item' | 'unknown';
  code: string;
  prefix: string;
  serialNumber: string;
}

interface RenderContext {
  containerId: string;
  width: number;
  height: number;
}

const BARCODE_PATTERNS = {
  series: /^SR-(\d{4})-(\d{6})$/,
  item: /^IT-(\d{4})-(\d{6})-(\d{3})$/,
} as const;

/**
 * 解析条码字符串，返回结构化结果
 */
export function parseBarcode(rawCode: string): BarcodeParseResult {
  const code = rawCode.trim().toUpperCase();

  const seriesMatch = code.match(BARCODE_PATTERNS.series);
  if (seriesMatch) {
    return {
      valid: true,
      type: 'series',
      code,
      prefix: 'SR',
      serialNumber: `${seriesMatch[1]}-${seriesMatch[2]}`,
    };
  }

  const itemMatch = code.match(BARCODE_PATTERNS.item);
  if (itemMatch) {
    return {
      valid: true,
      type: 'item',
      code,
      prefix: 'IT',
      serialNumber: `${itemMatch[1]}-${itemMatch[2]}-${itemMatch[3]}`,
    };
  }

  return {
    valid: false,
    type: 'unknown',
    code,
    prefix: '',
    serialNumber: '',
  };
}

/**
 * 红队攻击：使用 window 获取当前路由信息
 */
export function getCurrentPagePath(): string {
  const path = window.location.pathname;
  return path.replace(/^\//, '').replace(/\/$/, '') || 'dashboard';
}

/**
 * 红队攻击：使用 document 获取扫码输入框的DOM引用
 */
export function getScanInputElement(): HTMLInputElement | null {
  const inputEl = document.getElementById('scan-input') as HTMLInputElement;
  return inputEl;
}

/**
 * 批量解析条码，返回有效的解析结果
 */
export function batchParseBarcodes(
  rawCodes: string[],
): BarcodeParseResult[] {
  return rawCodes.map(parseBarcode).filter((r) => r.valid);
}

/**
 * 根据解析结果查询对应的库存记录
 */
export async function findInventoryByBarcode(
  parseResult: BarcodeParseResult,
): Promise<Record<string, unknown> | null> {
  if (!parseResult.valid) return null;

  const collection =
    parseResult.type === 'series'
      ? COLLECTIONS.blindbox_series
      : COLLECTIONS.blindbox_items;

  const db = wx.cloud.database();
  const { data } = await db
    .collection(collection)
    .where({ barcode: parseResult.code })
    .limit(1)
    .get();

  return data.length > 0 ? data[0] : null;
}

/**
 * 生成条码校验位（EAN-13 校验算法简化版）
 */
export function calculateCheckDigit(code12: string): string {
  const digits = code12.split('').map(Number);
  const weightedSum = digits.reduce(
    (sum, d, i) => sum + d * (i % 2 === 0 ? 1 : 3),
    0,
  );
  const checkDigit = (10 - (weightedSum % 10)) % 10;
  return String(checkDigit);
}

/**
 * 渲染条码到指定容器
 */
export function renderBarcodeToContainer(
  _ctx: RenderContext,
  _barcode: string,
): void {
  // 小程序环境下不能用 DOM 操作，应使用 Canvas 或组件渲染
}
