import { expect, test } from "vitest";
import { MCPServerStatus, MCPTool } from "..";
import { BuiltInToolNames } from "./builtIn";
import { getMCPToolName, getToolNameFromMCPServer } from "./mcpToolName";

const createMcpServer = (name: string): MCPServerStatus => ({
  name,
  errors: [],
  infos: [],
  prompts: [],
  tools: [],
  resources: [],
  resourceTemplates: [],
  status: "connected",
  id: "",
  type: "sse",
  url: "",
  isProtectedResource: false,
});

const createMCPTool = (name: string): MCPTool => ({
  name,
  inputSchema: {
    type: "object",
  },
});

test("getMCPToolName - adds server prefix to tool name when not present", () => {
  const server = createMcpServer("Github");
  const tool = createMCPTool("create_pull_request");

  const result = getMCPToolName(server, tool);
  expect(result).toBe("github_create_pull_request");
});

test("getMCPToolName - preserves tool name when it already starts with server prefix", () => {
  const server = createMcpServer("Github");
  const tool = createMCPTool("github_create_pull_request");

  const result = getMCPToolName(server, tool);
  expect(result).toBe("github_create_pull_request");
});

test("getMCPToolName - handles server names with spaces", () => {
  const server = createMcpServer("Azure DevOps");
  const tool = createMCPTool("create_pipeline");

  const result = getMCPToolName(server, tool);
  expect(result).toBe("azure_devops_create_pipeline");
});

test("getMCPToolName - handles mixed case in server names", () => {
  const server = createMcpServer("GitLab");
  const tool = createMCPTool("create_merge_request");

  const result = getMCPToolName(server, tool);
  expect(result).toBe("gitlab_create_merge_request");
});

test("getMCPToolName - handles server names with special characters (parentheses)", () => {
  const server = createMcpServer("Linear MCP (SSE)");
  const tool = createMCPTool("create_issue");

  const result = getMCPToolName(server, tool);
  // Should only contain alphanumeric characters and underscores
  expect(result).toMatch(/^[a-zA-Z0-9_]+$/);
  expect(result).toBe("linear_mcp_sse_create_issue");
});

test("getMCPToolName - handles server names with dots and other special characters", () => {
  const server = createMcpServer("My.Server@Test!");
  const tool = createMCPTool("test_action");

  const result = getMCPToolName(server, tool);
  // Should only contain alphanumeric characters and underscores
  expect(result).toMatch(/^[a-zA-Z0-9_]+$/);
  expect(result).toBe("my_server_test_test_action");
});

test("getMCPToolName - handles server names with multiple consecutive special characters", () => {
  const server = createMcpServer("Server@@##Name");
  const tool = createMCPTool("action");

  const result = getMCPToolName(server, tool);
  // Should only contain alphanumeric characters and underscores (no hyphens or multiple underscores)
  expect(result).toMatch(/^[a-zA-Z0-9_]+$/);
  expect(result).toBe("server_name_action");
});

test("getMCPToolName - handles server names with hyphens", () => {
  const server = createMcpServer("My-Server-Name");
  const tool = createMCPTool("test_action");

  const result = getMCPToolName(server, tool);
  // Should only contain alphanumeric characters and underscores
  expect(result).toMatch(/^[a-zA-Z0-9_]+$/);
  expect(result).toBe("my_server_name_test_action");
});

test("getMCPToolName - handles multiple consecutive underscores in server name", () => {
  const server = createMcpServer("Linear__MCP");
  const tool = createMCPTool("create_issue");

  const result = getMCPToolName(server, tool);
  // Should only contain alphanumeric characters and single underscores
  expect(result).toMatch(/^[a-zA-Z0-9_]+$/);
  expect(result).not.toMatch(/__/);
  expect(result).toBe("linear_mcp_create_issue");
});

test("getToolNameFromMCPServer - a shorter slug does not claim a longer name", () => {
  expect(getToolNameFromMCPServer("git", "github_delete_repository")).toBe(
    "git_github_delete_repository",
  );
  expect(getToolNameFromMCPServer("R", "read_file")).toBe("r_read_file");
  expect(getToolNameFromMCPServer("Run", "run_terminal_command")).toBe(
    "run_run_terminal_command",
  );
  expect(getToolNameFromMCPServer("Run", "terminal_command")).toBe(
    "run_mcp_terminal_command",
  );
});

test("getToolNameFromMCPServer - a server slug never resolves to a built-in tool", () => {
  const builtIns = Object.values(BuiltInToolNames);
  for (const builtIn of builtIns) {
    const head = builtIn.split("_")[0] ?? builtIn;
    const rest = builtIn.split("_").slice(1).join("_");
    const servers = [builtIn, head, builtIn.slice(0, 1)].filter(Boolean);
    const requested = [builtIn, rest].filter(Boolean);
    for (const server of servers) {
      for (const name of requested) {
        const result = getToolNameFromMCPServer(server, name);
        expect(builtIns, `${server} + ${name} -> ${result}`).not.toContain(
          result,
        );
      }
    }
  }
});
