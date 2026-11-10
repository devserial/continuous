import {
  McpUiResourceCsp,
  McpUiResourcePermissions,
  PostMessageTransport,
} from "@modelcontextprotocol/ext-apps";

import {
  AppBridge,
  buildAllowAttribute,
} from "@modelcontextprotocol/ext-apps/app-bridge";
import { ToolCallState } from "core";
import {
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useStore } from "react-redux";
import { IdeMessengerContext } from "../../../context/IdeMessenger";
import { useAppDispatch } from "../../../redux/hooks";
import { RootState } from "../../../redux/store";
import {
  McpAppApproval,
  runMcpAppToolCall,
  sendMcpAppTurn,
} from "./mcpAppToolCall";

/**
 * Build a CSP meta tag content string from McpUiResourceCsp configuration.
 * This allows the iframe to make network requests to the specified domains.
 */
function buildCspMetaContent(csp: McpUiResourceCsp | undefined): string {
  const resourceDomains = csp?.resourceDomains ?? [];
  const connectDomains = csp?.connectDomains ?? [];

  // Combine all external domains for resource loading
  const allDomains = [...new Set([...resourceDomains, ...connectDomains])];

  const defaultSrc = [
    "'self'",
    "'unsafe-inline'",
    "'unsafe-eval'",
    "blob:",
    "data:",
    ...allDomains,
  ].join(" ");
  const scriptSrc = [
    "'self'",
    "'unsafe-inline'",
    "'unsafe-eval'",
    "blob:",
    ...allDomains,
  ].join(" ");
  const styleSrc = ["'self'", "'unsafe-inline'", ...allDomains].join(" ");
  const imgSrc = ["'self'", "blob:", "data:", ...allDomains].join(" ");
  const fontSrc = ["'self'", "data:", ...allDomains].join(" ");
  const connectSrc = ["'self'", "blob:", "data:", ...allDomains].join(" ");
  const mediaSrc = ["'self'", "blob:", "data:", ...allDomains].join(" ");
  const frameSrc = ["'self'", "blob:", "data:", ...allDomains].join(" ");
  const workerSrc = ["'self'", "blob:", ...allDomains].join(" ");

  const directives = [
    `default-src ${defaultSrc}`,
    `script-src ${scriptSrc}`,
    `style-src ${styleSrc}`,
    `img-src ${imgSrc}`,
    `font-src ${fontSrc}`,
    `connect-src ${connectSrc}`,
    `media-src ${mediaSrc}`,
    `frame-src ${frameSrc}`,
    `worker-src ${workerSrc}`,
  ];

  return directives.join("; ");
}

function McpAppCallApproval({
  title,
  note,
  detail,
  onAccept,
  onReject,
}: McpAppApproval & {
  onAccept: () => void;
  onReject: () => void;
}) {
  return (
    <div
      className="absolute inset-0 z-20 flex flex-col items-center justify-center bg-black/85 p-5"
      data-testid="mcp-app-tool-approval"
    >
      <div className="max-w-[25rem] text-center">
        <p className="mb-2 text-sm font-medium text-foreground">
          Allow this app to call {title}?
        </p>
        {note && (
          <p className="mb-2 text-xs leading-relaxed text-description">
            {note}
          </p>
        )}
        {detail && (
          <pre className="mb-4 max-h-24 overflow-auto text-left text-2xs whitespace-pre-wrap text-description">
            {detail}
          </pre>
        )}
        <div className="flex items-center justify-center gap-2">
          <button
            type="button"
            onClick={onReject}
            data-testid="mcp-app-tool-reject"
            className="cursor-pointer rounded-sm border border-input bg-input px-4 py-2 text-xs font-medium text-foreground"
          >
            Reject
          </button>
          <button
            type="button"
            onClick={onAccept}
            data-testid="mcp-app-tool-accept"
            className="cursor-pointer rounded-sm border-none bg-primary px-4 py-2 text-xs font-medium text-primary-foreground hover:bg-primary-hover"
          >
            Accept
          </button>
        </div>
      </div>
    </div>
  );
}

/**
 * MCP App renderer using AppBridge with srcdoc iframe.
 * VS Code webviews have restrictive CSP that blocks iframe src URLs,
 * so we embed HTML directly via srcdoc and use AppBridge for the protocol.
 *
 * Handles MCP UI resource metadata:
 * - `permissions`: Sets iframe `allow` attribute (camera, microphone, geolocation, clipboard-write)
 * - `csp`: Passes CSP config to the app via sendSandboxResourceReady
 * - `prefersBorder`: Controls iframe border styling
 *
 * Note on permissions: We properly set the iframe's `allow` attribute based on
 * the MCP resource metadata. However, VS Code's webview runs in a sandboxed
 * Electron context with its own Permissions-Policy that doesn't allow delegating
 * sensitive permissions (microphone, camera, etc.) to nested iframes. This is a
 * VS Code/Electron security limitation that cannot be overridden from extensions.
 */
export function McpAppRenderer({
  toolCallState,
}: {
  toolCallState: ToolCallState;
}) {
  const ideMessenger = useContext(IdeMessengerContext);
  const dispatch = useAppDispatch();
  const store = useStore<RootState>();
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const toolCallStateRef = useRef(toolCallState);
  toolCallStateRef.current = toolCallState;
  const appBridgeRef = useRef<AppBridge | null>(null);
  const [iframeHeight, setIframeHeight] = useState(300);
  const [isInitialized, setIsInitialized] = useState(false);
  const [error, setError] = useState<Error | null>(null);

  const html = toolCallState.mcpUiState?.content.text;
  const uiMeta = toolCallState.mcpUiState?.content._meta?.ui;
  const toolInput = toolCallState.parsedArgs;
  const toolResult = toolCallState.output;

  // Extract metadata from the MCP UI resource
  const csp: McpUiResourceCsp | undefined = uiMeta?.csp;
  const permissions: McpUiResourcePermissions | undefined = uiMeta?.permissions;
  const prefersBorder = uiMeta?.prefersBorder ?? true;

  const [permissionWarningDismissed, setPermissionWarningDismissed] =
    useState(false);
  const [pendingApproval, setPendingApproval] = useState<
    (McpAppApproval & { resolve: (allowed: boolean) => void }) | null
  >(null);
  const pendingApprovalRef = useRef(pendingApproval);
  const approvalQueueRef = useRef<
    (McpAppApproval & { resolve: (allowed: boolean) => void })[]
  >([]);

  const settleApproval = useCallback((allowed: boolean) => {
    const current = pendingApprovalRef.current;
    if (!current) return;
    current.resolve(allowed);
    const next = approvalQueueRef.current.shift() ?? null;
    pendingApprovalRef.current = next;
    setPendingApproval(next);
  }, []);

  const askApproval = useCallback((approval: McpAppApproval) => {
    return new Promise<boolean>((resolve) => {
      const item = { ...approval, resolve };
      if (pendingApprovalRef.current) {
        approvalQueueRef.current.push(item);
        return;
      }
      pendingApprovalRef.current = item;
      setPendingApproval(item);
    });
  }, []);
  const askApprovalRef = useRef(askApproval);
  askApprovalRef.current = askApproval;

  useEffect(() => {
    return () => {
      pendingApprovalRef.current?.resolve(false);
      for (const item of approvalQueueRef.current) item.resolve(false);
      approvalQueueRef.current = [];
      pendingApprovalRef.current = null;
    };
  }, []);

  const restrictedPermissions = useMemo(() => {
    const restricted: string[] = [];
    if (permissions?.microphone) restricted.push("microphone");
    if (permissions?.camera) restricted.push("camera");
    if (permissions?.geolocation) restricted.push("geolocation");
    return restricted;
  }, [permissions]);

  const hasRestrictedPermissions = restrictedPermissions.length > 0;

  const sandboxAttribute = useMemo(() => {
    // SECURITY: Do NOT add 'allow-same-origin' together with 'allow-scripts'.
    // This combination allows untrusted MCP HTML to access the parent webview
    // via window.parent, defeating iframe sandboxing. Communication via
    // PostMessageTransport works without same-origin access.
    const sandboxPermissions = [
      "allow-scripts", // Required for MCP app JavaScript execution
      "allow-forms", // Allow form submissions within the iframe
    ];
    return sandboxPermissions.join(" ");
  }, []);

  const allowAttribute = useMemo(() => {
    const attr = buildAllowAttribute(permissions);
    return attr || undefined;
  }, [permissions]);

  useEffect(() => {
    const bridge = new AppBridge(
      null,
      { name: "Continuous", version: "1.0.0" },
      {
        openLinks: {},
        logging: {},
        message: { text: {} },
        updateModelContext: { text: {}, structuredContent: {} },
        serverTools: {},
      },
    );

    bridge.onsizechange = (params: { width?: number; height?: number }) => {
      if (params.height !== undefined) {
        setIframeHeight(Math.min(Math.max(params.height + 20, 100), 800));
      }
    };

    bridge.oninitialized = () => {
      setIsInitialized(true);
    };

    bridge.onopenlink = async (params: { url: string }) => {
      if (params.url) {
        ideMessenger.post("openUrl", params.url);
      }
      return {};
    };

    bridge.onmessage = async (params: { role: string; content: unknown[] }) => {
      const text = params.content
        .filter((item: any) => item.type === "text" && item.text)
        .map((item: any) => item.text)
        .join("\n");

      if (!text) {
        console.warn(
          "[McpAppRenderer] onMessage received with no text content",
        );
        return {};
      }

      void dispatch(
        sendMcpAppTurn({
          serverName: toolCallStateRef.current.tool?.group ?? "",
          text,
        }),
      );

      return {};
    };

    bridge.oncalltool = async (params: {
      name?: string;
      arguments?: unknown;
    }) => {
      const result = await runMcpAppToolCall({
        ideMessenger,
        dispatch,
        state: store.getState(),
        serverName: toolCallStateRef.current.tool?.group ?? "",
        requestedName: params.name ?? "",
        toolArguments: params.arguments,
        approve: (approval) => askApprovalRef.current(approval),
      });
      if (!result.ok) {
        throw new Error(result.error);
      }
      return {
        content: result.content,
        isError: false,
      };
    };

    bridge.onlistresources = async () => {
      return { resources: [] };
    };

    bridge.onreadresource = async () => {
      throw new Error("Resource reads not supported in this context");
    };

    bridge.onloggingmessage = (params: {
      level: string;
      logger?: string;
      data: unknown;
    }) => {
      const logFn =
        params.level === "error" || params.level === "critical"
          ? console.error
          : params.level === "warning"
            ? console.warn
            : console.log;
      logFn(
        `[MCP App${params.logger ? ` - ${params.logger}` : ""}]`,
        params.data,
      );

      // If the MCP app reports an error, hide the UI rather than
      // showing broken/confusing content
      if (params.level === "error" || params.level === "critical") {
        setError(new Error(String(params.data)));
      }
    };

    bridge.onupdatemodelcontext = async () => {
      return {};
    };

    appBridgeRef.current = bridge;

    return () => {
      appBridgeRef.current = null;
    };
  }, [ideMessenger, dispatch, store]);

  // Connect bridge to iframe when it loads
  const handleIframeLoad = useCallback(async () => {
    const iframe = iframeRef.current;
    const bridge = appBridgeRef.current;
    if (!iframe?.contentWindow || !bridge) return;

    try {
      const transport = new PostMessageTransport(
        iframe.contentWindow,
        iframe.contentWindow,
      );

      await bridge.connect(transport);

      if (html) {
        await bridge.sendSandboxResourceReady({
          html,
          csp,
          permissions,
        });
      }
    } catch (err) {
      console.error(
        "[Continuous] Failed to connect bridge to MCP App UI:",
        err,
      );
      setError(err instanceof Error ? err : new Error(String(err)));
    }
  }, [html, csp, permissions]);

  useEffect(() => {
    const bridge = appBridgeRef.current;
    if (!bridge || !isInitialized || !toolInput) return;
    try {
      bridge.sendToolInput({ arguments: toolInput });
    } catch (err) {
      console.warn("[McpAppRenderer] Failed to send tool input:", err);
      setError(err instanceof Error ? err : new Error(String(err)));
    }
  }, [isInitialized, toolInput]);

  useEffect(() => {
    const bridge = appBridgeRef.current;
    if (!bridge || !isInitialized || !toolResult) return;
    try {
      bridge.sendToolResult({
        content: toolResult.map((o) => ({
          type: "text" as const,
          text: o.content,
        })),
      });
    } catch (err) {
      console.warn("[McpAppRenderer] Failed to send tool result:", err);
      setError(err instanceof Error ? err : new Error(String(err)));
    }
  }, [isInitialized, toolResult]);

  if (!toolCallState.mcpUiState || !html) {
    return null;
  }

  if (error) {
    return null;
  }

  const cspMetaContent = buildCspMetaContent(csp);

  const srcdoc = `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta http-equiv="Content-Security-Policy" content="${cspMetaContent}">
  <style>
    html, body {
      margin: 0;
      padding: 0;
    }
    /* Minimal scrollbar styling */
    ::-webkit-scrollbar {
      width: 8px;
      height: 8px;
    }
    ::-webkit-scrollbar-track {
      background: transparent;
    }
    ::-webkit-scrollbar-thumb {
      background: rgba(128, 128, 128, 0.4);
      border-radius: 4px;
    }
    ::-webkit-scrollbar-thumb:hover {
      background: rgba(128, 128, 128, 0.6);
    }
    ::-webkit-scrollbar-corner {
      background: transparent;
    }
    /* Firefox */
    html {
      scrollbar-width: thin;
      scrollbar-color: rgba(128, 128, 128, 0.4) transparent;
    }
  </style>
</head>
<body>
${html}
</body>
</html>`;

  return (
    <div style={{ position: "relative", width: "100%" }}>
      <iframe
        ref={iframeRef}
        srcDoc={srcdoc}
        sandbox={sandboxAttribute}
        allow={allowAttribute}
        onLoad={handleIframeLoad}
        className={`w-full bg-input ${
          prefersBorder ? "rounded border border-input" : "border-none"
        }`}
        style={{ height: iframeHeight }}
        title={`MCP App - ${toolCallState.toolCall.function.name}`}
      />

      {pendingApproval && (
        <McpAppCallApproval
          title={pendingApproval.title}
          note={pendingApproval.note}
          detail={pendingApproval.detail}
          onAccept={() => settleApproval(true)}
          onReject={() => settleApproval(false)}
        />
      )}

      {hasRestrictedPermissions && !permissionWarningDismissed && (
        <div
          className={`absolute inset-0 z-10 flex flex-col items-center justify-center bg-black/85 p-5 ${
            prefersBorder ? "rounded" : ""
          }`}
        >
          <div className="max-w-[25rem] text-center">
            <div className="mb-3 text-2xl">⚠️</div>
            <p className="mb-2 text-sm font-medium text-foreground">
              Limited Functionality
            </p>
            <p className="mb-4 text-xs leading-relaxed text-description">
              This app requires{" "}
              <strong className="text-foreground">
                {restrictedPermissions.join(", ")}
              </strong>{" "}
              access, which is not currently supported. Some features may not
              work.
            </p>
            <button
              onClick={() => setPermissionWarningDismissed(true)}
              className="cursor-pointer rounded-sm border-none bg-primary px-4 py-2 text-xs font-medium text-primary-foreground hover:bg-primary-hover"
            >
              Continue Anyway
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
