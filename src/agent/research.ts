import { anthropic } from "@ai-sdk/anthropic";
import { generateText, stepCountIs } from "ai";
import { searchWeb } from "../tools/tavily.ts";

const MAX_STEPS = 5;

export async function researchCompany(companyName: string) {
  if (!process.env.ANTHROPIC_API_KEY) {
    throw new Error(
      "ANTHROPIC_API_KEY is not set. Add it to .env or your Codespaces secrets.",
    );
  }

  const result = await generateText({
    model: anthropic("claude-haiku-4-5"),
    system:
      "You research companies as potential sales prospects. Use searchWeb to find recent news " +
      "(funding, hiring, launches) before answering, and cite source URLs. " +
      "If the search returns nothing, say so rather than guessing.",
    prompt: `Research ${companyName} as a potential sales prospect.`,
    tools: { searchWeb },
    stopWhen: stepCountIs(MAX_STEPS),
  });
  return result.text;
}
