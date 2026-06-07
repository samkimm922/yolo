export function InventoryList({ items }) {
  return <ul>{items.map((item) => <li key={item.id}>{item.sku}: {item.quantity}</li>)}</ul>;
}
