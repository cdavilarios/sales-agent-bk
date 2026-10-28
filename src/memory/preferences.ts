import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { tool } from "ai";
import { z } from "zod";

const PREFERENCES_PATH = "src/memory/preferences.md";
const HEADER = "# Preferences";

const textInput = z.object({
  text: z.string().trim().min(1).describe("The preference, as one sentence"),
});

function read(): string {
  return existsSync(PREFERENCES_PATH) ? readFileSync(PREFERENCES_PATH, "utf8") : "";
}

// Bullets are single lines: collapse any newlines so one preference is one `- ` line.
const toBullet = (text: string) => `- ${text.replace(/\s*\n\s*/g, " ")}`;

export const listPreferences = tool({
  description:
    "Read the user's saved preferences (Markdown bullets). Call this FIRST on every run, before researching, " +
    "and apply any preference that matches the company. Returns an empty string if none are saved.",
  inputSchema: z.object({}),
  execute: async (): Promise<string> => read(),
});

export const addPreference = tool({
  description:
    "Save a preference the user explicitly stated (e.g. 'for shipping companies, always lead with X', " +
    "'prefer subject lines under 50 characters'). Call it in the same turn the user states it, then say " +
    "'Saved preference: <text>'. Never save a preference the user did not state. Adding the same text twice is a no-op.",
  inputSchema: textInput,
  execute: async ({ text }): Promise<string> => {
    const bullet = toBullet(text);
    const existing = read();
    if (existing.split("\n").includes(bullet)) return `Already saved: ${text}`;

    const base = existing.trim() ? existing.replace(/\n*$/, "\n") : `${HEADER}\n\n`;
    writeFileSync(PREFERENCES_PATH, `${base}${bullet}\n`);
    return `Saved preference: ${text}`;
  },
});

export const removePreference = tool({
  description:
    "Remove a saved preference when the user asks to forget or drop it. Pass any distinctive part of the " +
    "preference text; matching is case-insensitive and removes only the first matching bullet.",
  inputSchema: textInput,
  execute: async ({ text }): Promise<string> => {
    const needle = text.toLowerCase();
    const lines = read().split("\n");
    const index = lines.findIndex((l) => l.startsWith("- ") && l.toLowerCase().includes(needle));
    if (index === -1) return `No saved preference matches: ${text}`;

    const [removed] = lines.splice(index, 1);
    writeFileSync(PREFERENCES_PATH, lines.join("\n"));
    return `Removed preference: ${removed.slice(2)}`;
  },
});
