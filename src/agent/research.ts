import { anthropic } from "@ai-sdk/anthropic";
import { generateText } from "ai";

export async function researchCompany(companyName: string) {
  const result = await generateText({
    model: anthropic("claude-haiku-4-5"),
    prompt: `Research ${companyName} as a potential sales prospect.`,
  });
  return result.text;
}
