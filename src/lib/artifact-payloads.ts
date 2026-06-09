/**
 * アーティファクト (mail / event / todo / contact / diary / 将来 memo) を
 * polymorphic に表現する共通型 + LLM プロンプト用の自然文フォーマッタ。
 *
 * 利用先:
 *   - POST /api/project-links/suggest (project 紐付け候補を Gemma に判定させる)
 *   - POST /api/intent (将来、cross-tool dispatch を Gemma に変換させる)
 *
 * ## 新しい artifact_type を増やす手順
 *   1. ArtifactPayload union に { type: "新名", data: 新Data } を追加
 *   2. 新Data 用の formatXxx() 関数を追加
 *   3. formatArtifactForLlm() の switch に 1 行追加
 *   4. それだけ。両 endpoint が自動的に対応する。
 *
 * 設計: docs/roadmap.md §6.8 (project-links Phase 1)
 */

/**
 * メール (Gmail messages 由来)
 *   bodySnippet は LLM トークン節約のため caller が事前に truncate して渡す前提。
 */
export type MailArtifactData = {
  subject: string;
  from?: { name?: string; address: string };
  to?: Array<{ name?: string; address: string }>;
  bodySnippet?: string;
  receivedAt?: string; // ISO
};

/** Google Calendar イベント */
export type EventArtifactData = {
  summary: string;
  description?: string;
  startIso?: string;
  endIso?: string;
  location?: string;
  attendees?: string[];
};

/** TODO (主に他ツール → TODO 変換 source として、または既存 TODO → 別ツール) */
export type TodoArtifactData = {
  title: string;
  note?: string;
  dueAt?: string; // ISO
  tags?: string[];
  projectName?: string; // 既知 project (intent 経由の引継ぎ用)
};

/** 連絡先 */
export type ContactArtifactData = {
  name: string;
  role?: string;
  organization?: string;
  emails?: string[];
  phones?: string[];
  notes?: string;
};

/** 結衣の日記 */
export type DiaryArtifactData = {
  date: string; // YYYY-MM-DD
  body: string;
};

/** Polymorphic envelope */
export type ArtifactPayload =
  | { type: "mail";    data: MailArtifactData }
  | { type: "event";   data: EventArtifactData }
  | { type: "todo";    data: TodoArtifactData }
  | { type: "contact"; data: ContactArtifactData }
  | { type: "diary";   data: DiaryArtifactData };

export type ArtifactType = ArtifactPayload["type"];

// ───── フォーマッタ ─────

function formatMail(d: MailArtifactData): string {
  const lines: string[] = ["## メール"];
  lines.push(`- 件名: ${d.subject}`);
  if (d.from)
    lines.push(`- 差出人: ${d.from.name ? `${d.from.name} (${d.from.address})` : d.from.address}`);
  if (d.to && d.to.length > 0)
    lines.push(
      `- 宛先: ${d.to.map((t) => (t.name ? `${t.name} (${t.address})` : t.address)).join(", ")}`
    );
  if (d.receivedAt) lines.push(`- 受信日時: ${d.receivedAt}`);
  if (d.bodySnippet) lines.push(`- 本文:\n${d.bodySnippet}`);
  return lines.join("\n");
}

function formatEvent(d: EventArtifactData): string {
  const lines: string[] = ["## 予定"];
  lines.push(`- タイトル: ${d.summary}`);
  if (d.startIso) lines.push(`- 開始: ${d.startIso}`);
  if (d.endIso) lines.push(`- 終了: ${d.endIso}`);
  if (d.location) lines.push(`- 場所: ${d.location}`);
  if (d.attendees && d.attendees.length > 0) lines.push(`- 参加者: ${d.attendees.join(", ")}`);
  if (d.description) lines.push(`- 詳細:\n${d.description}`);
  return lines.join("\n");
}

function formatTodo(d: TodoArtifactData): string {
  const lines: string[] = ["## TODO"];
  lines.push(`- タイトル: ${d.title}`);
  if (d.projectName) lines.push(`- 既知 project: ${d.projectName}`);
  if (d.dueAt) lines.push(`- 期限: ${d.dueAt}`);
  if (d.tags && d.tags.length > 0) lines.push(`- タグ: ${d.tags.join(", ")}`);
  if (d.note) lines.push(`- メモ:\n${d.note}`);
  return lines.join("\n");
}

function formatContact(d: ContactArtifactData): string {
  const lines: string[] = ["## 連絡先"];
  lines.push(`- 名前: ${d.name}`);
  if (d.organization) lines.push(`- 会社: ${d.organization}`);
  if (d.role) lines.push(`- 役職: ${d.role}`);
  if (d.emails && d.emails.length > 0) lines.push(`- メール: ${d.emails.join(", ")}`);
  if (d.phones && d.phones.length > 0) lines.push(`- 電話: ${d.phones.join(", ")}`);
  if (d.notes) lines.push(`- メモ:\n${d.notes}`);
  return lines.join("\n");
}

function formatDiary(d: DiaryArtifactData): string {
  return `## 結衣の日記 (${d.date})\n${d.body}`;
}

/**
 * artifact を LLM (Gemma) 用の自然文セクションに整形。
 * トークン量は caller 側で本文 truncate して制御する想定。
 */
export function formatArtifactForLlm(p: ArtifactPayload): string {
  switch (p.type) {
    case "mail":
      return formatMail(p.data);
    case "event":
      return formatEvent(p.data);
    case "todo":
      return formatTodo(p.data);
    case "contact":
      return formatContact(p.data);
    case "diary":
      return formatDiary(p.data);
  }
}
