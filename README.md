# Flourish

Flourish is a self-hosted personal finance workspace for everyday spending,
savings goals, investments, loans, and recurring payments. Your financial data
stays in a local SQLite database.

## What it includes

- Bank, cash, and credit-card accounts
- Expense, income, transfer, repayment, split, and adjustment entries
- Monthly spending patterns and six-month trends
- Savings goals and contribution history
- Investment holdings, valuations, and cash flows
- Personal loans, balance transfers, and card instalments
- Review-before-save imports for CSV, XLSX, PDF, and screenshots
- Local backups, restore checks, exports, and audit history

## Run on your Mac

Flourish requires Node.js 22.22.

```bash
pnpm install
pnpm dev
```

Open `http://127.0.0.1:3210`. Flourish creates its database at
`data/flourish.db`.

## Checks

```bash
pnpm typecheck
pnpm test
pnpm build
```

Flourish has no built-in account system. Keep it bound to your Mac or place it
behind an access-controlled private network when hosting it elsewhere.
