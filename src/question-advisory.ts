import { readReviewPolicy } from "./review-prompt.js";
import { ClaudeHookInput, ClaudeQuestion, FeaturePair, QuestionAdvisory } from "./types.js";

function nonEmptyString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim();
  return normalized || undefined;
}

export function questionsFromHook(input: ClaudeHookInput): ClaudeQuestion[] | undefined {
  if (input.tool_name !== "AskUserQuestion" || !Array.isArray(input.tool_input?.questions)) return undefined;
  const questions: ClaudeQuestion[] = [];
  for (const candidate of input.tool_input.questions) {
    if (!candidate || typeof candidate !== "object") return undefined;
    const value = candidate as Record<string, unknown>;
    const question = nonEmptyString(value.question);
    const header = nonEmptyString(value.header);
    if (!question || !header || !Array.isArray(value.options)) return undefined;
    const options = value.options.map((option) => {
      if (!option || typeof option !== "object") return undefined;
      const record = option as Record<string, unknown>;
      const label = nonEmptyString(record.label);
      const description = nonEmptyString(record.description);
      if (!label) return undefined;
      return { label, ...(description ? { description } : {}) };
    });
    if (!options.length || options.some((option) => !option)) return undefined;
    questions.push({
      question,
      header,
      options: options as ClaudeQuestion["options"],
      ...(typeof value.multiSelect === "boolean" ? { multiSelect: value.multiSelect } : {})
    });
  }
  return questions.length ? questions : undefined;
}

export function createQuestionAdvisory(input: ClaudeHookInput, createdAt = new Date().toISOString()): QuestionAdvisory | undefined {
  const id = nonEmptyString(input.tool_use_id);
  const questions = questionsFromHook(input);
  if (!id || !questions) return undefined;
  return { id, claudeSessionId: input.session_id, questions, createdAt };
}

export function buildQuestionAdvisoryPrompt(pair: FeaturePair, advisory: QuestionAdvisory): string {
  const rendered = advisory.questions.flatMap((question, index) => [
    `${index + 1}. ${question.question}${question.multiSelect ? " (select all that apply)" : ""}`,
    ...question.options.map((option) => `   - ${option.label}${option.description ? `: ${option.description}` : ""}`)
  ]);
  return [
    `[Claude question advisory: ${pair.displayName}]`,
    `Question event: ${advisory.id}`,
    `Claude session: ${advisory.claudeSessionId}`,
    "Claude is currently presenting the following question to the user. Act as an independent adviser: inspect the current target worktree, repository guidance, architecture and specification artifacts, code, tests, and diffs needed to understand the choice. Use live web research when current external facts materially affect the answer.",
    "Apply the private reviewer policy where relevant:",
    readReviewPolicy(),
    "Explain the material tradeoffs and recommend an answer when the evidence supports one. Identify assumptions and uncertainty. This turn is strictly read-only: do not edit files, apply patches, commit, publish bridge feedback, approve external actions, or answer Claude automatically. The user will discuss the recommendation here if needed and will personally submit the final answer in Claude.",
    "",
    ...rendered
  ].join("\n");
}
