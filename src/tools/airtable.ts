import { experimental_createMCPClient as createMCPClient } from "@ai-sdk/mcp";

const AIRTABLE_MCP_URL = "https://mcp.airtable.com/mcp/";

export async function getAirtableMcp() {
  const apiKey = process.env.AIRTABLE_API_KEY;
  const baseId = process.env.AIRTABLE_BASE_ID;
  if (!apiKey) {
    throw new Error(
      "AIRTABLE_API_KEY is not set. Add it to .env or your Codespaces secrets.",
    );
  }
  if (!baseId) {
    throw new Error(
      "AIRTABLE_BASE_ID is not set. Copy it from the Airtable base URL (app...) into .env or your Codespaces secrets.",
    );
  }

  return createMCPClient({
    transport: {
      type: "http",
      url: AIRTABLE_MCP_URL,
      headers: { Authorization: `Bearer ${apiKey}` },
    },
  });
}

type AirtableClient = Awaited<ReturnType<typeof getAirtableMcp>>;

// Mirrors the §7.1 Prospect shape; becomes z.infer<typeof ProspectSchema> once research.ts owns the schema.
export type Prospect = {
  companyName: string;
  domain: string;
  overview: string;
  signals: { name: string; description: string; strength: "strong" | "moderate" | "weak" }[];
  leadScore: number;
  scoreReasoning: string;
  suggestedAngle: string;
  lastResearched: string;
};

type McpResult = {
  isError?: boolean;
  content?: { type: string; text?: string }[];
  structuredContent?: unknown;
};

type McpTool = { execute?: (args: unknown, options: unknown) => PromiseLike<unknown> | unknown };

// Exact names pinned by PRD §12.3 — never fuzzy-match (`/create.records?/` hits create_record_comment first).
const REQUIRED_TOOLS = [
  "list_tables_for_base",
  "list_records_for_table",
  "create_records_for_table",
  "update_records_for_table",
  "delete_records_for_table",
] as const;
type ToolName = (typeof REQUIRED_TOOLS)[number];

type Handles = {
  baseId: string;
  call: (name: ToolName, args: Record<string, unknown>) => Promise<any>;
  prospectsTableId: string;
  prospectFields: Record<string, string>; // field name -> fldXXX
};

// Handles are resolved once per client and reused (§12.3).
const handlesByClient = new WeakMap<AirtableClient, Promise<Handles>>();

async function callTool(tools: Record<string, McpTool>, name: ToolName, args: Record<string, unknown>) {
  const result = (await tools[name].execute!(args, { toolCallId: name, messages: [] })) as McpResult;
  if (result.isError) {
    throw new Error(`Airtable ${name} failed: ${result.content?.[0]?.text ?? "unknown error"}`);
  }
  return result.structuredContent ?? JSON.parse(result.content![0].text!);
}

async function resolveHandles(client: AirtableClient): Promise<Handles> {
  const baseId = process.env.AIRTABLE_BASE_ID!;
  const tools = (await client.tools()) as unknown as Record<string, McpTool>;
  const missing = REQUIRED_TOOLS.filter((n) => !(n in tools) || !tools[n].execute);
  if (missing.length) {
    throw new Error(`Airtable write fails: MCP server is missing required tool(s): ${missing.join(", ")}`);
  }
  const call = (name: ToolName, args: Record<string, unknown>) => callTool(tools, name, args);

  const schema = await call("list_tables_for_base", { baseId });
  const table = schema.tables.find((t: { name: string }) => t.name === "Prospects");
  if (!table) throw new Error(`Airtable write fails: base ${baseId} has no "Prospects" table`);
  const prospectFields = Object.fromEntries(table.fields.map((f: { name: string; id: string }) => [f.name, f.id]));
  for (const name of ["domain", "companyName", "overview", "signals", "leadScore", "scoreReasoning", "suggestedAngle", "status", "lastResearched"]) {
    if (!prospectFields[name]) throw new Error(`Airtable write fails: Prospects table has no "${name}" field`);
  }
  return { baseId, call, prospectsTableId: table.id, prospectFields };
}

function getHandles(client: AirtableClient): Promise<Handles> {
  let handles = handlesByClient.get(client);
  if (!handles) {
    handles = resolveHandles(client);
    handlesByClient.set(client, handles);
    handles.catch(() => handlesByClient.delete(client)); // don't cache a failed resolve
  }
  return handles;
}

async function listProspectsByDomain(h: Handles, domain: string): Promise<{ id: string }[]> {
  const result = await h.call("list_records_for_table", {
    baseId: h.baseId,
    tableId: h.prospectsTableId,
    filters: { operands: [{ operator: "=", operands: [h.prospectFields.domain, domain] }] },
  });
  const records: { id: string }[] = result.records ?? [];
  // A dropped filter returns the whole table, and duplicate domains are forbidden (§13.2): either way, refuse.
  if (records.length > 1) {
    throw new Error(`Expected at most one Prospects row for domain "${domain}", found ${records.length}`);
  }
  return records;
}

export async function getProspectIdByDomain(client: AirtableClient, domain: string): Promise<string | null> {
  const h = await getHandles(client);
  const [match] = await listProspectsByDomain(h, domain);
  return match?.id ?? null;
}

export async function upsertProspect(
  client: AirtableClient,
  prospect: Prospect,
): Promise<{ id: string; created: boolean }> {
  if (!prospect.domain) throw new Error("upsertProspect requires a non-empty domain (§7.4: no silent fallbacks)");
  const h = await getHandles(client);
  const f = h.prospectFields;

  const fields: Record<string, unknown> = {
    [f.domain]: prospect.domain,
    [f.companyName]: prospect.companyName,
    [f.overview]: prospect.overview,
    [f.signals]: prospect.signals.map((s) => `- **${s.name}** (${s.strength}): ${s.description}`).join("\n"),
    [f.leadScore]: prospect.leadScore,
    [f.scoreReasoning]: prospect.scoreReasoning,
    [f.suggestedAngle]: prospect.suggestedAngle,
    [f.lastResearched]: prospect.lastResearched,
  };

  const [match] = await listProspectsByDomain(h, prospect.domain);
  if (match) {
    // status is left alone on update so a re-research doesn't reset contacted/replied/dead.
    await h.call("update_records_for_table", {
      baseId: h.baseId,
      tableId: h.prospectsTableId,
      records: [{ id: match.id, fields }],
    });
    return { id: match.id, created: false };
  }

  const created = await h.call("create_records_for_table", {
    baseId: h.baseId,
    tableId: h.prospectsTableId,
    records: [{ fields: { ...fields, [f.status]: "researched" } }],
    typecast: true,
  });
  const id: string | undefined = created.records?.[0]?.id;
  if (!id) throw new Error("Airtable create_records_for_table returned no record id");
  return { id, created: true };
}

export async function deleteProspectByDomain(client: AirtableClient, domain: string): Promise<number> {
  const h = await getHandles(client);
  const id = await getProspectIdByDomain(client, domain);
  if (!id) return 0;
  await h.call("delete_records_for_table", {
    baseId: h.baseId,
    tableId: h.prospectsTableId,
    recordIds: [id],
  });
  return 1;
}
