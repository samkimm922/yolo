export function InventoryList({ items }) {
  return <ul>{items.map((item) => <li key={item.sku}>{item.sku}: {item.qty_available_units}/{item.replenishment_floor_units}</li>)}</ul>;
}
