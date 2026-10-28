import { describe, expect, it } from "vitest";
import { researchCompany } from "../src/agent/research.ts";

const HAS_KEY = !!process.env.ANTHROPIC_API_KEY;
if (!HAS_KEY) {
  console.warn(
    "[skip] ANTHROPIC_API_KEY unset — researchCompany real-API suite skipped",
  );
}

describe.skipIf(!HAS_KEY)("researchCompany — real API", () => {
  it("returns a non-empty response for a company name", async () => {
    const text = await researchCompany("Stripe");
    expect(typeof text).toBe("string");
    expect(text.trim().length).toBeGreaterThan(0);
  });
});
