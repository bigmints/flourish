export const CATEGORIZATION_RULES_VERSION = "2";

const RULES: Array<[RegExp, string]> = [
  [/(openai|chatgpt|google[ *.-]*cloud|\bgcp\b|vertex[ *.-]*ai|gemini[ *.-]*ai|anthropic|claude[ *.-]*ai|midjourney|perplexity|cursor[ .*-]*(ai|pro)|github[ *.-]*copilot|microsoft[ *.-]*copilot|hugging[ *.-]*face|replicate|runpod|fal\.ai|elevenlabs|notion[ *.-]*ai|replit|lovable|v0\.dev)/i, "Work"],
  [/(carrefour|lulu|spinneys|waitrose|nesto|hypermarket|supermarket|grocery|grocer|amazon[ *.-]*now|oasis[ *.-]*pure[ *.-]*water)/i, "Groceries"],
  [/(restaurant|cafe|cafeteria|coffee|talabat|deliveroo|zomato|keeta|food|grill|kitchen|bakery)/i, "Dining"],
  [/(careem|uber|taxi|metro|petrol|fuel|parking|\brta\b|adnoc|emarat|digital[ *.-]*dubai)/i, "Transport"],
  [/(dewa|etisalat|du[ *.-]*(auto|pay|telecom)|internet|electric|water[ *.-]*bill|utility|mobile[ *.-]*bill)/i, "Bills"],
  [/(pharmacy|clinic|hospital|medical|health|dental|optical|vision[ *.-]*and[ *.-]*style)/i, "Health"],
  [/(netflix|spotify|cinema|youtube|apple\.com\/bill|itunes|audible|amazon[ *.-]*prime)/i, "Entertainment"],
  [/(decathlon|amazon|noon|mall|store|ikea|salon)/i, "Shopping"],
  [/(interest|finance[ *.-]*charge|late[ *.-]*fee|annual[ *.-]*fee|service[ *.-]*fee)/i, "Interest & fees"],
  [/(rent|landlord|home[ *.-]*centre|home[ *.-]*center)/i, "Home"]
];

export function inferExpenseCategoryName(description: string) {
  const normalized = String(description ?? "").trim();
  return RULES.find(([pattern]) => pattern.test(normalized))?.[1] ?? "Other";
}

export function isWorkRelatedExpense(description: string) {
  return inferExpenseCategoryName(description) === "Work";
}
