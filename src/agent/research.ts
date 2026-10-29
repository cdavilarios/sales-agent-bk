import { readFileSync } from "node:fs";
import { anthropic } from "@ai-sdk/anthropic";
import { generateObject, generateText, stepCountIs } from "ai";
import { z } from "zod";
import { getAirtableMcp, upsertProspect } from "../tools/airtable.ts";
import { searchWeb } from "../tools/tavily.ts";

const MAX_STEPS = 5;
const SYSTEM_PROMPT = readFileSync("src/agent/prompts/brain.md", "utf8");

export const ProspectSchema = z.object({
  companyName: z.string(),
  domain: z.string(), // canonical key — set by caller, not the model. See §7.4.
  overview: z.string(), // 1–2 paragraphs
  signals: z
    .array(
      z.object({
        name: z.string(), // e.g. "Hiring activity"
        description: z.string(), // e.g. "47 open roles in enterprise sales"
        strength: z.enum(["strong", "moderate", "weak"]),
      }),
    )
    .min(1),
  leadScore: z.number().int().min(1).max(100),
  scoreReasoning: z.string(), // why this number
  suggestedAngle: z.string(), // how to open the conversation
  lastResearched: z.string().datetime(), // ISO 8601, auto-set
});

export type Prospect = z.infer<typeof ProspectSchema>;

// §6: Stripe / stripe / STRIPE / stripe.com all resolve to the same key (lowercase alphanumerics, no TLD).
function normalizeDomain(input: string): string {
  let name = input.trim().toLowerCase().replace(/^https?:\/\//, "").replace(/^www\./, "").split("/")[0];
  if (/^[^\s.]+(\.[^\s.]+)+$/.test(name)) name = name.slice(0, name.lastIndexOf("."));
  const domain = name.replace(/[^a-z0-9]/g, "");
  if (!domain) throw new Error(`Cannot derive a domain from company name "${input}"`);
  return domain;
}

// Returns the model-filled partial only: domain and lastResearched have no slot here (§7.4), and no
// fallback, derivation, or default is applied to them.
export async function structureProspect(analysisText: string, companyName: string) {
  const result = await generateObject({
    model: anthropic("claude-haiku-4-5"),
    schema: ProspectSchema.omit({ domain: true, lastResearched: true }),
    prompt: `Extract a structured prospect for ${companyName} from the analysis below. Every field must come from the analysis text — do not invent values. Each signal's \`strength\` must be one of: strong, moderate, weak.

Analysis:
${analysisText}`,
  });
  return result.object;
}

export async function researchCompany(companyName: string) {
  if (!process.env.ANTHROPIC_API_KEY) {
    throw new Error(
      "ANTHROPIC_API_KEY is not set. Add it to .env or your Codespaces secrets.",
    );
  }
  const domain = normalizeDomain(companyName);

  const client = await getAirtableMcp();
  try {
    const result = await generateText({
      model: anthropic("claude-haiku-4-5"),
      system: SYSTEM_PROMPT,
      prompt: `Research ${companyName} as a potential sales prospect.`,
      tools: { searchWeb },
      stopWhen: stepCountIs(MAX_STEPS),
    });

    const structured = await structureProspect(result.text, companyName);
    const prospect = ProspectSchema.parse({
      ...structured,
      domain,
      lastResearched: new Date().toISOString(),
    });

    await upsertProspect(client, prospect);
    return { prospect, steps: result.steps };
  } finally {
    await client.close();
  }
}
