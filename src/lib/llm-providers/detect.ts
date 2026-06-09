/**
 * Model ID から provider を推定する。
 *
 * 各 provider の `/v1/models` には共通の prefix があるので、安全に prefix match で
 * 判定できる。一致しない ID は安全側に "anthropic" 扱い (既存挙動互換)。
 *
 * - "claude-*"           → anthropic
 * - "gpt-*"/"o1*"/"o3*"/
 *   "o4*"/"chatgpt-*"    → openai
 * - "gemini-*"           → gemini
 * - "grok-*"             → grok
 */
import type { ProviderId } from "@/lib/llm-models";

export function detectProvider(modelId: string): ProviderId {
  const id = modelId.toLowerCase();
  if (id.startsWith("claude-")) return "anthropic";
  if (
    id.startsWith("gpt-") ||
    id.startsWith("o1") ||
    id.startsWith("o3") ||
    id.startsWith("o4") ||
    id.startsWith("chatgpt-")
  ) {
    return "openai";
  }
  if (id.startsWith("gemini-")) return "gemini";
  if (id.startsWith("grok-")) return "grok";
  // Fallback: Anthropic (legacy 命名 / 不明 model は既存ルートで失敗させる)
  return "anthropic";
}
