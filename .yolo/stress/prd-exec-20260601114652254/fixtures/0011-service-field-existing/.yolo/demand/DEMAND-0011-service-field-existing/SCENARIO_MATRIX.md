# DEMAND-0011-service-field-existing Scenario Matrix

This artifact translates non-technical answers into engineering-facing slices.

## Scenarios
### SCN-001: Inventory service output includes lowStockThreshold for every item.
- Actor: store manager
- Touchpoint: primary user workflow
- Trigger: the user exercises this requirement
- Current: Inventory API returns quantity but not the threshold managers compare against.
- Desired: Inventory service output includes lowStockThreshold for every item.
- Proof: A test can assert toInventoryItem returns lowStockThreshold from the source row.
- Out of scope: Do not build supplier ordering.

#### Surfaces
- SCN-001-SFC-001: 业务规则/服务逻辑 (service)
  - targets: src/services/inventory.ts
  - budget: single_session, max_files=1
- SCN-001-SFC-002: 测试/验证 (test)
  - targets: src/services/inventory.test.ts
  - budget: single_session, max_files=1

## Atomic Task Rule
one scenario surface becomes one session-sized task unless atomicity gate requires more splitting
