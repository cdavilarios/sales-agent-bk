import { existsSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ToolCallOptions } from "@ai-sdk/provider-utils";
import {
  addPreference,
  listPreferences,
  removePreference,
} from "../../src/memory/preferences.ts";

const PREFS = "src/memory/preferences.md";
// A real preferences file is moved aside (not held in memory) so a crashed run leaves it recoverable.
const BACKUP = "src/memory/preferences.md.test-backup";
const OPTIONS = { toolCallId: "test", messages: [] } satisfies ToolCallOptions;

const list = async () => (await listPreferences.execute!({}, OPTIONS)) as string;
const add = (text: string) => addPreference.execute!({ text }, OPTIONS);
const remove = (text: string) => removePreference.execute!({ text }, OPTIONS);
const bullets = (content: string) => content.split("\n").filter((l) => l.startsWith("- "));

describe("Preferences memory — real file", () => {
  beforeEach(() => {
    if (existsSync(PREFS) && !existsSync(BACKUP)) renameSync(PREFS, BACKUP);
    rmSync(PREFS, { force: true }); // every test starts with no file
  });

  afterEach(() => {
    rmSync(PREFS, { force: true });
    if (existsSync(BACKUP)) renameSync(BACKUP, PREFS);
  });

  it("listPreferences returns an empty string when the file does not exist", async () => {
    expect(await list()).toBe("");
  });

  it("listPreferences returns the file contents as a string", async () => {
    const seeded = "# Preferences\n\n- Prefer subject lines under 50 characters.\n";
    writeFileSync(PREFS, seeded);
    expect(await list()).toBe(seeded);
  });

  it("addPreference creates the file with a '# Preferences' header on first write", async () => {
    await add("Always include the hiring trajectory.");
    const onDisk = readFileSync(PREFS, "utf8");
    expect(onDisk.startsWith("# Preferences")).toBe(true);
    expect(bullets(onDisk)).toEqual(["- Always include the hiring trajectory."]);
  });

  it("addPreference appends a new bullet to an existing file and round-trips through listPreferences", async () => {
    await add("First preference.");
    await add("Second preference.");
    const content = await list();
    expect(bullets(content)).toEqual(["- First preference.", "- Second preference."]);
    expect(content.match(/^# Preferences/gm)).toHaveLength(1);
  });

  it("addPreference is idempotent on exact match", async () => {
    await add("Prefer subject lines under 50 characters.");
    await add("Prefer subject lines under 50 characters.");
    expect(bullets(await list())).toEqual(["- Prefer subject lines under 50 characters."]);
  });

  it("removePreference removes a bullet by case-insensitive substring", async () => {
    await add("Always include the hiring trajectory.");
    await add("Prefer subject lines under 50 characters.");
    await remove("HIRING TRAJECTORY");
    expect(bullets(await list())).toEqual(["- Prefer subject lines under 50 characters."]);
  });

  it("removePreference removes only the first match when several bullets match", async () => {
    await add("For shipping companies, lead with multilingual deflection.");
    await add("For retail companies, lead with multilingual triage.");
    await remove("multilingual");
    expect(bullets(await list())).toEqual(["- For retail companies, lead with multilingual triage."]);
  });
});
