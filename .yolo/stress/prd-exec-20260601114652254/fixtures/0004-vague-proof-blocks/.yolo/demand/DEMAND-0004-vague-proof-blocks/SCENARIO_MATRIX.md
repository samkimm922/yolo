# DEMAND-0004-vague-proof-blocks Scenario Matrix

This artifact translates non-technical answers into engineering-facing slices.

## Scenarios
### SCN-001: Inventory list is better.
- Actor: store manager
- Touchpoint: primary user workflow
- Trigger: the user exercises this requirement
- Current: Managers use the inventory list.
- Desired: Inventory list is better.
- Proof: ok
- Out of scope: Do not build supplier ordering.

#### Surfaces
- SCN-001-SFC-001: 用户可见界面 (ui)
  - targets: src/pages/inventory-list.tsx
  - budget: single_session, max_files=1

## Atomic Task Rule
one scenario surface becomes one session-sized task unless atomicity gate requires more splitting
