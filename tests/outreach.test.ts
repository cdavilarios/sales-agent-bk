import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { draftOutreach, OutreachSchema } from "../src/agent/outreach.ts";
import {
  deleteOutreachByProspect,
  deleteProspectByDomain,
  getAirtableMcp,
  getProspectIdByDomain,
  listOutreachByProspectId,
  upsertProspect,
  type Prospect,
} from "../src/tools/airtable.ts";

const TEST_DOMAIN = "outreachtestco";
const UNKNOWN_DOMAIN = "outreachunknownco";

// Match tokens are specific numerals / proper nouns and live ONLY inside signals[].description (§16.1).
// Every other field describes the same dynamic in non-matching wording, so no single non-signal field
// can satisfy the assertion on its own.
const SIGNAL_TOKENS = [
  ["47", "singapore"],
  ["japanese", "osaka"],
];

const SEED: Prospect = {
  companyName: "Outreach Test Co",
  domain: TEST_DOMAIN,
  overview: "A mid-size logistics software company expanding across the Asia-Pacific region.",
  signals: [
    {
      name: "Hiring activity",
      description: "47 open customer support roles posted in Singapore this quarter.",
      strength: "strong",
    },
    {
      name: "Product launch",
      description: "Launched a Japanese-language storefront with a new Osaka warehouse.",
      strength: "strong",
    },
  ],
  leadScore: 70,
  scoreReasoning: "Regional growth and heavy staffing activity suggest rising ticket volume across languages.",
  suggestedAngle: "Open on the new regional launch and rapid hiring, then tie it to multilingual triage.",
  lastResearched: new Date().toISOString(),
};

const HAS_KEY = !!process.env.ANTHROPIC_API_KEY;
const HAS_AIRTABLE = !!process.env.AIRTABLE_API_KEY && !!process.env.AIRTABLE_BASE_ID;
if (!HAS_KEY || !HAS_AIRTABLE) {
  const missing = [
    !process.env.ANTHROPIC_API_KEY && "ANTHROPIC_API_KEY",
    !process.env.AIRTABLE_API_KEY && "AIRTABLE_API_KEY",
    !process.env.AIRTABLE_BASE_ID && "AIRTABLE_BASE_ID",
  ].filter(Boolean);
  console.warn(`[skip] ${missing.join(" and ")} unset — draftOutreach real-API suite skipped`);
}

describe("Outreach — missing env (always runs)", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("throws an error naming ANTHROPIC_API_KEY before any Airtable lookup", async () => {
    // Airtable vars are cleared too: an Airtable-first implementation would fail on those instead.
    vi.stubEnv("ANTHROPIC_API_KEY", "");
    vi.stubEnv("AIRTABLE_API_KEY", "");
    vi.stubEnv("AIRTABLE_BASE_ID", "");
    await expect(draftOutreach(TEST_DOMAIN)).rejects.toThrow(/ANTHROPIC_API_KEY/);
  });
});

describe("Outreach — seed fixture (always runs)", () => {
  it("keeps every match token out of the non-signal fields of the seeded prospect", () => {
    const nonSignalText = [SEED.companyName, SEED.overview, SEED.scoreReasoning, SEED.suggestedAngle]
      .join(" ")
      .toLowerCase();
    for (const token of SIGNAL_TOKENS.flat()) {
      expect(nonSignalText).not.toContain(token);
    }
    SIGNAL_TOKENS.forEach((tokens, i) => {
      const description = SEED.signals[i].description.toLowerCase();
      for (const token of tokens) expect(description).toContain(token);
    });
  });
});

describe.skipIf(!HAS_KEY || !HAS_AIRTABLE)("draftOutreach — real API", () => {
  let client: Awaited<ReturnType<typeof getAirtableMcp>>;
  let draft: Awaited<ReturnType<typeof draftOutreach>>;

  beforeAll(async () => {
    client = await getAirtableMcp();
    // Clear leftovers from a crashed run: Outreach rows first, then the prospect.
    await deleteOutreachByProspect(client, TEST_DOMAIN);
    await deleteProspectByDomain(client, TEST_DOMAIN);
    await upsertProspect(client, SEED);
    draft = await draftOutreach(TEST_DOMAIN); // the one real draft shared by every assertion below
  }, 120_000);

  afterAll(async () => {
    try {
      // Order matters: deleting the prospect first would orphan its Outreach rows (§12.3).
      await deleteOutreachByProspect(client, TEST_DOMAIN);
      await deleteProspectByDomain(client, TEST_DOMAIN);
    } finally {
      await client?.close();
    }
  }, 60_000);

  it("returns an object matching OutreachSchema", () => {
    expect(() => OutreachSchema.parse(draft)).not.toThrow();
  });

  it("keeps the subject line to 80 characters or fewer", () => {
    expect(draft.subjectLine.length).toBeGreaterThan(0);
    expect(draft.subjectLine.length).toBeLessThanOrEqual(80);
  });

  it("references at least one match token from each of the two seeded signals", () => {
    const body = draft.emailBody.toLowerCase();
    SIGNAL_TOKENS.forEach((tokens) => {
      expect(tokens.some((token) => body.includes(token))).toBe(true);
    });
  });

  it("persists an Outreach row linked to the seeded prospect's record id", async () => {
    // Verification goes through the read primitives, never through the delete helper's count.
    const prospectId = await getProspectIdByDomain(client, TEST_DOMAIN);
    expect(prospectId).toMatch(/^rec/);
    const outreachIds = await listOutreachByProspectId(client, prospectId!);
    expect(outreachIds.length).toBeGreaterThan(0);
  });

  it("errors with 'Research <Company> first.' for a domain with no prior prospect record", async () => {
    expect(await getProspectIdByDomain(client, UNKNOWN_DOMAIN)).toBeNull();
    await expect(draftOutreach(UNKNOWN_DOMAIN)).rejects.toThrow(/Research .+ first\./i);
  }, 60_000);
});
