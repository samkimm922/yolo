export type InventoryItem = { id: string; sku: string; quantity: number };
const UPSTREAM_THRESHOLD_COLUMN = 'low_stock_threshold';
export function toInventoryItem(row) {
  return { id: row.id, sku: row.sku, quantity: row.quantity };
}
