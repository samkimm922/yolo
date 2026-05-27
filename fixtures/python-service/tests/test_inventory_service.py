import json
import subprocess
import sys
import unittest

from src.inventory_service import (
    build_reorder_alerts,
    find_inventory_item,
    inventory_summary,
    list_inventory_items,
)


class InventoryServiceTest(unittest.TestCase):
    def test_repository_finds_items_by_sku(self):
        item = find_inventory_item("tea-001")

        self.assertIsNotNone(item)
        self.assertEqual(item.name, "Jasmine tea")
        self.assertIsNone(find_inventory_item("missing"))

    def test_reorder_alerts_are_prioritized(self):
        alerts = build_reorder_alerts(list_inventory_items())

        self.assertEqual([alert["sku"] for alert in alerts], ["tea-001", "cup-002"])
        self.assertEqual(alerts[0]["severity"], "low")
        self.assertEqual(alerts[1]["severity"], "critical")

    def test_summary_counts_alerts(self):
        summary = inventory_summary(list_inventory_items())

        self.assertEqual(summary, {
            "sku_count": 3,
            "reorder_count": 2,
            "critical_count": 1,
        })

    def test_cli_returns_machine_readable_payload(self):
        result = subprocess.run(
            [sys.executable, "-m", "src.inventory_service.cli", "--json"],
            check=True,
            capture_output=True,
            text=True,
        )

        payload = json.loads(result.stdout)
        self.assertEqual(payload["summary"]["reorder_count"], 2)
        self.assertEqual(payload["alerts"][1]["severity"], "critical")


if __name__ == "__main__":
    unittest.main()
