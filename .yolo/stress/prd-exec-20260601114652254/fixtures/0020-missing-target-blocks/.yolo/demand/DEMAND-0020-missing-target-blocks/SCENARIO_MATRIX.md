# DEMAND-0020-missing-target-blocks Scenario Matrix

This artifact translates non-technical answers into engineering-facing slices.

## Scenarios
### SCN-001: Managers see a low-stock alert.
- Actor: store manager
- Touchpoint: primary user workflow
- Trigger: the user exercises this requirement
- Current: Managers discover stockouts late.
- Desired: Managers see a low-stock alert.
- Proof: A manager can point to a visible alert before stockout.
- Out of scope: Do not build supplier ordering.

#### Surfaces
- SCN-001-SFC-001: 业务规则/服务逻辑 (service)
  - targets: TBD from code scout
  - budget: single_session, max_files=1

## Atomic Task Rule
one scenario surface becomes one session-sized task unless atomicity gate requires more splitting
