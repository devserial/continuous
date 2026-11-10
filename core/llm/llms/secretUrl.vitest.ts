import { afterEach, describe, expect, it, vi } from "vitest";
import { BaseLLM } from "../index";
import VertexAI from "./VertexAI";
import WatsonX from "./WatsonX";

describe("API keys stay out of request URLs", () => {
  afterEach(() => vi.restoreAllMocks());

  it("Vertex express mode sends the key as a header", async () => {
    const llm = new VertexAI({
      model: "gemini-2.0-flash",
      apiKey: "AIzaSecretValue",
    });
    const seen: { url?: string; headers?: Record<string, string> } = {};
    vi.spyOn(BaseLLM.prototype, "fetch").mockImplementation(
      async (url, init) => {
        seen.url = String(url);
        seen.headers = init?.headers as Record<string, string>;
        return new Response("{}", { status: 200 });
      },
    );
    await llm.fetch(new URL("https://aiplatform.googleapis.com/v1/models"), {});
    expect(seen.url).not.toContain("AIzaSecretValue");
    expect(seen.headers?.["x-goog-api-key"]).toBe("AIzaSecretValue");
  });

  it("a non-2xx error does not include the key from the URL", async () => {
    const llm = new VertexAI({
      model: "gemini-2.0-flash",
      apiKey: "AIzaSecretValue",
    });
    const error = await (llm as any).parseError({
      status: 429,
      statusText: "Too Many Requests",
      url: "https://aiplatform.googleapis.com/v1/models?key=AIzaSecretValue&alt=sse",
      text: async () => "quota",
    });
    expect(error.message).not.toContain("AIzaSecretValue");
    expect(error.message).toContain("REDACTED");
    expect(error.message).toContain("alt=sse");
  });

  it("watsonx sends the API key in the form body", async () => {
    const llm = new WatsonX({
      model: "ibm/granite",
      apiKey: "wx-secret-value",
      apiBase: "https://us-south.ml.cloud.ibm.com",
      env: { apiVersion: "2023-05-29" },
    });
    const seen: { url?: string; body?: string } = {};
    vi.spyOn(BaseLLM.prototype, "fetch").mockImplementation(
      async (url, init) => {
        seen.url = String(url);
        seen.body = String(init?.body ?? "");
        return new Response(
          JSON.stringify({ access_token: "t", expiration: 1 }),
          { status: 200 },
        );
      },
    );
    await llm.getBearerToken();
    expect(seen.url).not.toContain("wx-secret-value");
    expect(seen.body).toContain("apikey=wx-secret-value");
  });
});
