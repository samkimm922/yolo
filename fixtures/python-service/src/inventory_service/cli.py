import json
import sys

from .alerts import build_reorder_alerts, inventory_summary
from .repository import list_inventory_items


def build_payload():
    items = list_inventory_items()
    return {
        "summary": inventory_summary(items),
        "alerts": build_reorder_alerts(items),
    }


def main(argv=None):
    args = list(argv or sys.argv[1:])
    if "--json" not in args:
        print("usage: python3 -m src.inventory_service.cli --json", file=sys.stderr)
        return 2

    print(json.dumps(build_payload(), sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
