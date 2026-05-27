def alert_severity(item):
    if item.quantity == 0:
        return "critical"
    return "low"


def build_reorder_alerts(items):
    alerts = []
    for item in items:
        if not item.needs_reorder():
            continue
        alerts.append({
            "sku": item.sku,
            "name": item.name,
            "quantity": item.quantity,
            "reorder_point": item.reorder_point,
            "severity": alert_severity(item),
        })
    return alerts


def inventory_summary(items):
    item_list = list(items)
    alerts = build_reorder_alerts(item_list)
    return {
        "sku_count": len(item_list),
        "reorder_count": len(alerts),
        "critical_count": sum(1 for alert in alerts if alert["severity"] == "critical"),
    }
