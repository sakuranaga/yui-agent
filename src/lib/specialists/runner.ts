/**
 * Specialist の Claude tool-use ループを回す汎用 runner。
 *
 * - Yui から `ask_X_specialist({query: "..."})` で呼ばれる
 * - 内部で specialist の専用 system prompt + tools で Claude を回す
 * - tool use ループを最大 maxIterations 回 (default 5)
 * - 最終的な text 応答を文字列で返す (Yui に tool_result として渡す)
 */
import Anthropic from "@anthropic-ai/sdk";
import type { Specialist } from "./types";
import { buildTimeContextBlock } from "@/lib/time";
import { wrapDirective, buildInternalDirectiveGuard } from "@/lib/internal-directive";

import { callLlm } from "@/lib/llm";

export type SpecialistRunResult = {
  /** Yui に渡すテキスト */
  text: string;
  /** 統計 */
  stats: {
    llmCalls: number;
    toolCalls: number;
    totalInputTokens: number;
    totalOutputTokens: number;
    cacheReadTokens: number;
    cacheWriteTokens: number;
    durationMs: number;
    truncated: boolean;
  };
};

/**
 * specialist のループ runner。v3 ツール基盤統合: spec.tools の SpecialistTool[] 経路を
 * 廃止し、registry から caller={kind:"specialist", id: spec.id} の tool を取得して
 * runTool で dispatch する。これにより:
 *   - gmail_search 等の untrustedOutput がここでも有効
 *   - gcal_delete_event 等の confirmationPolicy がここでも発火
 *   - capability availability (gmail.readonly / calendar.events 等) が specialist 経路でも効く
 * 設計: docs/tool-architecture.md §4.5 / Phase 3d
 */
export async function runSpecialist(
  spec: Specialist,
  query: string,
  sessionId: string
): Promise<SpecialistRunResult> {
  const t0 = Date.now();
  const maxIter = spec.maxIterations ?? 5;
  const maxTokens = spec.maxTokens ?? 800;

  // registry 経由で specialist caller の tool 群を取得 (= 動的 availability 含む)
  const { toolsForContext, toAnthropicTools, runTool, buildSystemGuards } = await import(
    "@/lib/tools/runtime"
  );
  const availabilityCache = new Map<string, Promise<boolean>>();
  const caller = { kind: "specialist" as const, id: spec.id };
  const registryTools = await toolsForContext({
    mode: "normal",
    caller,
    sessionId,
    availabilityCache,
  });
  const tools: Anthropic.Tool[] = toAnthropicTools(registryTools);
  const toolByName = new Map(registryTools.map((t) => [t.name, t] as const));
  // metadata 駆動 guard (= untrustedOutput / confirmationPolicy の有無に応じて自動 inject)。
  // これで specialist 内部 LLM も <untrusted_*> ラップと confirm_required の挙動を system 指示
  // として受ける (= 設計書 §4.7 と同じ guard pipeline)。
  const metadataDrivenGuards = buildSystemGuards(registryTools);

  const messages: Anthropic.MessageParam[] = [
    { role: "user", content: query },
  ];

  let response: Anthropic.Message | null = null;
  let llmCalls = 0;
  let toolCalls = 0;
  let inTokens = 0;
  let outTokens = 0;
  let cacheR = 0;
  let cacheW = 0;
  let truncated = false;
  // 各 iter で出力された text を全部蓄積する。
  // 「Found 2: X and Y」を iter の途中で言って次の tool_use に行ってしまうと、
  // 最終 iter の text しか拾わない実装だと拾えなくなる (= 中間ファクト消失)。
  const accumulatedTexts: string[] = [];

  for (let iter = 0; iter < maxIter; iter++) {
    response = await callLlm("specialist", {
      // spec.model 未指定なら heavy tier に解決 (#206 M3)。env override 時のみ渡す。
      ...(spec.model ? { model: spec.model } : {}),
      maxTokens: maxTokens,
      system: [
        {
          type: "text",
          text: spec.systemPrompt,
          // specialist の system prompt は不変なのでキャッシュ対象
          cache_control: { type: "ephemeral" },
        },
        // 期限/今日付の判断に必須。キャッシュしない (動的)。
        { type: "text", text: buildTimeContextBlock() },
        // metadata 駆動 guard (= untrustedOutput / confirmationPolicy ある時のみ inject)
        ...metadataDrivenGuards,
        // <yui_directive> (= 予算切れ時の最終 summary 指示等、サーバ注入の内部ディレクティブ) の扱い
        { type: "text", text: buildInternalDirectiveGuard() },
      ],
      tools,
      messages,
    });
    llmCalls++;
    inTokens += response.usage.input_tokens;
    outTokens += response.usage.output_tokens;
    cacheR += response.usage.cache_read_input_tokens ?? 0;
    cacheW += response.usage.cache_creation_input_tokens ?? 0;

    // この iter の text を蓄積 (空文字なら追加しない)
    const iterText = response.content
      .filter((b): b is Anthropic.TextBlock => b.type === "text")
      .map((b) => b.text)
      .join("")
      .trim();
    if (iterText) accumulatedTexts.push(iterText);

    if (response.stop_reason !== "tool_use") break;

    // 最終反復で tool_use が来たら打ち切り扱い
    if (iter === maxIter - 1) {
      truncated = true;
      break;
    }

    messages.push({ role: "assistant", content: response.content });

    const toolUses = response.content.filter(
      (b): b is Anthropic.ToolUseBlock => b.type === "tool_use"
    );
    toolCalls += toolUses.length;

    const results: Anthropic.ToolResultBlockParam[] = await Promise.all(
      toolUses.map(async (tu) => {
        const tool = toolByName.get(tu.name);
        if (!tool) {
          return {
            type: "tool_result" as const,
            tool_use_id: tu.id,
            content: JSON.stringify({
              error: `unknown tool '${tu.name}' for specialist '${spec.id}'`,
            }),
            is_error: true,
          };
        }
        // runTool は untrustedOutput ラップ / confirmationPolicy ゲート /
        // 例外 → is_error tool_result まで全部面倒見る
        return await runTool(
          tool,
          { id: tu.id, input: tu.input },
          {
            sessionId,
            caller,
            mode: "normal",
            userUtterance: query,
            availabilityCache,
          }
        );
      })
    );

    messages.push({ role: "user", content: results });
  }

  // truncated (iter 上限で tool_use を強制中断) なら、
  // tool 無しで最後に 1 回呼んで「ここまでで分かった事実をまとめて」と
  // 強制的に最終 summary を出させる。これがないと preamble だけしか返らない事故が起きる。
  if (truncated && response) {
    // 中断時は最後の response (tool_use 含む) と空 tool_result を messages に積んで、
    // tool 無しで再呼び出し → 最終 text を作らせる
    messages.push({ role: "assistant", content: response.content });
    const toolUses = response.content.filter(
      (b): b is Anthropic.ToolUseBlock => b.type === "tool_use"
    );
    if (toolUses.length > 0) {
      const stubResults: Anthropic.ToolResultBlockParam[] = toolUses.map((tu) => ({
        type: "tool_result" as const,
        tool_use_id: tu.id,
        content: JSON.stringify({
          error: "tool budget exhausted, please summarize from previous results",
        }),
        is_error: true,
      }));
      messages.push({ role: "user", content: stubResults });
    }
    messages.push({
      role: "user",
      content: wrapDirective(
        "ツール呼び出しの予算を使い切りました。これ以上ツールは呼べません。これまでの tool_result から得られたファクトだけを使って、ユーザーの依頼に対する最終回答を簡潔にまとめてください (新しい情報の創作・推測は禁止)。"
      ),
    });
    try {
      const finalResp = await callLlm("specialist", {
        // spec.model 未指定なら heavy tier に解決 (#206 M3)。env override 時のみ渡す。
        ...(spec.model ? { model: spec.model } : {}),
        maxTokens: maxTokens,
        system: [
          {
            type: "text",
            text: spec.systemPrompt,
            cache_control: { type: "ephemeral" },
          },
          // 直前に push した <yui_directive> (予算切れ→最終 summary 指示) を正しく解釈させる
          { type: "text", text: buildInternalDirectiveGuard() },
        ],
        messages,
      });
      llmCalls++;
      inTokens += finalResp.usage.input_tokens;
      outTokens += finalResp.usage.output_tokens;
      cacheR += finalResp.usage.cache_read_input_tokens ?? 0;
      cacheW += finalResp.usage.cache_creation_input_tokens ?? 0;
      const finalText = finalResp.content
        .filter((b): b is Anthropic.TextBlock => b.type === "text")
        .map((b) => b.text)
        .join("")
        .trim();
      if (finalText) accumulatedTexts.push(finalText);
    } catch (e) {
      console.warn(`[runner ${spec.id}] forced summary failed:`, e);
    }
  }

  // 蓄積した text を改行 2 つで連結。最終段が一番情報量多いはずだが、
  // 中間の「Found X」も残しておくことで report agent が事実を拾える。
  const text = accumulatedTexts.join("\n\n");

  return {
    text: text || "(specialist returned empty result)",
    stats: {
      llmCalls,
      toolCalls,
      totalInputTokens: inTokens,
      totalOutputTokens: outTokens,
      cacheReadTokens: cacheR,
      cacheWriteTokens: cacheW,
      durationMs: Date.now() - t0,
      truncated,
    },
  };
}
