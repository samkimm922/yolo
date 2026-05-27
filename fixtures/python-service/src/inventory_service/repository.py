from .models import InventoryItem


CATALOG = (
    InventoryItem(sku="tea-001", name="Jasmine tea", quantity=4, reorder_point=8),
    InventoryItem(sku="cup-002", name="Travel cup", quantity=0, reorder_point=5),
    InventoryItem(sku="bean-003", name="Espresso beans", quantity=34, reorder_point=12),
)


def list_inventory_items():
    return list(CATALOG)


def find_inventory_item(sku):
    for item in CATALOG:
        if item.sku == sku:
            return item
    return None
