import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import {
  deleteProspectByDomain,
  getAirtableMcp,
  getProspectIdByDomain,
  upsertProspect,
  type Prospect,
} from "../../src/tools/airtable.ts";

const REQUIRED_TOOLS = [
  "list_tables_for_base",
  "list_records_for_table",
  "create_records_for_table",
  "update_records_for_table",
  "delete_records_for_table",
];

const HAS_ENV = !!process.env.AIRTABLE_API_KEY && !!process.env.AIRTABLE_BASE_ID;
if (!HAS_ENV) {
  console.warn(
    "[skip] AIRTABLE_API_KEY or AIRTABLE_BASE_ID unset — Airtable real-API suite skipped",
  );
}

describe("Airtable MCP — missing env (always runs)", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("throws a clear error naming AIRTABLE_API_KEY when it is missing", async () => {
    vi.stubEnv("AIRTABLE_API_KEY", "");
    vi.stubEnv("AIRTABLE_BASE_ID", "appTEST");
    await expect(getAirtableMcp()).rejects.toThrow(/AIRTABLE_API_KEY/);
  });

  it("throws a clear error naming AIRTABLE_BASE_ID when it is missing", async () => {
    vi.stubEnv("AIRTABLE_API_KEY", "patTEST");
    vi.stubEnv("AIRTABLE_BASE_ID", "");
    await expect(getAirtableMcp()).rejects.toThrow(/AIRTABLE_BASE_ID/);
  });
});

describe.skipIf(!HAS_ENV)("Airtable MCP — real API", () => {
  it("connects, discovers the pinned CRUD tool names, and closes cleanly", async () => {
    const client = await getAirtableMcp();
    try {
      const tools = await client.tools();
      for (const name of REQUIRED_TOOLS) {
        expect(Object.keys(tools)).toContain(name);
      }
    } finally {
      await expect(client.close()).resolves.not.toThrow();
    }
  });
});

// Throwaway key: lowercase, no TLD, never collides with a real prospect.
const TEST_DOMAIN = "zz-airtable-wrapper-test";

const testProspect = (overrides: Partial<Prospect> = {}): Prospect => ({
  companyName: "ZZ Wrapper Test Co",
  domain: TEST_DOMAIN,
  overview: "Throwaway row written by the Airtable wrapper tests.",
  signals: [
    { name: "Hiring activity", description: "12 open support roles", strength: "strong" },
    { name: "Funding", description: "Series B announced", strength: "moderate" },
  ],
  leadScore: 55,
  scoreReasoning: "Test fixture.",
  suggestedAngle: "Test fixture.",
  lastResearched: new Date().toISOString(),
  ...overrides,
});

describe.skipIf(!HAS_ENV)("Airtable wrappers — real API", () => {
  afterAll(async () => {
    const client = await getAirtableMcp();
    try {
      await deleteProspectByDomain(client, TEST_DOMAIN);
    } finally {
      await client.close();
    }
  }, 60_000);

  it("getProspectIdByDomain returns null and deleteProspectByDomain returns 0 on no-match", async () => {
    const client = await getAirtableMcp();
    try {
      await deleteProspectByDomain(client, TEST_DOMAIN); // clear leftovers from a crashed run
      expect(await getProspectIdByDomain(client, TEST_DOMAIN)).toBeNull();
      expect(await deleteProspectByDomain(client, TEST_DOMAIN)).toBe(0);
    } finally {
      await client.close();
    }
  });

  it("upsertProspect creates once, updates in place on the second call, and never duplicates", async () => {
    const client = await getAirtableMcp();
    try {
      const first = await upsertProspect(client, testProspect({ leadScore: 55 }));
      expect(first.created).toBe(true);
      expect(first.id).toMatch(/^rec/);
      expect(await getProspectIdByDomain(client, TEST_DOMAIN)).toBe(first.id);

      const second = await upsertProspect(client, testProspect({ leadScore: 80 }));
      expect(second.created).toBe(false);
      expect(second.id).toBe(first.id);
      // getProspectIdByDomain throws if the domain matches more than one row.
      expect(await getProspectIdByDomain(client, TEST_DOMAIN)).toBe(first.id);
    } finally {
      await client.close();
    }
  });

  it("deleteProspectByDomain removes the row, verified by an independent read", async () => {
    const client = await getAirtableMcp();
    try {
      await upsertProspect(client, testProspect());
      expect(await deleteProspectByDomain(client, TEST_DOMAIN)).toBe(1);
      expect(await getProspectIdByDomain(client, TEST_DOMAIN)).toBeNull();
    } finally {
      await client.close();
    }
  });

  it("upsertProspect refuses an empty domain instead of guessing one", async () => {
    const client = await getAirtableMcp();
    try {
      await expect(upsertProspect(client, testProspect({ domain: "" }))).rejects.toThrow(/domain/);
    } finally {
      await client.close();
    }
  });
});
