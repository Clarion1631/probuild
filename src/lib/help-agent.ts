import { PermissionKey, hasPermission, canAccessProject } from "@/lib/permissions";
import { prisma } from "@/lib/prisma";

// Agent runtime for the in-app help chat: gives the assistant live access to
// ProBuild's own MCP server (src/app/api/mcp/[transport]/route.ts) so it can
// act on the user's behalf (find jobs, draft estimates/contracts/COs, log
// time, etc.) instead of only describing UI steps.

const MCP_PROTOCOL_VERSION = "2025-03-26";
const ADMIN_ROLES = ["ADMIN", "MANAGER"];

export interface McpTool {
  name: string;
  description?: string;
  inputSchema: Record<string, unknown>;
}

interface McpClient {
  listTools(): Promise<McpTool[]>;
  callTool(name: string, args: Record<string, unknown>): Promise<unknown>;
}

// onBehalfOfUserId rides in the query string alongside the shared secret, read
// by the MCP route's guarded() ONLY after the secret has authenticated the
// request — holding the secret is already full trust, so this param grants
// nothing extra. It just lets the route's audit log credit the signed-in
// human instead of always naming the connector account.
function mcpEndpoint(onBehalfOfUserId?: string | null): string | null {
  const secret = process.env.MCP_SECRET;
  if (!secret) return null;
  const baseUrl =
    process.env.NEXTAUTH_URL || process.env.NEXT_PUBLIC_APP_URL || "http://localhost:3000";
  const url = new URL("/api/mcp/mcp", baseUrl);
  url.searchParams.set("key", secret);
  if (onBehalfOfUserId) url.searchParams.set("onBehalfOf", onBehalfOfUserId);
  return url.toString();
}

// tools/list and tools/call responses may arrive as SSE ("data: {...}" lines)
// or as a plain JSON body, depending on how mcp-handler decides to respond.
function parseMcpBody(text: string): any {
  const dataLines = text.split("\n").filter((line) => line.startsWith("data: "));
  if (dataLines.length > 0) {
    return JSON.parse(dataLines[dataLines.length - 1].slice("data: ".length));
  }
  return JSON.parse(text);
}

let rpcId = 1;
function nextRpcId() {
  return rpcId++;
}

async function mcpRequest(
  endpoint: string,
  sessionId: string | null,
  body: Record<string, unknown>
): Promise<{ data: any; sessionId: string | null }> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Accept: "application/json, text/event-stream",
  };
  if (sessionId) headers["mcp-session-id"] = sessionId;

  let res: Response;
  try {
    res = await fetch(endpoint, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(45_000),
    });
  } catch (err) {
    // Never rethrow the raw fetch error — its message can embed the URL,
    // which carries the MCP secret in the query string.
    throw new Error(`MCP request failed: ${err instanceof Error ? err.name : "network error"}`);
  }

  if (!res.ok) {
    // Never include the URL in the error — it embeds the MCP secret.
    throw new Error(`MCP request failed with status ${res.status}`);
  }

  const newSessionId = res.headers.get("mcp-session-id") || sessionId;
  const text = await res.text();
  if (!text.trim()) return { data: null, sessionId: newSessionId };
  return { data: parseMcpBody(text), sessionId: newSessionId };
}

export async function mcpClient(onBehalfOfUserId?: string | null): Promise<McpClient> {
  const rawEndpoint = mcpEndpoint(onBehalfOfUserId);
  if (!rawEndpoint) {
    return {
      async listTools() {
        return [];
      },
      async callTool() {
        throw new Error("MCP is not configured (missing MCP_SECRET)");
      },
    };
  }
  const endpoint: string = rawEndpoint;

  let sessionPromise: Promise<string | null> | null = null;

  function ensureSession(): Promise<string | null> {
    if (!sessionPromise) {
      sessionPromise = (async () => {
        const init = await mcpRequest(endpoint, null, {
          jsonrpc: "2.0",
          id: nextRpcId(),
          method: "initialize",
          params: {
            protocolVersion: MCP_PROTOCOL_VERSION,
            capabilities: {},
            clientInfo: { name: "probuild-help-agent", version: "1.0.0" },
          },
        });
        const sessionId = init.sessionId;
        await mcpRequest(endpoint, sessionId, {
          jsonrpc: "2.0",
          method: "notifications/initialized",
        });
        return sessionId;
      })();
    }
    return sessionPromise;
  }

  return {
    async listTools() {
      const sessionId = await ensureSession();
      const { data } = await mcpRequest(endpoint, sessionId, {
        jsonrpc: "2.0",
        id: nextRpcId(),
        method: "tools/list",
      });
      return data?.result?.tools ?? [];
    },
    async callTool(name: string, args: Record<string, unknown>) {
      const sessionId = await ensureSession();
      const { data } = await mcpRequest(endpoint, sessionId, {
        jsonrpc: "2.0",
        id: nextRpcId(),
        method: "tools/call",
        params: { name, arguments: args },
      });
      if (data?.error) {
        throw new Error(data.error.message || "MCP tool call failed");
      }
      if (data?.result?.isError) {
        const msg =
          data.result.content?.map((c: any) => c.text).filter(Boolean).join("\n") ||
          "Tool reported an error";
        throw new Error(msg);
      }
      return data?.result?.content ?? data?.result ?? null;
    },
  };
}

// Every tool the MCP server exposes must be mapped to the permission that
// gates it in the UI. null = any authenticated team member. Tools that are
// NOT in this map (including any added to the MCP server later) default to
// ADMIN/MANAGER only — see isToolAllowedForUser below.
export const TOOL_PERMISSIONS: Record<string, PermissionKey | null> = {
  find_job: null,
  list_projects: null,

  list_leads: "leadAccess",
  create_lead: "createLead",

  get_estimating_codes: "estimates",
  list_templates: "estimates",
  get_template: "estimates",
  get_estimate: "estimates",
  create_estimate: "estimates",
  update_estimate: "estimates",
  send_estimate: "estimates",

  list_project_billing: "invoices",
  send_milestone_invoice: "invoices",
  resend_invoice: "invoices",
  create_invoice_from_estimate: "invoices",
  list_receivables: "invoices",

  create_change_order: "changeOrders",
  send_change_order: "changeOrders",
  list_change_orders: "changeOrders",
  bill_change_order: "changeOrders",

  list_contract_templates: "contracts",
  list_contracts: "contracts",
  get_contract: "contracts",
  create_contract: "contracts",
  update_contract: "contracts",
  send_contract: "contracts",

  get_company_schedule: "schedules",
  get_project_schedule: "schedules",
  plan_schedule: "schedules",
  update_task_dates: "schedules",
  set_task_status: "schedules",
  assign_task_crew: "schedules",
  list_crew_availability: "schedules",
  list_punch_items: "schedules",
  add_punch_items: "schedules",
  // set_project_start_date, generate_project_schedule, assign_project_crew,
  // and apply_change_order_to_schedule are deliberately left OUT of this map.
  // Unmapped tools fall through to ADMIN/MANAGER-only in isToolAllowedForUser
  // below, matching the ADMIN-gated UI actions these mirror in actions.ts.

  log_time: "timeClock",
  log_expense: "timeClock",

  list_project_files: "files",
  upload_file: "files",
  upload_files: "files",
  read_file: "files",
  get_file_link: "files",
  create_folder: "files",
  move_file: "files",

  create_daily_log: "dailyLogs",
  list_daily_logs: "dailyLogs",

  // get_project_contacts (client name/email/phone, subcontractor contacts) and
  // get_activity_log (company-wide audit trail — recipient emails, payment
  // amounts, reference numbers) are deliberately left OUT of this map: both
  // read too much PII for a blanket "any authenticated user" default. Unmapped
  // tools fall through to ADMIN/MANAGER-only in isToolAllowedForUser below.
};

function isToolAllowedForUser(
  user: { role: string; permissions?: any | null },
  toolName: string
): boolean {
  if (!(toolName in TOOL_PERMISSIONS)) {
    // Unmapped tool (e.g. new tool added to the MCP server): safe default.
    return ADMIN_ROLES.includes(user.role);
  }
  const key = TOOL_PERMISSIONS[toolName];
  if (key === null) return true;
  return hasPermission(user, key);
}

export interface HelpAgentUser {
  id: string;
  name?: string | null;
  role: string;
  permissions?: any | null;
  projectAccess?: { projectId: string }[];
  assignedProjects?: { id: string }[];
}

export interface HelpAgentMessage {
  role: "user" | "assistant";
  content: string;
}

export interface HelpAgentResult {
  text: string;
  activity: { tool: string; ok: boolean }[];
}

const MAX_ITERATIONS = 12;
// Total tool_use blocks executed across the whole request, not just loop
// iterations — a single model turn can contain many tool_use blocks at once.
const MAX_TOOL_CALLS = 30;

// Tools whose confirm step actually sends something to a client (email/etc).
// The in-app help chat may only ever generate a preview for these — the send
// itself must be completed from the ProBuild page, never from chat.
const UI_SEND_TOOLS = new Set([
  "send_estimate",
  "send_contract",
  "send_change_order",
  "send_milestone_invoice",
  "resend_invoice",
  "bill_change_order",
]);

// Recursively redacts any object key that looks like a confirm/send token so
// a send preview returned to the model can never carry a usable token back
// to it — structural prevention of self-confirmed sends, not just a prompt
// instruction.
function redactTokens(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(redactTokens);
  }
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, v] of Object.entries(value as Record<string, unknown>)) {
      out[key] = /token/i.test(key) ? "WITHHELD_COMPLETE_SEND_IN_PROBUILD_UI" : redactTokens(v);
    }
    return out;
  }
  if (typeof value === "string") {
    // Result parts can carry stringified JSON of their own — scrub token
    // keys inside nested string values too.
    return value.replace(
      /("[\w]*token[\w]*"\s*:\s*")(?:\\.|[^"\\])*(")/gi,
      "$1WITHHELD_COMPLETE_SEND_IN_PROBUILD_UI$2"
    );
  }
  return value;
}

// Final sweep over the exact string handed to the model for a send-tool
// result: the preview confirm tokens are 20-char lowercase-hex HMAC slices
// (see mintPreviewToken in the MCP route), so removing every 20-char hex run
// guarantees no usable token survives — regardless of result shape, error
// path, or how deeply the JSON was string-nested.
function redactSendTokenText(text: string): string {
  return text
    .replace(
      /(\\*"[\w]*token[\w]*\\*"\s*:\s*\\*")(?:\\.|[^"\\])*?(\\*")/gi,
      "$1WITHHELD_COMPLETE_SEND_IN_PROBUILD_UI$2"
    )
    .replace(/\b[0-9a-f]{20}\b/g, "WITHHELD_COMPLETE_SEND_IN_PROBUILD_UI");
}

// Args that name an entity whose project must be access-checked for
// project-scoped (non-ADMIN/MANAGER) users. A bare projectId arg is checked
// directly; these resolve the parent project first. A null projectId (a
// lead-scoped estimate/contract/task) is allowed through — lead access is
// gated by the leadAccess permission, not per-project assignment.
const ENTITY_PROJECT_LOOKUPS: Record<string, (id: string) => Promise<string | null>> = {
  estimateId: async (id) =>
    (await prisma.estimate.findUnique({ where: { id }, select: { projectId: true } }))?.projectId ?? null,
  invoiceId: async (id) =>
    (await prisma.invoice.findUnique({ where: { id }, select: { projectId: true } }))?.projectId ?? null,
  contractId: async (id) =>
    (await prisma.contract.findUnique({ where: { id }, select: { projectId: true } }))?.projectId ?? null,
  changeOrderId: async (id) =>
    (await prisma.changeOrder.findUnique({ where: { id }, select: { projectId: true } }))?.projectId ?? null,
  taskId: async (id) =>
    (await prisma.scheduleTask.findUnique({ where: { id }, select: { projectId: true } }))?.projectId ?? null,
  fileId: async (id) =>
    (await prisma.projectFile.findUnique({ where: { id }, select: { projectId: true } }))?.projectId ?? null,
};

// Returns null when allowed, or a denial message for a project the user
// can't access (directly via args.projectId or implied via an entity id).
async function projectScopeDenial(
  user: HelpAgentUser,
  args: Record<string, unknown>
): Promise<string | null> {
  if (ADMIN_ROLES.includes(user.role)) return null;
  if (typeof args.projectId === "string" && args.projectId && !canAccessProject(user, args.projectId)) {
    return "Permission denied: you don't have access to that project.";
  }
  for (const [argName, lookup] of Object.entries(ENTITY_PROJECT_LOOKUPS)) {
    const id = args[argName];
    if (typeof id !== "string" || !id) continue;
    const projectId = await lookup(id);
    if (projectId && !canAccessProject(user, projectId)) {
      return "Permission denied: you don't have access to that project.";
    }
  }
  return null;
}

export async function runHelpAgent({
  user,
  question,
  priorMessages,
  currentPage,
}: {
  user: HelpAgentUser;
  question: string;
  priorMessages: HelpAgentMessage[];
  currentPage?: string | null;
}): Promise<HelpAgentResult> {
  const client = await mcpClient(user.id);
  const allTools = await client.listTools();
  const allowedTools = allTools.filter((t) => isToolAllowedForUser(user, t.name));
  // The only names execution will accept — covers both "not permitted" and
  // "not a real tool on the server" (a hallucinated name must not reach MCP).
  const allowedToolNames = new Set(allowedTools.map((t) => t.name));

  const anthropicTools = allowedTools.map((t) => ({
    name: t.name,
    description: t.description ?? "",
    input_schema: t.inputSchema,
  }));

  // currentPage is client-controlled and gets interpolated straight into the
  // system prompt — only trust it when it looks like a route/path.
  const safeCurrentPage =
    typeof currentPage === "string" && /^[a-zA-Z0-9\/\[\]._-]{1,100}$/.test(currentPage)
      ? currentPage
      : null;
  const pageContext = safeCurrentPage ? `, currently on the "${safeCurrentPage}" page` : "";

  const systemPrompt = `You are ProBuild's operations assistant for a remodeling company. You have live tools that can act on the user's behalf inside ProBuild — use them rather than describing UI steps.

The user is ${user.name || "a team member"} (${user.role})${pageContext}.

Rules:
1. Everything you create lands as a Draft. A send_* tool only ever produces a preview (recipient + amounts) — the in-app chat cannot and will not complete the actual send, even if asked; that step is structurally blocked and always finishes from the ProBuild page (or via the user's connected ChatGPT/Claude). If asked to send something, show the preview and say plainly that they need to finish it from the ProBuild page.
2. When asked to build something (an estimate, contract, change order, etc.), find the job with find_job first, create the draft, then summarize what you made and where to find it.
3. If the user reports a bug or asks for a feature that doesn't exist, respond with ONLY the JSON object {"type":"bug_report","title":...,"description":...,"steps":...} or {"type":"feature_request","title":...,"description":...} exactly as this contract — no markdown fences, no other text.
4. Keep answers short and concrete.`;

  const messages: any[] = priorMessages.map((m) => ({ role: m.role, content: m.content }));
  messages.push({ role: "user", content: question });

  const activity: { tool: string; ok: boolean }[] = [];
  let totalToolCalls = 0;

  for (let iteration = 0; iteration < MAX_ITERATIONS; iteration++) {
    const response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": process.env.ANTHROPIC_API_KEY!,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: "claude-sonnet-4-6",
        max_tokens: 2048,
        system: systemPrompt,
        messages,
        ...(anthropicTools.length > 0 ? { tools: anthropicTools } : {}),
      }),
      signal: AbortSignal.timeout(120_000),
    });

    if (!response.ok) {
      const err = await response.text();
      throw new Error(`Anthropic API error: ${err}`);
    }

    const data = await response.json();
    const content = data.content ?? [];
    messages.push({ role: "assistant", content });

    if (data.stop_reason !== "tool_use") {
      const text = content
        .filter((block: any) => block.type === "text")
        .map((block: any) => block.text)
        .join("\n");
      return { text, activity };
    }

    const toolResults: any[] = [];
    for (const block of content) {
      if (block.type !== "tool_use") continue;

      const args = (block.input ?? {}) as Record<string, unknown>;
      let ok = true;
      let denied = false;
      let resultContent: unknown;

      totalToolCalls++;
      if (totalToolCalls > MAX_TOOL_CALLS) {
        ok = false;
        denied = true;
        resultContent = "Tool budget for this request is exhausted — summarize progress so far.";
      } else if (!allowedToolNames.has(block.name) || !isToolAllowedForUser(user, block.name)) {
        // Defense in depth: the tools array sent to the model is already
        // pre-filtered, but re-check at execution time so a denied,
        // unmapped, or hallucinated tool name can never reach MCP.
        ok = false;
        denied = true;
        resultContent = "Permission denied: your account does not have access to this tool.";
      } else if (UI_SEND_TOOLS.has(block.name) && args.confirmToken) {
        // Structural send gate: even if the model was handed a confirmToken
        // from an earlier preview, in-app chat may never use it to send.
        ok = false;
        denied = true;
        resultContent =
          "In-app chat cannot execute sends. The preview is ready — the user completes the send from the ProBuild page (or via their connected ChatGPT/Claude).";
      } else {
        const scopeDenial = await projectScopeDenial(user, args);
        if (scopeDenial) {
          ok = false;
          denied = true;
          resultContent = scopeDenial;
        }
      }

      if (!denied) {
        try {
          resultContent = await client.callTool(block.name, args);
        } catch (err) {
          ok = false;
          resultContent = err instanceof Error ? err.message : "Tool call failed";
        }

        // Redact any confirm/send token in a send-preview result so it can
        // never be handed back to the model and replayed as a confirmation.
        if (ok && UI_SEND_TOOLS.has(block.name) && Array.isArray(resultContent)) {
          resultContent = resultContent.map((part: any) => {
            if (part && typeof part === "object" && typeof part.text === "string") {
              try {
                const parsed = JSON.parse(part.text);
                return { ...part, text: JSON.stringify(redactTokens(parsed)) };
              } catch {
                return part;
              }
            }
            return part;
          });
        }
      }

      activity.push({ tool: block.name, ok });
      let contentStr =
        typeof resultContent === "string" ? resultContent : JSON.stringify(resultContent);
      // Belt and braces on the EXACT string the model will see: whatever the
      // result shape or error path, no send-preview confirm token survives.
      if (UI_SEND_TOOLS.has(block.name)) contentStr = redactSendTokenText(contentStr);
      toolResults.push({
        type: "tool_result",
        tool_use_id: block.id,
        content: contentStr,
        ...(ok ? {} : { is_error: true }),
      });
    }
    messages.push({ role: "user", content: toolResults });
  }

  return {
    text: "I wasn't able to finish that within the allotted number of steps — could you narrow the request?",
    activity,
  };
}
