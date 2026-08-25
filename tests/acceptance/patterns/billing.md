# Pattern: Billing

> Asset type: `PROOF_OBLIGATION`. Billing proof must use transaction-level evidence, not only aggregate balance changes.

## Intent

Prove that a billable action charges the correct amount exactly once, non-billable/rejected actions charge nothing, and failure/refund behavior reconciles to the declared net amount.

## Applicable When

- An operation consumes money, credits, points, quota or metered usage.
- Pricing depends on duration, size, resolution, input/output usage or account policy.
- Retries, failure and callbacks can duplicate or reverse charges.

## Required Context

- Authoritative price rule, unit, currency/points conversion and rounding policy.
- Billable event boundary and charge timing.
- Actor/account/Tenant/Project and billing owner.
- Unique business, request and ledger correlation IDs.
- Before/after ledger and balance probes.
- Refund, retry and eventual reconciliation deadlines.

## Execution Steps

1. Calculate the expected charge from explicit inputs and the authoritative price rule.
2. Record baseline balance and correlation-scoped ledger entries.
3. Execute the billable action once and observe the business outcome.
4. Query ledger entries and balance after reconciliation.
5. Repeat using the Idempotency Pattern when duplicate submission is possible.
6. Exercise rejection/failure/refund paths required by risk.
7. Reconcile gross charge, refunds and net charge, then clean up test resources.

## Mandatory Assertions

- Charged unit, quantity, rate, rounding and currency match the explicit rule.
- Exactly one gross charge exists for one logical billable action.
- Rejected/non-billable operations create no charge.
- Failure refund or reversal occurs exactly once when required.
- Net charge equals gross charge minus valid refunds.
- Balance delta agrees with correlation-scoped ledger entries.
- Charge ownership and model/product attribution match Actor, Tenant and Project.

## Mandatory Evidence

- Versioned pricing rule or configuration identity.
- Input quantity evidence used in the calculation.
- Before/after balances.
- Correlation-scoped immutable ledger entries, including charge and refund IDs.
- Business task/result state linked to the ledger.
- Provider usage evidence if Provider metering contributes to cost.

## Blocking Conditions

- Price, unit, conversion or rounding rules conflict or are missing.
- Only aggregate balance or an unscoped recent-record list is available.
- Billing entries cannot be correlated to the business action.
- Concurrent unrelated billing activity cannot be isolated.
- Refund timing/deadline is unknown.
- Input and output quantities required by pricing cannot be measured.

## Fail-Closed Rule

An unchanged balance alone does not prove “no charge”, and a correct net balance can hide duplicate charge/refund pairs. Missing ledger cardinality evidence prevents PASS.
