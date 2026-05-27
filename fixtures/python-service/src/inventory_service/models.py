from dataclasses import dataclass


@dataclass(frozen=True)
class InventoryItem:
    sku: str
    name: str
    quantity: int
    reorder_point: int

    def needs_reorder(self):
        return self.quantity <= self.reorder_point
