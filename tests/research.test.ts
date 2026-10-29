import { existsSync, readFileSync, renameSync, rmSync } from "node:fs";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ProspectSchema,
  researchCompany,
  structureProspect,
} from "../src/agent/research.ts";
import { deleteProspectByDomain, getAirtableMcp } from "../src/tools/airtable.ts";

const PREFS = "src/memory/preferences.md";
// A real preferences file is moved aside (not held in memory) so a crashed run leaves it recoverable.
const PREFS_BACKUP = "src/memory/preferences.md.test-backup";

const HAS_KEY = !!process.env.ANTHROPIC_API_KEY;
if (!HAS_KEY) {
  console.warn(
    "[skip] ANTHROPIC_API_KEY unset — researchCompany real-API suite skipped",
  );
}

describe("researchCompany — missing env (always runs)", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("throws a clear, actionable error when ANTHROPIC_API_KEY is missing", async () => {
    vi.stubEnv("ANTHROPIC_API_KEY", "");
    await expect(researchCompany("Stripe")).rejects.toThrow(/ANTHROPIC_API_KEY/);
  });
});

describe.skipIf(!HAS_KEY)("researchCompany — real API", () => {
  it("is callable and returns a non-empty response for a company name", async () => {
    const { prospect } = await researchCompany("Stripe");
    expect(typeof prospect.overview).toBe("string");
    expect(prospect.overview.trim().length).toBeGreaterThan(0);
  }, 60_000);
});

const HAS_TAVILY_KEY = !!process.env.TAVILY_API_KEY;
if (!HAS_KEY || !HAS_TAVILY_KEY) {
  const missing = [
    !HAS_KEY && "ANTHROPIC_API_KEY",
    !HAS_TAVILY_KEY && "TAVILY_API_KEY",
  ].filter(Boolean);
  console.warn(
    `[skip] ${missing.join(" and ")} unset — researchCompany search-wiring and preferences-wiring suites skipped`,
  );
}

describe.skipIf(!HAS_KEY || !HAS_TAVILY_KEY)(
  "researchCompany — search wiring — real API",
  () => {
    it("invokes searchWeb at least once during a run", async () => {
      const { steps } = await researchCompany("Stripe");
      expect(steps.length).toBeGreaterThan(1);
      const searchCalls = steps.flatMap((s) =>
        s.toolCalls.filter((c) => c.toolName === "searchWeb"),
      );
      expect(searchCalls.length).toBeGreaterThanOrEqual(1);
    }, 60_000);

    describe("preferences wiring", () => {
      beforeEach(() => {
        if (existsSync(PREFS) && !existsSync(PREFS_BACKUP)) renameSync(PREFS, PREFS_BACKUP);
        rmSync(PREFS, { force: true }); // every test starts with no file
      });

      afterEach(() => {
        rmSync(PREFS, { force: true });
        if (existsSync(PREFS_BACKUP)) renameSync(PREFS_BACKUP, PREFS);
      });

      it("begins every run with a listPreferences tool call", async () => {
        const { steps } = await researchCompany("Stripe");
        const toolCalls = steps.flatMap((s) => s.toolCalls);
        expect(toolCalls.length).toBeGreaterThan(0);
        expect(toolCalls[0].toolName).toBe("listPreferences");
      }, 120_000);

      it("calls addPreference when the user message states a preference, and the file reflects it", async () => {
        const { steps } = await researchCompany(
          "Research Stripe. For payments companies, always lead with Cantonese and Bahasa dispute deflection.",
        );
        const addCalls = steps.flatMap((s) =>
          s.toolCalls.filter((c) => c.toolName === "addPreference"),
        );
        expect(addCalls.length).toBeGreaterThanOrEqual(1);
        expect(existsSync(PREFS)).toBe(true);
        expect(readFileSync(PREFS, "utf8")).toMatch(/cantonese/i);
      }, 120_000);
    });
  },
);

const HAS_AIRTABLE = !!process.env.AIRTABLE_API_KEY && !!process.env.AIRTABLE_BASE_ID;
if (!HAS_AIRTABLE) {
  const missing = [
    !process.env.AIRTABLE_API_KEY && "AIRTABLE_API_KEY",
    !process.env.AIRTABLE_BASE_ID && "AIRTABLE_BASE_ID",
  ].filter(Boolean);
  console.warn(
    `[skip] ${missing.join(" and ")} unset — researchCompany structurer + persistence suite skipped`,
  );
}

type AirtableClient = Awaited<ReturnType<typeof getAirtableMcp>>;
type Envelope = {
  isError?: boolean;
  content?: { text?: string }[];
  structuredContent?: any;
};

// Independent verifier (§16.1): reads Prospects through the raw MCP tools, not through the wrappers under test.
async function callMcp(client: AirtableClient, name: string, args: Record<string, unknown>) {
  const tools = (await client.tools()) as Record<string, any>;
  const result = (await tools[name].execute(args, { toolCallId: name, messages: [] })) as Envelope;
  if (result.isError) throw new Error(`${name} failed: ${result.content?.[0]?.text}`);
  return result.structuredContent ?? JSON.parse(result.content![0].text!);
}

async function readProspects(client: AirtableClient, domain: string) {
  const baseId = process.env.AIRTABLE_BASE_ID!;
  const schema = await callMcp(client, "list_tables_for_base", { baseId });
  const table = schema.tables.find((t: { name: string }) => t.name === "Prospects");
  const fieldIds: Record<string, string> = Object.fromEntries(
    table.fields.map((f: { name: string; id: string }) => [f.name, f.id]),
  );
  const listed = await callMcp(client, "list_records_for_table", {
    baseId,
    tableId: table.id,
    filters: { operands: [{ operator: "=", operands: [fieldIds.domain, domain] }] },
  });
  // Values live on cellValuesByFieldId[fldXXX], not on r.fields[name].
  const rows = (listed.records as { cellValuesByFieldId: Record<string, unknown> }[]).map(
    (r) => r.cellValuesByFieldId,
  );
  return { fieldIds, rows };
}

// Every researchCompany run upserts to Airtable; clear the shared test domain once all suites finish.
afterAll(async () => {
  if (!HAS_AIRTABLE) return;
  const client = await getAirtableMcp();
  try {
    await deleteProspectByDomain(client, "stripe");
  } finally {
    await client.close();
  }
}, 60_000);

describe.skipIf(!HAS_KEY || !HAS_TAVILY_KEY || !HAS_AIRTABLE)(
  "researchCompany — structurer + persistence — real API",
  () => {
    let client: AirtableClient;
    let result: Awaited<ReturnType<typeof researchCompany>>;

    beforeAll(async () => {
      client = await getAirtableMcp();
      result = await researchCompany("Stripe");
    }, 120_000);

    afterAll(async () => {
      try {
        if (result?.prospect?.domain) await deleteProspectByDomain(client, result.prospect.domain);
      } finally {
        await client?.close();
      }
    }, 60_000);

    it("returns a prospect matching ProspectSchema", () => {
      expect(() => ProspectSchema.parse(result.prospect)).not.toThrow();
    });

    it("leadScore is an integer in [1, 100]", () => {
      const { leadScore } = result.prospect;
      expect(Number.isInteger(leadScore)).toBe(true);
      expect(leadScore).toBeGreaterThanOrEqual(1);
      expect(leadScore).toBeLessThanOrEqual(100);
    });

    it("signals is non-empty and every strength is strong, moderate, or weak", () => {
      const { signals } = result.prospect;
      expect(signals.length).toBeGreaterThan(0);
      for (const signal of signals) {
        expect(["strong", "moderate", "weak"]).toContain(signal.strength);
      }
    });

    it("returns a shape compatible with the Prospects table", async () => {
      const { fieldIds } = await readProspects(client, result.prospect.domain);
      for (const key of Object.keys(result.prospect)) {
        expect(Object.keys(fieldIds)).toContain(key);
      }
    });

    it("domain is canonical: lowercase, no protocol, no TLD", () => {
      const { domain } = result.prospect;
      expect(domain).toMatch(/^[a-z0-9]+$/);
      expect(domain).toBe("stripe");
    });

    it("persists exactly one Prospects row whose values match the returned prospect", async () => {
      const { prospect } = result;
      const { fieldIds, rows } = await readProspects(client, prospect.domain);
      expect(rows).toHaveLength(1);
      const [row] = rows;
      expect(row[fieldIds.leadScore]).toBe(prospect.leadScore);
      expect(row[fieldIds.companyName]).toBe(prospect.companyName);
      expect(new Date(row[fieldIds.lastResearched] as string).getTime()).toBe(
        new Date(prospect.lastResearched).getTime(),
      );
    });
  },
);

const ANALYSIS = `## Acme Freight

### Overview
Acme Freight is a regional freight forwarder moving containers between Rotterdam and Singapore for mid-size manufacturers.

### Buying Signals
- **Hiring activity (strong):** 12 open customer support roles posted this quarter, including Dutch and Mandarin speakers.
- **New geography (moderate):** Opened a Singapore office in March.

### Lead Score: 72

### Reasoning
Support hiring plus a new multilingual market points to rising ticket volume.

### Suggested Angle
Lead with multilingual triage for the Singapore launch.`;

describe.skipIf(!HAS_KEY)("structureProspect — real API", () => {
  it("returns a structured prospect with no domain or lastResearched key (§7.4)", async () => {
    const structured = await structureProspect(ANALYSIS, "Acme Freight");
    expect(structured.overview.trim().length).toBeGreaterThan(0);
    expect(structured.signals.length).toBeGreaterThan(0);
    expect("domain" in structured).toBe(false);
    expect("lastResearched" in structured).toBe(false);
  }, 60_000);
});
