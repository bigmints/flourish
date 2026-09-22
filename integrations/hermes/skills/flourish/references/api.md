# Flourish API reference

Base URL: `FLOURISH_BASE_URL`, default `http://127.0.0.1:3210`. Prefix every resource with `/api/v1`; the client script adds it automatically.

Responses use `{ "data": ..., "requestId": "..." }`. Errors use `{ "error": { "code", "message", "fieldErrors", "requestId" } }`.

Money fields are integer minor units. All create operations should include an `Idempotency-Key` header.

| Method | Path | Use |
| --- | --- | --- |
| GET | `/health` | Service and database readiness |
| GET/PATCH | `/settings` | Currency, time zone, month/week defaults |
| GET | `/dashboard?month=YYYY-MM` | Monthly overview |
| GET | `/spending-patterns?month=YYYY-MM&months=6` | Monthly total including uncategorized expenses and debt fees, prior-month comparison, daily average, categories, and trend |
| GET | `/forecast?month=YYYY-MM` | Expected income/spending, contractual EMIs, loan commitments outside card statements, card statement due amounts, available savings capacity, missing-data state, target gap, and prepaid renewals |
| GET/POST | `/accounts` | List/create bank, cash, or credit card accounts; legacy personal-loan accounts remain readable |
| GET/PATCH | `/accounts/{id}` | Account state and editable terms |
| GET | `/cards` | Cards with statement and ledger calculations |
| GET | `/cards/overview` | Card totals and missing-statement state |
| GET/PATCH | `/cards/{id}` | Card statement and account details |
| GET/POST | `/categories` | List/create categories |
| PATCH | `/categories/{id}` | Rename/reorder/archive category |
| GET/POST | `/transactions` | Filter/list or create transactions |
| GET/PATCH/DELETE | `/transactions/{id}` | Read/correct/soft-delete transaction |
| GET/POST | `/savings-goals` | List/create savings objectives |
| GET/PATCH | `/savings-goals/{id}` | Objective progress, history, target, and archive state |
| GET | `/savings/position?month=YYYY-MM` | Actual savings-account balances and ledger-derived net movement for a month |
| GET/POST | `/monthly-savings-plans` | List/create monthly savings targets |
| GET/PATCH | `/monthly-savings-plans/{id}` | Target and savings-account-derived actual, remaining, history, and streak |
| GET | `/wealth` | Base-currency Wealth totals, separate `totalsByCurrency`, holdings, and pending drafts |
| GET/POST | `/wealth/assets` | List/create AED, INR, or USD funds, deposits, savings, and other holdings |
| GET/PATCH | `/wealth/assets/{id}` | Holding detail and editable metadata |
| POST | `/wealth/assets/{id}/snapshots` | Record a dated current and invested value |
| POST | `/wealth/assets/{id}/cash-flows` | Record contribution, withdrawal, income, or fee |
| DELETE | `/wealth/assets/{id}/snapshots/{snapshotId}` | Correct a valuation after confirmation |
| DELETE | `/wealth/assets/{id}/cash-flows/{cashFlowId}` | Correct a cash flow after confirmation |
| GET/POST | `/wealth/import-drafts` | List/create screenshot-derived review drafts |
| GET/DELETE | `/wealth/import-drafts/{id}` | Read or cancel a pending screenshot draft |
| POST | `/wealth/import-drafts/{id}/apply` | Apply a screenshot draft after explicit confirmation |
| GET | `/reports/spending` | Category spending |
| GET | `/reports/cash-flow` | Income/spending/net |
| GET/POST | `/loans` | Standalone and card-linked personal loans, balance transfers, and purchase EMIs |
| GET | `/loans/overview` | Loan balances, card-included balances, EMI commitments, remaining EMIs, and completion dates |
| GET/PATCH | `/loans/{id}` | Read or edit every loan term and card relationship |
| POST | `/loans/{id}/installments` | Record an actual paid EMI and advance the contractual schedule |
| POST | `/debt-payments` | Linked bank-to-liability payment |
| POST | `/repayment-plans/simulate` | Non-persisting avalanche/snowball/fixed projection |
| POST | `/repayment-plans/compare` | Compare current payments with extra-payment lowest-interest and smallest-balance paths |
| GET | `/repayment-plans/active` | Legacy saved scenario; never use it as actual debt data |
| GET/POST | `/recurring-items` | List/create recurring templates |
| GET/PATCH/DELETE | `/recurring-items/{id}` | Read/update/archive recurring template |
| POST | `/recurring-items/{id}/record` | Idempotently record next occurrence |
| GET | `/upcoming` | Recurring items, loan due dates, and card due dates in separate lists |
| POST multipart | `/imports/preview` | No-write statement preview |
| GET/PATCH | `/imports/{id}` | Inspect or resolve preview rows |
| POST | `/imports/{id}/apply` | Confirmed import apply |
| GET/POST | `/import-profiles` | Validated statement mappings |
| PATCH/DELETE | `/import-profiles/{id}` | Update/delete mapping |
| GET | `/exports/transactions.csv` | Transaction export |
| GET | `/exports/data.json` | Portable full export |
| GET | `/audit-events` | Sanitized local mutation trail |
| GET | `/openapi.json` | Machine-readable contract |

Credit cards accept `institution`, `creditLimitMinor`, `lastStatementDate`, `lastStatementBalanceMinor`, `statementDay`, `dueDay`, and `nextDueDate`. Card responses contain linked loans in `loans`, but statement calculations remain separate from EMI schedules.

Loan `kind` values are `personal_loan`, `balance_transfer`, `card_installment`, and `other`. A card-linked loan uses `linkedCardId`; `includedInCardBalance` prevents its balance from being added twice. Loan amounts use `originalPrincipalMinor`, `currentBalanceMinor`, and `emiMinor`; schedules use `totalInstallments`, `remainingInstallments`, and `nextDueDate`.

Bank and cash accounts accept `purpose: "spending" | "savings"`. Default loan prepayment to false unless confirmed.

Transaction body fields: `type`, `date`, `amountMinor`, `accountId`, optional `transferAccountId`, `categoryId`, `merchant`, `note`, `source`, debt components, category splits, and the paired `coverageStartMonth`/`coverageEndMonth` fields for prepaid expenses.

Account `type` values: `bank`, `cash`, `credit_card`, `personal_loan`.

Transaction `type` values: `expense`, `income`, `transfer`, `debt_payment`, `adjustment`.

Savings actuals come only from ledger postings in accounts with `purpose: "savings"`. Record saving as a transfer into a savings-purpose account; do not use legacy objective entries or monthly check-ins.

Wealth asset `type` values: `mutual_fund`, `savings_account`, `fixed_deposit`, `stock`, `bond`, `crypto`, `real_estate`, `other`.

Screenshot drafts store `sourceFilename`, optional SHA-256, capture date, institution, extraction notes, and one or more proposed holdings/valuations. Creating a draft does not change Wealth; only the confirmed apply endpoint does.

Cash flows dated after the latest Wealth snapshot are reflected immediately: contributions and withdrawals adjust current and invested values, while fees reduce current value. A newer snapshot becomes the authoritative value as of its date.

Default dates and months use the configured `/settings` time zone. Dashboard activity and recurring items are limited to the requested dashboard month.
