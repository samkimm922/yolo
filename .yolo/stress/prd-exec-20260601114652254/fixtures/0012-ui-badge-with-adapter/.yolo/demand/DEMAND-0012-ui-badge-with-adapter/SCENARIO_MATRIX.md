# DEMAND-0012-ui-badge-with-adapter Scenario Matrix

This artifact translates non-technical answers into engineering-facing slices.

## Scenarios
### SCN-001: Inventory list displays a visible low-stock badge on affected SKUs.
- Actor: store manager
- Touchpoint: primary user workflow
- Trigger: the user exercises this requirement
- Current: Managers only see raw inventory counts in the inventory list.
- Desired: Inventory list displays a visible low-stock badge on affected SKUs.
- Proof: A screenshot or component test can show the low-stock badge on a SKU below threshold.
- Out of scope: Do not build supplier ordering.

#### Surfaces
- SCN-001-SFC-001: 用户可见界面 (ui)
  - targets: src/pages/inventory-list.tsx
  - budget: single_session, max_files=1

## Atomic Task Rule
one scenario surface becomes one session-sized task unless atomicity gate requires more splitting
