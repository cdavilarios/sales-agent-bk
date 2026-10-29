import { existsSync, readFileSync } from "node:fs";
import { anthropic } from "@ai-sdk/anthropic";
import { generateObject } from "ai";
import { z } from "zod";
import { createOutreach, getAirtableMcp, getProspectByDomain } from "../tools/airtable.ts";

export const OutreachSchema = z.object({
  subjectLine: z.string().max(80),
  emailBody: z.string(),
  angleReasoning: z.string(),
});

export type Outreach = z.infer<typeof OutreachSchema>;

export async function draftOutreach(domain: string): Promise<Outreach> {
  // Env validation runs first (§11.2): before any Airtable lookup, prompt load, or model call.
  if (!process.env.ANTHROPIC_API_KEY) {
    throw new Error(
      "ANTHROPIC_API_KEY is not set. Add it to .env or your Codespaces secrets.",
    );
  }

  const client = await getAirtableMcp();
  try {
    const prospect = await getProspectByDomain(client, domain);
    if (!prospect) throw new Error(`Research ${domain} first. No prospect record found.`);

    // Drafting reads memory in code, not through the listPreferences tool (§12.4).
    const preferences = existsSync("src/memory/preferences.md")
      ? readFileSync("src/memory/preferences.md", "utf8")
      : "";
    const system = readFileSync("src/agent/prompts/outreach.md", "utf8");

    const result = await generateObject({
      model: anthropic("claude-haiku-4-5"),
      schema: OutreachSchema,
      system,
      prompt: `Prospect record:
Company: ${prospect.companyName}
Domain: ${prospect.domain}
Overview: ${prospect.overview}
Buying signals:
${prospect.signals}
Lead score: ${prospect.leadScore}
Score reasoning: ${prospect.scoreReasoning}
Suggested angle: ${prospect.suggestedAngle}

Saved preferences:
${preferences.trim() || "(none)"}

Write the first-touch outreach email for this prospect.`,
    });

    const outreach = OutreachSchema.parse(result.object);
    await createOutreach(client, prospect.id, outreach);
    return outreach;
  } finally {
    await client.close();
  }
}
