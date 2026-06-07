# DEMAND-0018-backend-validation-rule Scenario Matrix

This artifact translates non-technical answers into engineering-facing slices.

## Scenarios
### SCN-001: validateOrder returns an error when any line quantity is below zero.
- Actor: operations admin
- Touchpoint: primary user workflow
- Trigger: the user exercises this requirement
- Current: Order validation checks customer but not negative quantities.
- Desired: validateOrder returns an error when any line quantity is below zero.
- Proof: A regression test can call validateOrder with quantity -1 and observe an error.
- Out of scope: Do not redesign order creation UI.

#### Surfaces
- SCN-001-SFC-001: 接口/服务入口 (api)
  - targets: src/api/orders.ts
  - budget: single_session, max_files=1
- SCN-001-SFC-002: 测试/验证 (test)
  - targets: src/api/orders.test.ts
  - budget: single_session, max_files=1

## Atomic Task Rule
one scenario surface becomes one session-sized task unless atomicity gate requires more splitting
