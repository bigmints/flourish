---
name: flourish
description: Manage the user's private Flourish finances through the local API. Use for expenses, income, accounts, recurring and prepaid transactions, categories, spending analysis, savings balances and targets, investments, cards, loans, EMI schedules, repayment scenarios, reports, exports, screenshots, and attached bank statements.
---

# Flourish

Use Flourish as the source of truth for the user's personal finances.

## Runtime

Use `scripts/flourish_api.py`. It reads `FLOURISH_BASE_URL`, defaulting to `http://127.0.0.1:3210`.

Run `python3 scripts/flourish_api.py health` before the first operation in a conversation if service state is unknown. Never request credentials: Flourish has no application authentication and is restricted by the host/Tailscale boundary.

## Rules

- Money sent to the API uses integer minor units. Convert AED 68.50 to `6850`.
- Dates use `YYYY-MM-DD`; months use `YYYY-MM`.
- Set `source` to `hermes` on created or edited records.
- Send a stable idempotency key for every write. Reuse the same key when retrying the same user request.
- After every mutation, call the relevant GET endpoint and report persisted state.
- Do not count a transfer or card payment as an expense. A card/loan payment uses `debt_payment`, the bank as `accountId`, and the liability as `transferAccountId`.
- Keep actuals, known commitments, and scenarios separate. Transactions, account balances, card statements, and contractual loan EMIs are actuals. Recurring items and prepaid coverage are known future activity. Savings targets and extra-payment comparisons are scenarios.
- Cards use statement balances and ledger transactions. EMI contracts belong in `/loans`; a loan can be standalone or linked to a card, and one card can have several linked loans.
- Never count a card-linked loan twice. If `includedInCardBalance` is true, its balance is already part of the linked card's outstanding amount.
- Never create a savings check-in or objective contribution. Actual savings are calculated from ledger movement in accounts with `purpose: "savings"`.
- Never let a savings target or repayment scenario change actual spending, balances, contractual payments, or EMI schedules.
- Categorize OpenAI, ChatGPT, Google Cloud/GCP, Vertex AI, Gemini AI, Anthropic/Claude, Midjourney, Perplexity, Cursor, Copilot, Hugging Face, Replicate, Runpod, ElevenLabs, and similar AI services as `Work`.
- Resolve “today,” “this month,” and default due dates in the time zone returned by GET `/settings`; do not use the runtime host's clock zone.
- Bank and cash accounts with `purpose: "savings"` appear as savings balances. Use `purpose: "spending"` for everyday accounts.
- Wealth cash flows and valuations describe an investment holding. Do not also create a ledger transaction unless the user says money moved through a Flourish account.
- Ask a brief clarification if amount, currency, date, account, or transaction type cannot be resolved.
- A confident single entry may be written immediately, then reported with an easy correction path.
- Require explicit confirmation before delete, statement apply, screenshot-derived Wealth apply, bulk changes, reconciliation adjustments, or archiving an account/category.
- Never expose raw statement rows, private notes, or full API request bodies in logs.

## Discover IDs

Resolve names before writing:

```bash
python3 scripts/flourish_api.py get /accounts
python3 scripts/flourish_api.py get /cards/overview
python3 scripts/flourish_api.py get /loans/overview
python3 scripts/flourish_api.py get /categories
python3 scripts/flourish_api.py get /savings-goals
python3 scripts/flourish_api.py get /monthly-savings-plans
python3 scripts/flourish_api.py get /wealth/assets
```

If exactly one normalized name matches, use its ID. If none or multiple match, ask the user rather than guessing.

## Common operations

Read the full endpoint reference in `references/api.md` when needed.

### Overview

```bash
python3 scripts/flourish_api.py state --month 2026-07
```

Summarize income, spending, total savings, card outstanding, card statement due, loan balances, and when all loans finish. Keep cards and loans separate and use `additionalLoanBalanceMinor` when combining them into total owed. Use GET `/spending-patterns?month=YYYY-MM` when the user asks how spending changed or where money went.

### Add an expense

```bash
python3 scripts/flourish_api.py write POST /transactions \
  --idempotency-key hermes-unique-request-key \
  --json '{"type":"expense","date":"2026-07-26","amountMinor":6850,"accountId":"ACCOUNT_ID","categoryId":"CATEGORY_ID","merchant":"Lulu","source":"hermes"}'
```

Then GET `/transactions/TRANSACTION_ID` and `/spending-patterns?month=2026-07`. Report amount, merchant, category, account, date, monthly spending total, and the leading category.

For an expense covering several months, send both `coverageStartMonth` and `coverageEndMonth`. Example: rent paid in July for July through September uses `"coverageStartMonth":"2026-07","coverageEndMonth":"2026-09"`. The full payment remains an actual July expense; forecasts suppress another rent estimate until coverage ends and show the next renewal in October.

### Record a card or loan payment

```bash
python3 scripts/flourish_api.py write POST /debt-payments \
  --idempotency-key hermes-unique-request-key \
  --json '{"date":"2026-07-26","amountMinor":90000,"accountId":"BANK_ID","transferAccountId":"LIABILITY_ID","principalMinor":85000,"interestMinor":5000,"categoryId":"INTEREST_FEES_CATEGORY_ID","source":"hermes"}'
```

For a card payment, record the full amount as principal unless the bank separately itemizes interest or fees, then GET `/cards/CARD_ID` and report current outstanding and statement due. For a standalone loan payment, ask for the principal/interest breakdown when it is unavailable, then GET `/loans/overview` and report the updated balance, remaining EMIs, next due date, and final EMI month.

### Cards

GET `/cards/overview` when the user asks about cards. Report current outstanding, latest statement balance/date, spending since the statement, payments and credits since the statement, statement amount still due, utilization, available credit, payment due date, and next statement date. Report any linked loans in a separate list; never describe the card itself as having a payoff schedule.

Record a newly issued statement with the dedicated command, converting the balance to minor units:

```bash
python3 scripts/flourish_api.py card-statement CARD_ID \
  --date 2026-07-20 \
  --balance-minor 2209939 \
  --due-date 2026-08-01 \
  --idempotency-key hermes-card-statement-unique-key
```

Read back `/cards/CARD_ID` after the write. A statement balance is a snapshot from the bank; do not create an adjustment transaction merely to force the current outstanding to match it. The current outstanding remains ledger-backed.

### Loans and EMIs

GET `/loans/overview` for personal loans, balance transfers, card purchase EMIs, and other contractual schedules. Report total loan balances, the part already included in cards, monthly EMIs, when all loans finish, and each loan's remaining balance, EMI, remaining EMIs, next due date, final EMI month, and linked card.

Create a loan with `kind`, `originalPrincipalMinor`, `currentBalanceMinor`, `emiMinor`, `totalInstallments`, `remainingInstallments`, `nextDueDate`, and optional `aprBps`. Set `prepaymentAllowed:true` only when the user confirms extra payments are permitted.

For a balance transfer or card purchase plan, resolve the card and set `linkedCardId`. Ask whether the remaining plan balance is already included in the card's current outstanding when that cannot be established from the user's source; set `includedInCardBalance` accordingly. Creating or editing a loan never changes the card statement or card ledger.

```bash
python3 scripts/flourish_api.py loan-create \
  --name "Balance transfer" \
  --kind balance_transfer \
  --card CARD_ID \
  --original-minor 4080000 \
  --balance-minor 4080000 \
  --emi-minor 680000 \
  --total-emis 6 \
  --remaining-emis 6 \
  --next-due 2026-08-12 \
  --idempotency-key hermes-loan-unique-key
```

Record an actual paid installment against the loan schedule. This reduces the loan balance, advances the next due date, and reduces the remaining EMI count. It does not create a duplicate card transaction.

```bash
python3 scripts/flourish_api.py loan-emi LOAN_ID \
  --date 2026-08-12 \
  --amount-minor 680000 \
  --idempotency-key hermes-loan-emi-unique-key
```

### Spending patterns

GET `/spending-patterns?month=YYYY-MM`. Report the monthly total, change from the previous month, daily average, top category, category shares, and six-month trend. The total includes uncategorized expenses and the interest or fee portions of debt payments; never drop either from the summary. This is analysis only; do not create category spending limits.

GET `/forecast?month=YYYY-MM` for the following month. Report expected income and spending, `loanCommitmentOutsideCardStatementsMinor`, card statement amounts still due, `availableToSaveMinor`, the savings target, `savingsTargetGapMinor`, leading categories, and any prepaid renewal. `loanPaymentMinor` is the full contractual EMI total for schedule reporting; do not add it to card statements. The API counts a card-linked EMI outside the card statement only while that card lacks a recorded statement. If `capacityComplete` is false, name every loan missing an EMI and every card missing statement data. Never substitute a card minimum payment for statement data, and never subtract the savings target when calculating available savings.

Create, rename, or archive categories through `/categories`. Resolve the intended category before recording an expense. Keep AI, OpenAI, and Google Cloud spending in `Work` unless the user explicitly corrects the transaction.

### Repayment forecast

POST `/repayment-plans/compare` only when the user explicitly asks to compare extra-payment options. Include only loans where `prepaymentAllowed:true`. This endpoint never persists and never changes a fixed EMI schedule.

### Savings objectives

Create an objective when name and target are clear. A deadline is optional. Objectives are aspirations only; create them with `openingSavedMinor:0` and do not report objective entries as actual savings.

When the user identifies an existing account as a savings account, PATCH `/accounts/ACCOUNT_ID` with `{"purpose":"savings","source":"hermes"}` and read it back. GET `/savings/position?month=YYYY-MM` for actual balances and monthly net movement.

```bash
python3 scripts/flourish_api.py write POST /savings-goals \
  --idempotency-key hermes-savings-goal-unique-key \
  --json '{"name":"Emergency fund","targetMinor":3000000,"openingSavedMinor":0,"targetDate":"2027-06-30","source":"hermes"}'
```

After every objective change, GET `/savings-goals/GOAL_ID` and report the target, target date, and calculated monthly amount needed. Report actual savings separately from `/savings/position`.

### Monthly savings target

When the user says “save AED 2,000 every month” or similar, create a monthly plan. Default `startMonth` to the current local month only when the user did not specify one.

```bash
python3 scripts/flourish_api.py write POST /monthly-savings-plans \
  --idempotency-key hermes-monthly-plan-unique-key \
  --json '{"name":"Monthly savings","monthlyTargetMinor":200000,"startMonth":"2026-07","source":"hermes"}'
```

When the user says “I saved AED 1,500 this month,” resolve the source account and the savings-purpose destination account, then record a real transfer:

```bash
python3 scripts/flourish_api.py write POST /transactions \
  --idempotency-key hermes-savings-transfer-unique-key \
  --json '{"type":"transfer","date":"2026-07-26","amountMinor":150000,"accountId":"SOURCE_ACCOUNT_ID","transferAccountId":"SAVINGS_ACCOUNT_ID","note":"Monthly savings","source":"hermes"}'
```

If either account is ambiguous, ask. Read back both accounts, `/savings/position?month=YYYY-MM`, and `/monthly-savings-plans/PLAN_ID?month=YYYY-MM`; report target, ledger-derived actual, remaining or surplus, and streak.

### Wealth holdings

Use `/wealth/assets` for mutual funds, savings accounts, fixed deposits, stocks, bonds, and other investments. `openingInvestedMinor` is the starting cost; `currentValueMinor` with `asOfDate` creates the opening valuation. Record later values with `/wealth/assets/ASSET_ID/snapshots`, and contributions, withdrawals, income, or fees with `/wealth/assets/ASSET_ID/cash-flows`. Contributions and withdrawals after the latest valuation adjust both current and invested values until a newer valuation replaces that estimate; fees reduce current value. Read back the asset after every write and report current value, invested value, gain/loss, valuation date, and the recorded activity.

Wealth holdings support `AED`, `INR`, and `USD`. Always send the holding's actual currency instead of converting it to the base currency. Preserve the labelled currency from screenshots; if it is not visible or stated, ask the user. When summarizing mixed-currency Wealth, report each currency separately and never invent an exchange rate.

### Wealth screenshots

When the user attaches a screenshot from another finance app:

1. Inspect the image through Hermes's attachment/vision capability. Never invent obscured values.
2. Resolve any clearly matching existing holding by listing `/wealth/assets`. Put its `assetId` in the proposal; omit `assetId` to propose a new holding.
3. Extract only visible, labelled values. Each proposal needs `name`, `type`, `currency`, `currentValueMinor`, `asOfDate`, and optionally `investedValueMinor`, `institution`, and a short note.
4. Put uncertainty, cropped labels, and assumptions in `extractionNotes`. If a required value cannot be read, ask for a clearer screenshot instead of making a draft.
5. Create a provenance-backed draft; this calculates the file hash and stores the original filename:

```bash
python3 scripts/flourish_api.py wealth-draft \
  --file /path/from/hermes/portfolio.png \
  --captured-at 2026-07-26T18:30:00+04:00 \
  --institution "Example Bank" \
  --idempotency-key hermes-wealth-draft-unique-key \
  --json '{"proposals":[{"assetId":"ASSET_ID","name":"Growth Fund","type":"mutual_fund","currency":"AED","currentValueMinor":1250000,"investedValueMinor":1100000,"asOfDate":"2026-07-26"}],"extractionNotes":"Both values were clearly labelled"}'
```

6. GET `/wealth/import-drafts/DRAFT_ID` and summarize the exact proposed changes, source filename, capture date, institution, and uncertainties.
7. Ask for explicit confirmation. Attachment upload, a prior standing instruction, or a confident extraction is not confirmation.
8. Only after confirmation, POST `/wealth/import-drafts/DRAFT_ID/apply` with `{"source":"hermes"}` and a stable idempotency key.
9. GET the draft and every returned applied asset. Report persisted values and keep the screenshot provenance in the draft.

Never silently apply an OCR or vision guess. If the user corrects the draft before confirmation, cancel it and create a new corrected draft so provenance remains clear.

### Recurring items

Use `/recurring-items` for rent, salary, subscriptions, regular transfers, and recurring debt payments. Send a stable idempotency key when creating an item. After POST `/recurring-items/ITEM_ID/record`, read back both the created transaction and the recurring item; report the recorded date and the newly advanced next date. Retrying the same occurrence must return the existing result instead of creating a duplicate.

## Attached bank statements

When the user attaches a statement and asks to import it:

1. Resolve the destination account. Ask if it is ambiguous.
2. Obtain the attachment's readable local path from Hermes attachment metadata.
3. Preview it; preview creates no transactions:

```bash
python3 scripts/flourish_api.py statement-preview \
  --file /path/from/hermes/statement.csv \
  --account ACCOUNT_ID
```

4. Summarize filename, account, row count, money in, money out, duplicates, invalid rows, and date range from returned rows.
5. If column detection fails, inspect only headers/error details. Ask the user for mapping and retry with `--mapping-json`.
6. If invalid rows exist, use PATCH `/imports/BATCH_ID` to correct or ignore them before apply.
7. Ask for explicit confirmation: “Import N new transactions into ACCOUNT? M duplicates will be skipped.”
8. Only after confirmation:

```bash
python3 scripts/flourish_api.py statement-apply BATCH_ID \
  --idempotency-key hermes-import-BATCH_ID
```

9. GET `/imports/BATCH_ID`, `/accounts/ACCOUNT_ID`, and the relevant dashboard month. Report applied count and persisted totals.

Never interpret attachment upload alone as confirmation. Re-uploading or retrying the same file must not create duplicates.

Supported initial formats are CSV, XLSX, and text-based PDF. Legacy XLS files must first be saved as XLSX or CSV. If the API says a PDF contains no text transactions, explain that it is scanned or needs a bank-specific parser; do not fabricate rows.

## Corrections and destructive work

Search/list candidate records first. If more than one matches, show the smallest useful identifying set and ask which one. For deletion, state the exact record and wait for confirmation, then issue DELETE and verify it no longer appears in normal lists.

## Exports

Use the download command and return the resulting file to the user through Hermes:

```bash
python3 scripts/flourish_api.py export transactions --output /tmp/flourish-transactions.csv
python3 scripts/flourish_api.py export all --output /tmp/flourish-data.json
```

Do not print the export contents into the conversation.
