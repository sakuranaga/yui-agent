/**
 * Specialist (Yui の「部下」) の型定義。
 *
 * 各 specialist は単一ファイルで完結:
 *   - Yui から見たときの "ask_X_specialist" wrapper の宣言
 *   - 内部で使う tools (Yui には見せない)
 *   - 専用 system prompt と model
 *
 * 詳細は docs/memory-architecture.md §14 参照。
 */
import type Anthropic from "@anthropic-ai/sdk";
import type { SpecialistId } from "@/lib/tools/types";

/**
 * specialist が内部で使う tool。
 * Anthropic Tool 型 + handler を1つの object に統合した形式。
 * (v3 ツール基盤統合後は registry の ToolDef が一次データ。SpecialistTool は specialist
 *  ファイル内の宣言を維持するだけで、runner からは直接参照されない。)
 */
export type SpecialistTool = {
  name: string;
  description: string;
  input_schema: Anthropic.Tool.InputSchema;
  handler: (input: Record<string, unknown>) => Promise<unknown>;
};

export type Specialist = {
  /** registry key (= ToolCaller.id にも使う SpecialistId) */
  id: SpecialistId;
  /** Yui から呼ばれる tool 名。慣例 "ask_<id>_specialist" */
  yuiToolName: string;
  /** Yui への wrapper 説明: いつこの specialist に委譲すべきか */
  yuiDescription: string;
  /** specialist 内部で使う Claude model */
  model: string;
  /** specialist の system prompt */
  systemPrompt: string;
  /** specialist が内部で使う tools (Yui には見せない) */
  tools: SpecialistTool[];
  /** 内部 tool use ループの最大反復数 */
  maxIterations?: number;
  /** specialist の応答最大トークン */
  maxTokens?: number;
};

/**
 * Yui から specialist を呼ぶときの入力スキーマ (全 specialist 共通)。
 * "query" 1フィールド: 日本語の自由形式の問い。
 */
export const YUI_DELEGATION_SCHEMA: Anthropic.Tool.InputSchema = {
  type: "object" as const,
  properties: {
    query: {
      type: "string" as const,
      description:
        "specialist に伝える日本語の問い (例: 'GoENの未完了タスクで急ぎ3件')。" +
        "specialist は専用ツールを使って一次情報を取得し、簡潔な要約を返します。",
    },
  },
  required: ["query"],
  additionalProperties: false,
};
