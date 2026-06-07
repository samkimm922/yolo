export type InventoryItem = { id: string; sku: string; quantity: number };
export function toInventoryItem(row) {
  return { id: row.id, sku: row.sku, quantity: row.quantity };
}
