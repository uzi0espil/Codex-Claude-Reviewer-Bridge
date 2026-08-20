const advisoryHeading = "Independent review agent — challenge or adapt it.";

export function buildPublishedFeedback(review: string): string {
  const trimmed = review.trim();
  if (trimmed.startsWith(advisoryHeading)) return trimmed;
  return [
    advisoryHeading,
    "Interrogate every material finding against the product intent, project guidance, architecture and specification artifacts, code, tests, and available evidence.",
    "For each finding, either accept and address it, adapt it with rationale, reject it with concrete evidence, or ask the user when the tradeoff requires their decision. Do not comply mechanically.",
    "",
    trimmed
  ].join("\n");
}
