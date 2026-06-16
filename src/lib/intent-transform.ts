/**
 * Intent transform: source アーティファクトを別 target ツールの draft に
 * Gemma 経由で構造化変換する。
 *
 * 利用先: POST /api/intent (cross-tool dispatch)。
 *
 * 入出力:
 *   - source: ArtifactPayload (mail / event / todo / contact / diary)
 *   - target: "todo" | "event" | "contact" | "memo"
 *   - 戻り: { draft: <target schema>, raw?, warning? }
 *
 * 設計: docs/roadmap.md §6.9 (intent endpoint)
 */
import type Anthropic from "@anthropic-ai/sdk";
import { callLlm } from "@/lib/llm";
import {
  formatArtifactForLlm,
  type ArtifactPayload,
} from "@/lib/artifact-payloads";

// ──── Target draft 型 (固定) ────

export type TodoDraft = {
  title: string;
  note?: string;
  dueAt?: string; // ISO8601
  tags?: string[];
};

export type EventDraft = {
  summary: string;
  description?: string;
  startIso: string;
  endIso?: string;
  location?: string;
};

export type ContactDraft = {
  name: string;
  role?: string;
  organization?: string;
  emails?: string[];
  phones?: string[];
  notes?: string;
};

export type MemoDraft = {
  title: string;
  body?: string;
  tags?: string[];
};

export type TargetTool = "todo" | "event" | "contact" | "memo";

export type AnyDraft = TodoDraft | EventDraft | ContactDraft | MemoDraft;

// ──── Gemma に渡す target schema 定義 (自然文で見せる) ────

const TARGET_SCHEMA: Record<TargetTool, string> = {
  todo: `{
  "title": string (必須、40 字以内、内容を端的に。送信者名や経緯を入れすぎず行動の名前にする),
  "note": string?,        // 詳細 / 文脈 / 関連情報 (元 source の重要部分を 200 字程度で要約、改行 OK)
  "dueAt": string?,       // ISO8601。source から期日が明確に読み取れた場合のみ。曖昧な「来週」等は除外。
  "tags": string[]?       // 1-3 個、簡潔な分類タグ
}`,
  event: `{
  "summary": string (必須、予定タイトル),
  "description": string?,
  "startIso": string (必須、ISO8601 開始日時),
  "endIso": string?,      // 終了日時。不明なら 1 時間後を補完
  "location": string?
}`,
  contact: `{
  "name": string (必須、人名),
  "role": string?,
  "organization": string?,
  "emails": string[]?,
  "phones": string[]?,
  "notes": string?         // 出会いの経緯や関係性のメモ
}`,
  memo: `{
  "title": string (必須),
  "body": string?,
  "tags": string[]?
}`,
};

const TARGET_LABEL: Record<TargetTool, string> = {
  todo: "TODO (やること)",
  event: "予定 (カレンダー)",
  contact: "連絡先 (人)",
  memo: "メモ",
};

function buildSystemPrompt(): string {
  // 今日の日付を JST で injection。Gemma は学習時点の知識で「現在年」を推測しがち
  // (例: 2024 と書いてくる) なので明示。
  const todayJst = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Tokyo",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date()); // YYYY-MM-DD
  return `あなたは情報変換アシスタントです。
ご主人様が「source アーティファクト」(メール / 予定 / TODO / 連絡先 / 日記等)
を別ツール (target) に転送した時、その target の作成フォームに即 pre-fill
できる draft を JSON で返してください。

## 現在の日付 (JST)
${todayJst}
※ source 中に「6/10」のような年なし日付があった場合、この基準日から見て
未来になるよう年を推測する。基準より過去の年は使わない。

判定方針:
- source の核心 (誰が / 何を / いつまでに) を端的に抽出
- 装飾語や敬語を削ぎ落として行動 / 事実だけを残す
- 期日は source に明示された日付があるときだけ載せる。曖昧な「近いうち」等は省略
- 値が抽出できない optional フィールドは省略 (null や空文字を入れない)
- 余計な説明文や前置きは禁止。JSON のみ、コードフェンスも不要`;
}

const MAX_SOURCE_CHARS = 4000;

// ──── prompt 構築 ────

function truncatePayload(payload: ArtifactPayload): ArtifactPayload {
  // 本文系フィールドが極端に長いケースに対処 (mail / diary)
  if (payload.type === "mail" && payload.data.bodySnippet) {
    if (payload.data.bodySnippet.length > MAX_SOURCE_CHARS) {
      return {
        type: "mail",
        data: {
          ...payload.data,
          bodySnippet:
            payload.data.bodySnippet.slice(0, MAX_SOURCE_CHARS) +
            "\n…(以下省略)",
        },
      };
    }
  }
  if (payload.type === "diary" && payload.data.body) {
    if (payload.data.body.length > MAX_SOURCE_CHARS) {
      return {
        type: "diary",
        data: {
          ...payload.data,
          body:
            payload.data.body.slice(0, MAX_SOURCE_CHARS) + "\n…(以下省略)",
        },
      };
    }
  }
  return payload;
}

function buildUserMessage(payload: ArtifactPayload, target: TargetTool): string {
  const sourceText = formatArtifactForLlm(payload);
  return `## Source (転送元)
${sourceText}

## Target (転送先)
${TARGET_LABEL[target]}

## 出力 schema (この形の JSON のみ返す)
${TARGET_SCHEMA[target]}`;
}

// ──── 出力 parse ────

function extractTextBlocks(msg: Anthropic.Message): string {
  return msg.content
    .filter(
      (b): b is { type: "text"; text: string; citations: null } =>
        b.type === "text"
    )
    .map((b) => b.text)
    .join("");
}

function tryParseJson(text: string): Record<string, unknown> | null {
  const trimmed = text.trim();
  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  if (start < 0 || end < 0 || end <= start) return null;
  try {
    return JSON.parse(trimmed.slice(start, end + 1)) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function asString(v: unknown): string | undefined {
  return typeof v === "string" && v.trim().length > 0 ? v.trim() : undefined;
}
function asStringArray(v: unknown): string[] | undefined {
  if (!Array.isArray(v)) return undefined;
  const out = v.filter((x): x is string => typeof x === "string" && x.length > 0);
  return out.length > 0 ? out : undefined;
}

function validateDraft(target: TargetTool, raw: Record<string, unknown>): AnyDraft | null {
  switch (target) {
    case "todo": {
      const title = asString(raw.title);
      if (!title) return null;
      const draft: TodoDraft = { title };
      const note = asString(raw.note);
      if (note) draft.note = note;
      const dueAt = asString(raw.dueAt);
      if (dueAt) draft.dueAt = dueAt;
      const tags = asStringArray(raw.tags);
      if (tags) draft.tags = tags.slice(0, 5);
      return draft;
    }
    case "event": {
      const summary = asString(raw.summary);
      const startIso = asString(raw.startIso);
      if (!summary || !startIso) return null;
      const draft: EventDraft = { summary, startIso };
      const description = asString(raw.description);
      if (description) draft.description = description;
      const endIso = asString(raw.endIso);
      if (endIso) draft.endIso = endIso;
      const location = asString(raw.location);
      if (location) draft.location = location;
      return draft;
    }
    case "contact": {
      const name = asString(raw.name);
      if (!name) return null;
      const draft: ContactDraft = { name };
      const role = asString(raw.role);
      if (role) draft.role = role;
      const organization = asString(raw.organization);
      if (organization) draft.organization = organization;
      const emails = asStringArray(raw.emails);
      if (emails) draft.emails = emails;
      const phones = asStringArray(raw.phones);
      if (phones) draft.phones = phones;
      const notes = asString(raw.notes);
      if (notes) draft.notes = notes;
      return draft;
    }
    case "memo": {
      const title = asString(raw.title);
      if (!title) return null;
      const draft: MemoDraft = { title };
      const body = asString(raw.body);
      if (body) draft.body = body;
      const tags = asStringArray(raw.tags);
      if (tags) draft.tags = tags.slice(0, 5);
      return draft;
    }
  }
}

// ──── main ────

export async function transformIntent(
  source: ArtifactPayload,
  target: TargetTool
): Promise<{ draft: AnyDraft | null; raw?: string; warning?: string }> {
  const payload = truncatePayload(source);
  const userMsg = buildUserMessage(payload, target);

  const system = buildSystemPrompt();
  const tryOnce = async (): Promise<{ text: string; parsed: AnyDraft | null }> => {
    const response = await callLlm("intent", {
      system,
      messages: [{ role: "user", content: userMsg }],
      maxTokens: 500,
      temperature: 0.2,
    });
    const text = extractTextBlocks(response);
    const raw = tryParseJson(text);
    const parsed = raw ? validateDraft(target, raw) : null;
    return { text, parsed };
  };

  try {
    let { text, parsed } = await tryOnce();
    if (!parsed) {
      // 1 回だけリトライ
      console.warn(
        `[intent] first attempt invalid for ${source.type}→${target}, retrying`
      );
      const r2 = await tryOnce();
      text = r2.text;
      parsed = r2.parsed;
    }
    if (!parsed) {
      return { draft: null, raw: text, warning: "invalid_json_after_retry" };
    }
    return { draft: parsed, raw: text };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.warn("[intent] LLM call failed:", msg);
    return { draft: null, warning: `llm_error: ${msg}` };
  }
}
