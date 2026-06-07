export function InventoryList({ items }) {
  return <ul>{items.map((item) => <li key={item.sku}>{item.sku}: {item.quantity}</li>)}</ul>;
}
