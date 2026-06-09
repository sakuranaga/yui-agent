/**
 * mail_messages の bucket 判定 (RAG few-shot + 本文込み)。
 *
 * 設計: docs/mail-classification.md
 *
 * Phase 1 改修要旨:
 *  - 旧 batch single-shot (header + snippet → score 0..1) を捨て、
 *    per-mail で「本文 head 取得 → embed → 学習 DB top-K=5 RAG → Gemma → bucket」
 *  - bucket = important / needed / unneeded、conf 0..1、reason は短文
 *  - 旧 score / score_reason / curated_at も書き続ける (legacy UI 互換、Phase 3 で drop)
 *      bucket → score: important=0.9 / needed=0.5 / unneeded=0.1
 *  - 自動アクション (ゴミ箱 / intent 起票) はここでは行わない (Phase 3 で追加)
 *
 * VIP / blocked / 住所録は LLM skip して即決:
 *   VIP / 住所録 → bucket=important, conf=1.0, score=1.0
 *   blocked      → bucket=unneeded,  conf=1.0, score=0.0
 *
 * 常にローカル LLM を使う (メール本文を外部に送らない方針)。
 * ローカル LLM 無効時は skip + warn。
 */
import type Anthropic from "@anthropic-ai/sdk";
import { db } from "@/db/client";
import { mailMessages, contacts, mailTrainingExamples, gmailAccounts } from "@/db/schema";
import { eq, inArray, isNull, sql } from "drizzle-orm";
import { callLlm } from "@/lib/llm";
import { getMailCurationSettings } from "@/lib/mail-curation-settings";
import { embed } from "@/lib/embed";
import { fetchBodiesForMessages } from "@/lib/mail-body";
import { maybeAutoAct } from "@/lib/mail-auto-action";
import { mapPool } from "@/lib/async-pool";

export type Bucket = "important" | "needed" | "unneeded";

type Verdict = {
  bucket: Bucket;
  confidence: number;  // 分類の確度 (この bucket であることに対する確信度)
  score: number;       // バケット内の重要度 (連続値、ソート / 自動アクション閾値に使用)
  reason: string;
  /** 自動アクションゲートに使う top-1 学習例情報。学習ヒット無しなら null。 */
  topMatch: { sim: number; autoTodo: boolean; autoEvent: boolean } | null;
};

/** Gemma が score を出さなかった (パース失敗時等) フォールバック用 */
const BUCKET_FALLBACK_SCORE: Record<Bucket, number> = {
  important: 0.85,
  needed: 0.5,
  unneeded: 0.15,
};

/** 学習ヒットの cosine 類似度閾値 */
const HIT_THRESHOLD = 0.60;
/** RAG top-K */
const TOP_K = 5;
/** embed / プロンプトに乗せる本文範囲。
 *  bge-m3 サーバの batch size (512 tokens) に収まる必要があるため控えめに。
 *  日本語は char/token 比 ~1.0-1.5 なので、header (~200 chars) + body 600 chars
 *  = 全体 ~800 chars ≈ 400-800 tokens 程度の幅で、worst case でも 512 に収まる目安。
 *  判別に必要な情報 (フォームの field 列挙、自由文の有無、署名等) は本文先頭に集中するので 600 で十分。 */
const BODY_HEAD_CHARS = 600;

const SYSTEM_PROMPT = `あなたはご主人様のメール仕分け係です。受け取ったメールを以下の 3 つに分類し、さらにバケット内での重要度も付けてください:

- important: 重要 (人間からの直接連絡、緊急、契約 / 請求、顧客先からの実質返信など、ご主人様の手が動く必要があるもの)
- needed:    要 (お知らせ、配送 / 入金通知、興味分野の通知など、捨てるほどではないが優先度は中程度)
- unneeded:  不要 (広告、フォーム自動返信、ニュースレター、未読のままで困らないもの)

参考に「過去にご主人様が手動で同じ判定をした類似メールの例」が与えられる場合があります。例の判定理由をよく読み、それに沿って今回も判定してください。例が無い場合は、上記の基本基準で判定してください。

3 つの数値を区別すること:
- confidence: この bucket であることの確信度 (0..1)。例が手元にあって特徴がよく一致するなら高い、迷う場合は低い。
- score: バケット内での重要度 (0..1)。同じ「重要」でも顧客先からの即返信が必要なものは 0.95、定期請求書なら 0.7 等、相対的に強弱を付ける。同じ「不要」でも明らかな広告は 0.05、判別ギリギリのものは 0.25 等。

出力は JSON 1 行のみ、説明文 / 装飾 / コードフェンス不要:
{"bucket": "important|needed|unneeded", "confidence": 0.0〜1.0, "score": 0.0〜1.0, "reason": "短い根拠 (50字以内)"}`;

export async function curateMails(messageIds: number[]): Promise<void> {
  if (messageIds.length === 0) return;

  // 判定 LLM の振り分けは callLlm("mail_curate") に委譲。
  // ローカル LLM 設定の「メール仕分け」チェックが ON ならローカル (Gemma 等)、
  // OFF ならサブモデル (Anthropic Haiku 等) が使われる。設定で明示的に切替可。
  const settings = await getMailCurationSettings();
  const now = new Date();

  const rows = await db
    .select({
      id: mailMessages.id,
      fromEmail: mailMessages.fromEmail,
      fromName: mailMessages.fromName,
      toAddresses: mailMessages.toAddresses,
      accountEmail: gmailAccounts.email,
      subject: mailMessages.subject,
      snippet: mailMessages.snippet,
      bodyText: mailMessages.bodyText,
      bodyFetchedAt: mailMessages.bodyFetchedAt,
      receivedAt: mailMessages.receivedAt,
    })
    .from(mailMessages)
    .innerJoin(gmailAccounts, eq(mailMessages.accountId, gmailAccounts.id))
    .where(inArray(mailMessages.id, messageIds));

  if (rows.length === 0) return;

  // VIP / blocked 即決
  const contactEmails = await loadContactEmails();
  const vipSet = new Set<string>([
    ...settings.vipAddresses.map((e) => e.toLowerCase()),
    ...contactEmails,
  ]);
  const blockedSet = new Set(settings.blockedAddresses.map((e) => e.toLowerCase()));

  type Pending = (typeof rows)[0];
  const pendingForLlm: Pending[] = [];
  const needBodyFetch: number[] = [];
  let vipCount = 0;
  let blockedCount = 0;

  for (const r of rows) {
    if (vipSet.has(r.fromEmail)) {
      const reason = settings.vipAddresses.includes(r.fromEmail) ? "VIP" : "住所録";
      // VIP は分類確度・重要度ともに max
      await writeBucket(r.id, "important", 1.0, 1.0, reason, now);
      vipCount++;
    } else if (blockedSet.has(r.fromEmail)) {
      // ブロックは確度 max、重要度 min
      await writeBucket(r.id, "unneeded", 1.0, 0.0, "ブロック", now);
      blockedCount++;
    } else {
      pendingForLlm.push(r);
      if (!r.bodyFetchedAt) needBodyFetch.push(r.id);
    }
  }

  console.log(
    `[mail-curate] target=${rows.length} vip=${vipCount} blocked=${blockedCount} to_llm=${pendingForLlm.length} need_body=${needBodyFetch.length}`
  );

  // 本文未取得のものを先に補充 (Gmail API 並列度 3)
  if (needBodyFetch.length > 0) {
    try {
      await fetchBodiesForMessages(needBodyFetch);
      // body を再 select して pendingForLlm に反映
      const updated = await db
        .select({ id: mailMessages.id, bodyText: mailMessages.bodyText })
        .from(mailMessages)
        .where(inArray(mailMessages.id, needBodyFetch));
      const byId = new Map(updated.map((u) => [u.id, u.bodyText]));
      for (const p of pendingForLlm) {
        if (!p.bodyText) p.bodyText = byId.get(p.id) ?? null;
      }
    } catch (e) {
      console.warn("[mail-curate] body fetch failed (continuing with header only):", e);
    }
  }

  // classifyOne は LLM 呼び出しを含むので、20 件直列だと user 待ち時間が大きい。
  // 並列度 3 のプールにし、各 mail について classify → writeBucket → maybeAutoAct を
  // 1 つの worker 内で順序保証 (= writeBucket 前に autoAct が走らない)。
  // mail id 単位で disjoint なので並列化に副作用無し。
  let scored = 0;
  await mapPool(pendingForLlm, 3, async (r) => {
    try {
      const v = await classifyOne(r, settings.interestProfile);
      await writeBucket(r.id, v.bucket, v.confidence, v.score, v.reason, now);
      scored++;
      // Phase 3: 学習ヒット + 高確度の時のみ自動アクション。topMatch=null や
      //   confidence<0.85 では何もしない (受信箱にバッジ付きで残す)。
      await maybeAutoAct({
        mailId: r.id,
        bucket: v.bucket,
        bucketConfidence: v.confidence,
        bucketScore: v.score,
        topMatch: v.topMatch,
        mail: {
          subject: r.subject,
          fromName: r.fromName,
          fromEmail: r.fromEmail,
          toAddresses: r.toAddresses,
          bodyText: r.bodyText,
          snippet: r.snippet,
          receivedAt: r.receivedAt,
        },
      });
    } catch (e) {
      console.warn(`[mail-curate] classify failed (id=${r.id}):`, e instanceof Error ? e.message : e);
    }
  });

  console.log(`[mail-curate] llm-classified ${scored}/${pendingForLlm.length}`);
}

/** mail 1 件分の bucket 判定 */
async function classifyOne(
  mail: {
    id: number;
    fromEmail: string;
    fromName: string | null;
    toAddresses: string[] | null;
    accountEmail: string;
    subject: string | null;
    snippet: string | null;
    bodyText: string | null;
  },
  interestProfile: string
): Promise<Verdict> {
  const embeddedText = buildEmbeddedText(mail);
  const queryEmbedding = await embed(embeddedText);

  const topK = await db
    .select({
      bucket: mailTrainingExamples.bucket,
      hintText: mailTrainingExamples.hintText,
      embeddedText: mailTrainingExamples.embeddedText,
      autoTodo: mailTrainingExamples.autoTodo,
      autoEvent: mailTrainingExamples.autoEvent,
      sim: sql<number>`1 - (${mailTrainingExamples.embedding} <=> ${toVector(queryEmbedding)}::vector)`,
    })
    .from(mailTrainingExamples)
    .orderBy(sql`${mailTrainingExamples.embedding} <=> ${toVector(queryEmbedding)}::vector`)
    .limit(TOP_K);

  const hit = topK.length > 0 && topK[0].sim >= HIT_THRESHOLD;
  const topMatch = hit
    ? {
        sim: topK[0].sim,
        autoTodo: topK[0].autoTodo,
        autoEvent: topK[0].autoEvent,
      }
    : null;

  const userMsg = buildPrompt(mail, topK, hit, interestProfile);

  const response = await callLlm("mail_curate", {
    system: SYSTEM_PROMPT,
    messages: [{ role: "user", content: userMsg }],
    maxTokens: 400,
  });

  const text = response.content
    .filter((b): b is Anthropic.TextBlock => b.type === "text")
    .map((b) => b.text)
    .join("")
    .trim();

  const parsed = parseJsonLoose(text);
  const bucket = isBucket(parsed.bucket) ? parsed.bucket : "needed";
  const confidence = clamp01(parsed.confidence);
  // score が Gemma 出力に無ければ bucket の代表値を fallback として使う
  const score = parsed.score !== undefined
    ? clamp01(parsed.score)
    : BUCKET_FALLBACK_SCORE[bucket];
  const reason = typeof parsed.reason === "string" ? parsed.reason.slice(0, 200) : "";

  return { bucket, confidence, score, reason, topMatch };
}

/**
 * embedding / プロンプト共通の表現に変換。
 * header (from/to/account/subject) は短いが判別に決定的な情報源 (例: 経理宛 vs 個人宛)
 * なので、本文 head の前に常に含める。
 */
function buildEmbeddedText(mail: {
  fromEmail: string;
  fromName: string | null;
  toAddresses: string[] | null;
  accountEmail: string;
  subject: string | null;
  bodyText: string | null;
}): string {
  const from = mail.fromName ? `${mail.fromName} <${mail.fromEmail}>` : mail.fromEmail;
  const to = (mail.toAddresses ?? []).join(", ") || "(unknown)";
  const sub = (mail.subject ?? "").trim();
  const body = (mail.bodyText ?? "").slice(0, BODY_HEAD_CHARS);
  return [
    `from: ${from}`,
    `to: ${to}`,
    `account: ${mail.accountEmail}`,
    `subject: ${sub}`,
    "",
    body,
  ]
    .join("\n")
    .trim();
}

function buildPrompt(
  mail: {
    fromEmail: string;
    fromName: string | null;
    toAddresses: string[] | null;
    accountEmail: string;
    subject: string | null;
    bodyText: string | null;
    snippet: string | null;
  },
  topK: Array<{ bucket: string; hintText: string; embeddedText: string; sim: number }>,
  isHit: boolean,
  interestProfile: string
): string {
  const parts: string[] = [];

  if (isHit) {
    parts.push("## 過去の類似判定 (参考)");
    for (let i = 0; i < topK.length; i++) {
      const ex = topK[i];
      parts.push(
        `${i + 1}. (類似度 ${ex.sim.toFixed(2)}) bucket=${ex.bucket}`,
        `   理由: ${ex.hintText}`,
        `   メール: ${ex.embeddedText.slice(0, 400).replace(/\s+/g, " ")}`
      );
    }
    parts.push("");
  } else if (interestProfile.trim()) {
    parts.push("## ご主人様の興味プロファイル");
    parts.push(interestProfile.trim());
    parts.push("");
  }

  const from = mail.fromName ? `${mail.fromName} <${mail.fromEmail}>` : mail.fromEmail;
  const to = (mail.toAddresses ?? []).join(", ") || "(unknown)";
  const body = (mail.bodyText ?? mail.snippet ?? "").slice(0, BODY_HEAD_CHARS);

  parts.push(
    "## 今回のメール",
    `from: ${from}`,
    `to: ${to}`,
    `account: ${mail.accountEmail} (このメールを受信したご主人様のアカウント)`,
    `subject: ${mail.subject ?? "(no subject)"}`,
    `body:\n${body}`,
    "",
    "上記を分類して JSON 1 行で返してください。"
  );

  return parts.join("\n");
}

async function writeBucket(
  id: number,
  bucket: Bucket,
  confidence: number,
  score: number,
  reason: string,
  now: Date
): Promise<void> {
  await db
    .update(mailMessages)
    .set({
      bucket,
      bucketConfidence: confidence,
      bucketReason: reason,
      classifiedAt: now,
      // score は廃止せず、バケット内重要度として LLM 出力をそのまま保存。
      // UI 右ペインの「重要度」、自動アクション閾値 (Phase 3) に使う。
      score,
      scoreReason: reason,
      curatedAt: now,
    })
    .where(eq(mailMessages.id, id));
}

async function loadContactEmails(): Promise<Set<string>> {
  const out = new Set<string>();
  try {
    const rows = await db
      .select({ emails: contacts.emails })
      .from(contacts)
      .where(isNull(contacts.deletedAt));
    for (const r of rows) {
      for (const e of r.emails ?? []) {
        if (e?.value) out.add(e.value.toLowerCase().trim());
      }
    }
  } catch (e) {
    console.warn("[mail-curate] loadContactEmails failed:", e);
  }
  return out;
}

function toVector(arr: number[]): string {
  return `[${arr.join(",")}]`;
}

function clamp01(n: unknown): number {
  const x = typeof n === "number" ? n : parseFloat(String(n));
  if (!Number.isFinite(x)) return 0;
  return Math.max(0, Math.min(1, x));
}

function isBucket(v: unknown): v is Bucket {
  return v === "important" || v === "needed" || v === "unneeded";
}

function parseJsonLoose(text: string): {
  bucket?: unknown;
  confidence?: unknown;
  score?: unknown;
  reason?: unknown;
} {
  const cleaned = text
    .replace(/^```(?:json)?\s*\n/, "")
    .replace(/\n```\s*$/, "")
    .trim();
  // 先頭〜末尾の中で最初に出てくる { ... } を抽出 (Gemma が前後にゴミを吐くケース対策)
  const m = cleaned.match(/\{[\s\S]*\}/);
  if (!m) throw new Error("no JSON object in response");
  return JSON.parse(m[0]);
}
