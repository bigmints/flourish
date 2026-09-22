import { getLoansOverview } from "@/lib/loans";

// Kept as a compatibility alias for older API clients. New code uses Loans.
export const getDebtOverview = getLoansOverview;
