/**
 * 能力テスト (#206 M2) の検証。
 * モック OpenAI 互換 endpoint を立て、tool 対応 / 非対応 / 到達不能 を判定できるか確認する。
 * Usage (container 内): npx tsx scripts/test-model-capabilities.ts
 *
 * 設計: docs/model-config-overhaul.md §2.3 / §7 (テスト計画)
 */
import http from "node:http";
import type { AddressInfo } from "node:net";
import { testModelCapabilities } from "@/lib/model-call";
import type { ModelEntry } from "@/lib/model-registry";
import { callOpenAICompat } from "@/lib/llm-providers/openai";
import { callGemini } from "@/lib/llm-providers/gemini";
import type Anthropic from "@anthropic-ai/sdk";

let passed = 0;
const failures: string[] = [];
function check(cond: boolean, msg: string) {
  if (cond) {
    passed++;
    console.log(`  ✓ ${msg}`);
  } else {
    failures.push(msg);
    console.log(`  ✗ ${msg}`);
  }
}

/** local_openai entry を base_url 指定で作る (DB 不要、テスト専用)。 */
function localEntry(baseUrl: string): ModelEntry {
  return {
    id: "test",
    label: "mock-local",
    provider: "local_openai",
    modelId: "mock-model",
    baseUrl,
    apiKeyRef: null,
    capabilities: {},
    thinkingMode: "auto",
  };
}

type ServerMode = "tools-ok" | "tools-400" | "text-only" | "tools-need-thinking";

/** OpenAI 互換 /chat/completions のモック。mode で挙動を切替。 */
function startMockServer(mode: ServerMode): Promise<{ baseUrl: string; close: () => Promise<void> }> {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        const parsed = JSON.parse(body || "{}") as { tools?: unknown[]; chat_template_kwargs?: { enable_thinking?: boolean } };
        const hasTools = Array.isArray(parsed.tools) && parsed.tools.length > 0;
        const thinkingOn = parsed.chat_template_kwargs?.enable_thinking === true;

        // 思考 ON でのみ tool を返すモデル (= §8.8.3 再 probe の対象)。
        // thinking-off (enable_thinking:false) では text、thinking-on で tool_use。
        if (hasTools && mode === "tools-need-thinking") {
          if (thinkingOn) {
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ id: "m", model: "mock", choices: [{ index: 0, message: { role: "assistant", content: null, tool_calls: [{ id: "c1", type: "function", function: { name: "echo", arguments: "{}" } }] }, finish_reason: "tool_calls" }], usage: {} }));
          } else {
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ id: "m", model: "mock", choices: [{ index: 0, message: { role: "assistant", content: "no tool" }, finish_reason: "stop" }], usage: {} }));
          }
          return;
        }

        // tool 付きリクエストを受け付けない endpoint をシミュレート (= 4xx)
        if (hasTools && mode === "tools-400") {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: { message: "tools not supported" } }));
          return;
        }

        // tool 対応: tool_calls を返す
        if (hasTools && mode === "tools-ok") {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(
            JSON.stringify({
              id: "mock-1",
              model: "mock-model",
              choices: [
                {
                  index: 0,
                  message: {
                    role: "assistant",
                    content: null,
                    tool_calls: [
                      {
                        id: "call_1",
                        type: "function",
                        function: { name: "echo", arguments: '{"text":"hello"}' },
                      },
                    ],
                  },
                  finish_reason: "tool_calls",
                },
              ],
              usage: { prompt_tokens: 5, completion_tokens: 3 },
            })
          );
          return;
        }

        // tool 付きだが text を返す (text-only mode = tool 非対応だが 200) もしくは ping
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            id: "mock-1",
            model: "mock-model",
            choices: [
              {
                index: 0,
                message: { role: "assistant", content: "pong" },
                finish_reason: "stop",
              },
            ],
            usage: { prompt_tokens: 5, completion_tokens: 1 },
          })
        );
      });
    });
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as AddressInfo;
      resolve({
        baseUrl: `http://127.0.0.1:${port}/v1`,
        close: () => new Promise<void>((r) => server.close(() => r())),
      });
    });
  });
}

async function main() {
  // --- 1. tool 対応 endpoint → reachable + supportsTools ---
  console.log("[1] tool 対応 endpoint");
  {
    const srv = await startMockServer("tools-ok");
    const cap = await testModelCapabilities(localEntry(srv.baseUrl));
    await srv.close();
    check(cap.reachable === true, "reachable = true");
    check(cap.supportsTools === true, "supportsTools = true");
    check(!cap.lastError, "lastError なし");
  }

  // --- 2. tool 付きで 4xx を返す endpoint → reachable だが supportsTools=false ---
  console.log("[2] tool 非対応 (4xx) endpoint");
  {
    const srv = await startMockServer("tools-400");
    const cap = await testModelCapabilities(localEntry(srv.baseUrl));
    await srv.close();
    check(cap.reachable === true, "reachable = true (ping は成功)");
    check(cap.supportsTools === false, "supportsTools = false");
    check(!!cap.lastError, "lastError あり (tool 非対応の旨)");
  }

  // --- 3. tool 付きでも text を返す endpoint → supportsTools=false ---
  console.log("[3] tool を無視して text を返す endpoint");
  {
    const srv = await startMockServer("text-only");
    const cap = await testModelCapabilities(localEntry(srv.baseUrl));
    await srv.close();
    check(cap.reachable === true, "reachable = true");
    check(cap.supportsTools === false, "supportsTools = false (tool_use 応答なし)");
  }

  // --- 4. 到達不能 endpoint → reachable=false ---
  console.log("[4] 到達不能 endpoint");
  {
    // 使われていない閉じたポート (listen → 即 close で確実に空ける)
    const srv = await startMockServer("tools-ok");
    const dead = srv.baseUrl;
    await srv.close();
    const cap = await testModelCapabilities(localEntry(dead));
    check(cap.reachable === false, "reachable = false");
    check(cap.supportsTools === false, "supportsTools = false");
    check(!!cap.lastError, "lastError あり (接続失敗カテゴリ)");
  }

  // --- 4b. thinking ON でのみ tool を返すモデル → 再 probe で supportsTools=true ---
  console.log("[4b] thinking 必須モデルの再 probe (§8.8.3)");
  {
    const srv = await startMockServer("tools-need-thinking");
    const cap = await testModelCapabilities(localEntry(srv.baseUrl));
    await srv.close();
    check(cap.reachable === true, "reachable = true");
    check(cap.supportsTools === true, "supportsTools = true (thinking-on 再 probe で成立)");
    check(cap.toolUseRequiresThinking === true, "toolUseRequiresThinking = true");
    check(!cap.lastError, "lastError なし (クリーンな成功)");
  }

  // --- 5. provider 別 tool_choice の送信形 (アダプタ変換ロジック) ---
  // fetch をスタブして、各アダプタが正しい tool_choice / toolConfig を組むか body を検証。
  console.log("[5] provider 別 tool_choice 送信形");
  {
    const probeTool: Anthropic.Tool = {
      name: "echo",
      description: "echo",
      input_schema: { type: "object", properties: { text: { type: "string" } } },
    };
    const origFetch = globalThis.fetch;
    let captured: Record<string, unknown> = {};
    // 任意レスポンス本文を返す fake fetch (アダプタの out-going body をキャプチャ)
    function stubFetch(responseBody: unknown) {
      globalThis.fetch = (async (_url: string | URL, init?: { body?: string }) => {
        captured = JSON.parse(init?.body ?? "{}") as Record<string, unknown>;
        return {
          ok: true,
          status: 200,
          json: async () => responseBody,
          text: async () => JSON.stringify(responseBody),
        } as Response;
      }) as typeof fetch;
    }
    const oaiResp = {
      id: "x",
      model: "m",
      choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
      usage: {},
    };
    const gemResp = {
      candidates: [{ content: { role: "model", parts: [{ text: "ok" }] }, finishReason: "STOP" }],
      usageMetadata: {},
    };
    try {
      // OpenAI 互換: 特定 tool 強制
      stubFetch(oaiResp);
      await callOpenAICompat({
        apiKey: "k", baseUrl: "http://x/v1", model: "m", maxTokens: 16,
        tokenParamName: "max_tokens", messages: [{ role: "user", content: "hi" }],
        tools: [probeTool], toolChoice: { name: "echo" },
      });
      check(
        JSON.stringify(captured.tool_choice) ===
          JSON.stringify({ type: "function", function: { name: "echo" } }),
        "openai: tool_choice = {type:function, function:{name:echo}}"
      );

      // OpenAI 互換: auto
      stubFetch(oaiResp);
      await callOpenAICompat({
        apiKey: "k", baseUrl: "http://x/v1", model: "m", maxTokens: 16,
        tokenParamName: "max_tokens", messages: [{ role: "user", content: "hi" }],
        tools: [probeTool], toolChoice: "auto",
      });
      check(captured.tool_choice === "auto", "openai: tool_choice = 'auto'");

      // Gemini: 特定 tool 強制 → ANY + allowedFunctionNames
      stubFetch(gemResp);
      await callGemini({
        apiKey: "k", model: "m", maxTokens: 16,
        messages: [{ role: "user", content: "hi" }],
        tools: [probeTool], toolChoice: { name: "echo" },
      });
      check(
        JSON.stringify(captured.toolConfig) ===
          JSON.stringify({ functionCallingConfig: { mode: "ANY", allowedFunctionNames: ["echo"] } }),
        "gemini: toolConfig = ANY + allowedFunctionNames:[echo]"
      );

      // Gemini: auto → AUTO
      stubFetch(gemResp);
      await callGemini({
        apiKey: "k", model: "m", maxTokens: 16,
        messages: [{ role: "user", content: "hi" }],
        tools: [probeTool], toolChoice: "auto",
      });
      check(
        JSON.stringify(captured.toolConfig) ===
          JSON.stringify({ functionCallingConfig: { mode: "AUTO" } }),
        "gemini: toolConfig = AUTO"
      );
    } finally {
      globalThis.fetch = origFetch;
    }
  }

  // --- 6. tool_choice を渡しても tools 無しなら送らない (両アダプタ) ---
  console.log("[6] tools 無しなら tool_choice を送らない");
  {
    const origFetch = globalThis.fetch;
    let captured: Record<string, unknown> = {};
    // body に応じて openai/gemini どちらの形でも妥当なレスポンスを返す共通スタブ
    globalThis.fetch = (async (_url: string | URL, init?: { body?: string }) => {
      captured = JSON.parse(init?.body ?? "{}") as Record<string, unknown>;
      const isGemini = "contents" in captured;
      const body = isGemini
        ? { candidates: [{ content: { role: "model", parts: [{ text: "ok" }] }, finishReason: "STOP" }], usageMetadata: {} }
        : {
            id: "x", model: "m",
            choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
            usage: {},
          };
      return { ok: true, status: 200, json: async () => body, text: async () => "" } as Response;
    }) as typeof fetch;
    try {
      await callOpenAICompat({
        apiKey: "k", baseUrl: "http://x/v1", model: "m", maxTokens: 16,
        tokenParamName: "max_tokens", messages: [{ role: "user", content: "hi" }],
        toolChoice: { name: "echo" }, // tools 無し
      });
      check(captured.tool_choice === undefined, "openai: tools 無しなら tool_choice 無し");

      await callGemini({
        apiKey: "k", model: "m", maxTokens: 16,
        messages: [{ role: "user", content: "hi" }],
        toolChoice: { name: "echo" }, // tools 無し
      });
      check(captured.toolConfig === undefined, "gemini: tools 無しなら toolConfig 無し");
    } finally {
      globalThis.fetch = origFetch;
    }
  }

  // --- 7. temperature / enableThinking / reasoning_content (#206 M5 + §8.9) ---
  console.log("[7] temperature / enableThinking / reasoning_content");
  {
    const origFetch = globalThis.fetch;
    let captured: Record<string, unknown> = {};
    const stub = (responseBody: unknown) => {
      globalThis.fetch = (async (_url: string | URL, init?: { body?: string }) => {
        captured = JSON.parse(init?.body ?? "{}") as Record<string, unknown>;
        return { ok: true, status: 200, json: async () => responseBody, text: async () => "" } as Response;
      }) as typeof fetch;
    };
    const oai = (msg: Record<string, unknown>) => ({ id: "x", model: "m", choices: [{ index: 0, message: { role: "assistant", ...msg }, finish_reason: "stop" }], usage: {} });
    try {
      // openai: temperature が body に乗る
      stub(oai({ content: "ok" }));
      await callOpenAICompat({ apiKey: "k", baseUrl: "http://x/v1", model: "m", maxTokens: 16, tokenParamName: "max_tokens", messages: [{ role: "user", content: "hi" }], temperature: 0.2 });
      check(captured.temperature === 0.2, "openai: temperature が body に乗る");

      // openai: enableThinking=false → chat_template_kwargs:{enable_thinking:false}
      stub(oai({ content: "ok" }));
      await callOpenAICompat({ apiKey: "k", baseUrl: "http://x/v1", model: "m", maxTokens: 16, tokenParamName: "max_tokens", messages: [{ role: "user", content: "hi" }], enableThinking: false });
      check(JSON.stringify(captured.chat_template_kwargs) === JSON.stringify({ enable_thinking: false }), "openai: enableThinking=false → enable_thinking:false");

      // openai: enableThinking=true → chat_template_kwargs:{enable_thinking:true}
      stub(oai({ content: "ok" }));
      await callOpenAICompat({ apiKey: "k", baseUrl: "http://x/v1", model: "m", maxTokens: 16, tokenParamName: "max_tokens", messages: [{ role: "user", content: "hi" }], enableThinking: true });
      check(JSON.stringify(captured.chat_template_kwargs) === JSON.stringify({ enable_thinking: true }), "openai: enableThinking=true → enable_thinking:true");

      // openai: enableThinking undefined なら送らない
      stub(oai({ content: "ok" }));
      await callOpenAICompat({ apiKey: "k", baseUrl: "http://x/v1", model: "m", maxTokens: 16, tokenParamName: "max_tokens", messages: [{ role: "user", content: "hi" }] });
      check(captured.chat_template_kwargs === undefined, "openai: enableThinking 無しなら chat_template_kwargs 無し");

      // openai: content 空 + reasoning_content → 本文に**混ぜない** (思考漏れ防止、§8.9)
      stub(oai({ content: null, reasoning_content: "thought" }));
      const r = await callOpenAICompat({ apiKey: "k", baseUrl: "http://x/v1", model: "m", maxTokens: 16, tokenParamName: "max_tokens", messages: [{ role: "user", content: "hi" }] });
      check(!r.content.some((b) => b.type === "text" && b.text.includes("thought")), "openai: content 空でも reasoning_content を本文に混ぜない");

      // openai: content あり → content をそのまま使う
      stub(oai({ content: "answer", reasoning_content: "thought" }));
      const r2 = await callOpenAICompat({ apiKey: "k", baseUrl: "http://x/v1", model: "m", maxTokens: 16, tokenParamName: "max_tokens", messages: [{ role: "user", content: "hi" }] });
      check(r2.content.some((b) => b.type === "text" && b.text === "answer"), "openai: content があれば content を使う (reasoning は無視)");

      // gemini: temperature が generationConfig に乗る
      stub({ candidates: [{ content: { role: "model", parts: [{ text: "ok" }] }, finishReason: "STOP" }], usageMetadata: {} });
      await callGemini({ apiKey: "k", model: "m", maxTokens: 16, messages: [{ role: "user", content: "hi" }], temperature: 0.2 });
      check((captured.generationConfig as { temperature?: number })?.temperature === 0.2, "gemini: temperature が generationConfig に乗る");
    } finally {
      globalThis.fetch = origFetch;
    }
  }

  // --- summary ---
  console.log(`\n${passed} passed, ${failures.length} failed`);
  if (failures.length > 0) {
    for (const f of failures) console.log(`  FAIL: ${f}`);
    process.exit(1);
  }
}

main().then(
  () => process.exit(0),
  (e) => {
    console.error(e);
    process.exit(1);
  }
);
