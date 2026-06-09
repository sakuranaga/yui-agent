/**
 * Gemma 経由でアーティファクトの project 紐付け候補を判定する。
 *
 * 入力: ArtifactPayload (polymorphic)
 * 出力: Array<{ projectId, confidence (0-1), reason }>
 *
 * しきい値の運用 (server は raw confidence を返す。判断は client 側):
 *   - confidence > 0.8 → 「強く推奨」(auto-attach 候補)
 *   - 0.5 - 0.8       → 「候補」(UI で chip 提案、user click で attach)
 *   - < 0.5           → 通常含めない (Gemma 側プロンプトで除外指示)
 *
 * 設計: docs/roadmap.md §6.8 (project-links Phase 1)
 */
import type Anthropic from "@anthropic-ai/sdk";
import { db } from "@/db/client";
import { projects } from "@/db/schema";
import { eq, asc } from "drizzle-orm";
import { callLocalLlm } from "@/lib/local-llm";
import {
  formatArtifactForLlm,
  type ArtifactPayload,
} from "@/lib/artifact-payloads";

export type ProjectSuggestion = {
  projectId: number;
  confidence: number;
  reason: string;
};

const SYSTEM = `あなたはプロジェクト紐付け判定アシスタントです。
与えられたアーティファクト (メール / 予定 / TODO / 連絡先 / 日記) を読んで、
適切な project に紐付ける候補を JSON で返してください。

判定方針:
- アーティファクトの内容 (件名・本文・関係者・タイトル等) を読み取る
- 候補プロジェクトの名前と説明を見て、関連が強いものを選ぶ
- 関連が薄ければ無理に紐付けない。該当無しなら空配列で返す
- 複数 project に該当する場合は全部列挙する (M:N なので)
- confidence は厳しめに付ける (0.8 以上 = 名前/組織が一致レベルの確信)

出力は以下の JSON のみ、説明文・前置き・コードフェンスは一切不要:
{
  "suggestions": [
    { "projectId": <number>, "confidence": <0.0-1.0>, "reason": "<簡潔な日本語>" }
  ]
}`;

function buildUserMessage(
  payload: ArtifactPayload,
  projectCatalog: Array<{ id: number; name: string; description: string | null }>
): string {
  const cat = projectCatalog
    .map(
      (p) =>
        `- [${p.id}] ${p.name}${p.description ? ` — ${p.description.slice(0, 120)}` : ""}`
    )
    .join("\n");
  const artifact = formatArtifactForLlm(payload);
  return `## 候補プロジェクト\n${cat}\n\n${artifact}\n\n上記アーティファクトを上記候補のどれに紐付けるか、JSON で返してください。`;
}

// ───── 出力 parse ─────

function extractTextBlocks(msg: Anthropic.Message): string {
  return msg.content
    .filter((b): b is { type: "text"; text: string; citations: null } =>
      b.type === "text"
    )
    .map((b) => b.text)
    .join("");
}

function tryParseJson(text: string): { suggestions?: unknown } | null {
  // JSON だけ返してくれない LLM のために、{...} 部分を抜き出す
  const trimmed = text.trim();
  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  if (start < 0 || end < 0 || end <= start) return null;
  const candidate = trimmed.slice(start, end + 1);
  try {
    return JSON.parse(candidate);
  } catch {
    return null;
  }
}

function validateSuggestions(
  raw: unknown,
  knownProjectIds: Set<number>
): ProjectSuggestion[] {
  if (!Array.isArray(raw)) return [];
  const out: ProjectSuggestion[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const o = item as Record<string, unknown>;
    const pid = typeof o.projectId === "number" ? o.projectId : NaN;
    const conf = typeof o.confidence === "number" ? o.confidence : NaN;
    const reason = typeof o.reason === "string" ? o.reason : "";
    if (!Number.isFinite(pid) || !knownProjectIds.has(pid)) continue;
    if (!Number.isFinite(conf) || conf < 0 || conf > 1) continue;
    out.push({ projectId: pid, confidence: conf, reason });
  }
  return out;
}

export async function suggestProjects(
  payload: ArtifactPayload
): Promise<{ suggestions: ProjectSuggestion[]; raw?: string; warning?: string }> {
  // active な (archived=false) project のみ候補に
  const catalog = await db
    .select({
      id: projects.id,
      name: projects.name,
      description: projects.description,
    })
    .from(projects)
    .where(eq(projects.archived, false))
    .orderBy(asc(projects.sortOrder), asc(projects.name));

  if (catalog.length === 0) {
    return { suggestions: [], warning: "no active projects" };
  }

  const knownIds = new Set(catalog.map((p) => Number(p.id)));
  const userMsg = buildUserMessage(
    payload,
    catalog.map((p) => ({ id: Number(p.id), name: p.name, description: p.description }))
  );

  let response: Anthropic.Message;
  try {
    response = await callLocalLlm({
      system: SYSTEM,
      messages: [{ role: "user", content: userMsg }],
      maxTokens: 400,
      temperature: 0.2,
      roleLabel: "project_suggest",
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.warn("[project-suggest] LLM call failed:", msg);
    return { suggestions: [], warning: `llm_error: ${msg}` };
  }

  const text = extractTextBlocks(response);
  const parsed = tryParseJson(text);
  if (!parsed) {
    return { suggestions: [], raw: text, warning: "invalid_json" };
  }
  const suggestions = validateSuggestions(parsed.suggestions, knownIds);
  return { suggestions, raw: text };
}
