# DEMAND-DIALOGUE-0003-brainstorm-to-plan-with-deferred-scope Scenario Matrix

This artifact translates non-technical answers into engineering-facing slices.

## Scenarios
### SCN-001: validateOrder returns an error when any input.lines[].quantity < 0.
- Actor: operations admin
- Touchpoint: primary user workflow
- Trigger: the user exercises this requirement
- Current: Order validation checks customer but not invalid line quantities.
- Desired: validateOrder returns an error when any input.lines[].quantity < 0.
- Proof: A regression test calls validateOrder with input.lines[].quantity < 0 and observes an error.
- Out of scope: Do not redesign order creation UI.; Do not add positive quantity normalization.

#### Surfaces
- SCN-001-SFC-001: 接口/服务入口 (api)
  - targets: src/api/orders.ts
  - visual style: TBD
  - budget: single_session, max_files=1
- SCN-001-SFC-002: 测试/验证 (test)
  - targets: src/api/orders.test.ts
  - visual style: TBD
  - budget: single_session, max_files=1

## Atomic Task Rule
one scenario surface becomes one session-sized task unless atomicity gate requires more splitting
