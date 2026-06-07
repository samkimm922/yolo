# DEMAND-DIALOGUE-0007-real-ui-field-clarification Scenario Matrix

This artifact translates non-technical answers into engineering-facing slices.

## Scenarios
### SCN-001: Inventory list displays an inline 'Low stock' badge after the SKU when qty_available_units <= replenishment_floor_units.
- Actor: store manager
- Touchpoint: primary user workflow
- Trigger: the user exercises this requirement
- Current: Managers only see raw inventory counts in the inventory list.
- Desired: Inventory list displays an inline 'Low stock' badge after the SKU when qty_available_units <= replenishment_floor_units.
- Proof: A screenshot or component test shows an inline 'Low stock' badge after the SKU when qty_available_units <= replenishment_floor_units.
- Out of scope: Do not build supplier ordering.

#### Surfaces
- SCN-001-SFC-001: 用户可见界面 (ui)
  - targets: src/pages/inventory-list.tsx
  - visual style: Use an existing project badge component if one is present; otherwise use an inline text label with the current list typography and no new color system.
  - budget: single_session, max_files=1

## Atomic Task Rule
one scenario surface becomes one session-sized task unless atomicity gate requires more splitting
