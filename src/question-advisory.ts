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
    "Follow the bridge protocol and review policy established in this thread. This advisory remains strictly read-only; advise the user here and never publish or answer Claude automatically.",
    "",
    ...rendered
  ].join("\n");
}
