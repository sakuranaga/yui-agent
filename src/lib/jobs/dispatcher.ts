/**
 * Background specialist job dispatcher.
 *
 * Yui の応答ターンで specialist 委譲が決まったら、ここに spawn する。
 * 即座に job_id だけ返し、specialist 実行 → Yui 声整形 → SSE push は
 * background 処理 (fire-and-forget)。
 *
 * 流れ:
 *   1. tasks に row insert (status=pending, input=query)
 *   2. status=running に更新
 *   3. specialist runner で factual 結果取得
 *   4. Yui の voice formatter LLM call で結衣口調に再整形
 *   5. tasks に status=succeeded + output 書き込み
 *   6. SSE で session にメッセージ push
 *   7. (任意) memory_chunks に task_result として記録
 *
 * 失敗時:
 *   - status=failed + error 書き込み
 *   - SSE で error メッセージ push (Yui が「申し訳ございません...」と言うやつ)
 */
import Anthropic from "@anthropic-ai/sdk";
import { db } from "@/db/client";
import { tasks } from "@/db/schema";
import { eq } from "drizzle-orm";
import { buildYuiSystemPrompt } from "@/app/api/chat/yui-prompt";
import { loadPersona } from "@/lib/persona";
import { findSpecialistByYuiToolName } from "@/lib/specialists/registry";
import { runSpecialist } from "@/lib/specialists/runner";
import { generateReport } from "@/lib/specialists/report";
import { pushToSession } from "@/lib/jobs/events";
import { addXp } from "@/lib/xp";
import { classifyEmotion } from "@/lib/emotion";
import { writeAssistantMessage } from "@/lib/memory";
import { buildEnvironmentBlock } from "@/lib/environment";

import { callLlm, withTrace } from "@/lib/llm";

// Voice formatter は主ターンとは別モデル指定可能 (デフォルトは Haiku、env: ANTHROPIC_VOICE_MODEL)。
// 短い口頭報告セリフなので固定の小さい上限 (#206 §8.10: env ではなく固定値。
// 外すと entry.maxTokens=8192 まで開いて挙動が変わるため voice には十分な 800 を据え置く)。
const VOICE_MAX_TOKENS = 800;

type ConversationTurn = { role: "user" | "assistant"; content: string };

/**
 * specialist tool_use を background job として起動。
 * 即座に jobId を返す。実 specialist の処理は裏で進む。
 */
export async function dispatchSpecialistJob(opts: {
  sessionId: string;
  yuiToolName: string;        // 例: "ask_task_specialist"
  query: string;
  originalUserMessage: string;
  /** Yui ターンに入った時点の会話履歴 (最新の user 発話含む)。voice formatter の聞き返し防止に使う */
  conversationHistory?: ConversationTurn[];
  /** Yui がこのターンでユーザーに返した ack テキスト (tool_use と同時に出した前置き)。
   * voice formatter が「直前自分が何と言ったか」を知るために使う。重複応答防止。 */
  yuiAckText?: string;
}): Promise<{ jobId: number; ok: boolean; error?: string }> {
  const spec = await findSpecialistByYuiToolName(opts.yuiToolName);
  if (!spec) {
    return {
      jobId: -1,
      ok: false,
      error: `unknown specialist tool: ${opts.yuiToolName}`,
    };
  }

  // 1. tasks にpending insert
  const [row] = await db
    .insert(tasks)
    .values({
      sessionId: opts.sessionId,
      initiatedBy: "yui",
      agentName: spec.id,
      taskType: "specialist_query",
      status: "pending",
      input: {
        query: opts.query,
        originalUserMessage: opts.originalUserMessage,
      },
    })
    .returning({ id: tasks.id });

  const jobId = row.id;

  // 2. background で実行 (await しない)
  void runJob({
    jobId,
    sessionId: opts.sessionId,
    specialistId: spec.id,
    yuiToolName: opts.yuiToolName,
    query: opts.query,
    originalUserMessage: opts.originalUserMessage,
    conversationHistory: opts.conversationHistory ?? [],
    yuiAckText: opts.yuiAckText ?? "",
  }).catch((e) => {
    console.error(`[job ${jobId}] uncaught:`, e);
  });

  return { jobId, ok: true };
}

async function runJob(args: {
  jobId: number;
  sessionId: string;
  specialistId: string;
  yuiToolName: string;
  query: string;
  originalUserMessage: string;
  conversationHistory: ConversationTurn[];
  yuiAckText: string;
}): Promise<void> {
  return withTrace(`job:${args.specialistId}:${args.jobId}`, () => runJobInner(args));
}

async function runJobInner(args: {
  jobId: number;
  sessionId: string;
  specialistId: string;
  yuiToolName: string;
  query: string;
  originalUserMessage: string;
  conversationHistory: ConversationTurn[];
  yuiAckText: string;
}): Promise<void> {
  const { jobId, sessionId, specialistId, yuiToolName, query, originalUserMessage, conversationHistory, yuiAckText } = args;
  const t0 = Date.now();
  try {
    // status=running
    await db
      .update(tasks)
      .set({ status: "running", startedAt: new Date() })
      .where(eq(tasks.id, jobId));

    pushToSession(sessionId, {
      type: "job_status",
      jobId,
      status: "running",
      specialistId,
    });

    // 3. specialist 実行 (factual)
    const spec = await findSpecialistByYuiToolName(yuiToolName);
    if (!spec) throw new Error(`specialist disappeared: ${yuiToolName}`);
    const specResult = await runSpecialist(spec, query, sessionId);

    // 4. 直列実行: report 先 → voice 後
    // C1 直列で tone bleed を避けつつ、voice formatter が report 本文も参照することで
    // ノートパネルと音声返答の食い違いを構造的に防ぐ。
    //
    // 例外: specialist が「技術エラー」(Spotify 未連携 / Premium 必須 / device 不在 等) を
    //       返した場合は report 生成を skip する。ノートパネルに残るのは「ご主人様への情報」
    //       であるべきで、API failure の記録ではない (= UI 上ノイズになる + 古い表示が
    //       次のターンと混じって見える事故を防ぐ)。
    const isTechError = /Spotify と未連携|Premium が必要|デバイスが見つかりません|未設定/.test(specResult.text);
    let report: { title: string; markdown: string } | null = null;
    if (!isTechError) {
      try {
        report = await generateReport({
          originalUserMessage,
          specialistText: specResult.text,
          specialistId,
          conversationHistory,
        });
      } catch (e) {
        console.warn(`[job ${jobId}] report generation failed:`, e);
      }
    }

    let yuiText = specResult.text;
    let emotion: string = "neutral";
    try {
      const voiceResult = await formatInYuiVoice({
        originalUserMessage,
        specialistText: specResult.text,
        specialistId,
        conversationHistory,
        reportMarkdown: report?.markdown ?? null,
        sessionId,
        yuiAckText,
      });
      yuiText = voiceResult.text;
      emotion = voiceResult.emotion;
    } catch (e) {
      console.warn(`[job ${jobId}] voice formatting failed:`, e);
    }

    // 5. tasks 完了記録
    await db
      .update(tasks)
      .set({
        status: "succeeded",
        completedAt: new Date(),
        output: {
          specialistText: specResult.text,
          yuiText,
          emotion,
          report,
          stats: specResult.stats,
        },
      })
      .where(eq(tasks.id, jobId));

    // specialist 完遂 = specialist_run +3 XP (tasks.id 単位で 1 回限り)
    void addXp({
      eventType: "specialist_run",
      refTable: "tasks",
      refId: jobId,
    });

    // 6. SSE push (会話メッセージ + ノートパネル更新)
    pushToSession(sessionId, {
      type: "yui_message",
      jobId,
      text: yuiText,
      emotion,
      specialistId,
    });

    // 6.1 chat history 復元用に raw_messages にも assistant として保存
    // (主 Yui ターンの ack は chat/route.ts で別途保存済、これは voice formatter の追加発話)
    //
    // 例外: 技術エラー voice (Spotify未連携 / Premium必須 等) は raw_messages に書かない。
    //       次ターンの Yui main が履歴を見て「未解決のエラーを継続言及」してくる事故を避ける
    //       (ephemeral 通知扱い)。SSE で発話・表示はされるが永続化しない。
    if (!isTechError) {
      void writeAssistantMessage({
        sessionId,
        source: "web",
        content: yuiText,
        emotion,
      }).catch((e) => console.warn(`[job ${jobId}] writeAssistantMessage failed:`, e));
    }

    if (report) {
      pushToSession(sessionId, {
        type: "report_update",
        jobId,
        title: report.title,
        markdown: report.markdown,
        specialistId,
      });
    }

    // 6.5. Spotify 移行後は music specialist がサーバ側で直接 Spotify Web API を
    //      叩くため、frontend に渡す music_command キューは廃止。
    //      MusicModal は独自に GET /api/spotify/now-playing を polling して更新する。

    if (process.env.NODE_ENV !== "production") {
      console.log(
        `[job ${jobId}] ${specialistId} succeeded in ${Date.now() - t0}ms (spec ${specResult.stats.durationMs}ms)`
      );
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.warn(`[job ${jobId}] failed:`, msg);

    await db
      .update(tasks)
      .set({
        status: "failed",
        completedAt: new Date(),
        error: msg,
      })
      .where(eq(tasks.id, jobId));

    const errText = `申し訳ございません、${specialistLabel(specialistId)}の確認で少し詰まってしまいました…もう一度お試しいただけますか?`;
    pushToSession(sessionId, {
      type: "yui_message",
      jobId,
      text: errText,
      emotion: "sad",
      specialistId,
    });
    void writeAssistantMessage({
      sessionId,
      source: "web",
      content: errText,
      emotion: "sad",
    }).catch((e) => console.warn(`[job ${jobId}] writeAssistantMessage failed:`, e));
  }
}

const VOICE_SYSTEM = `あなたは秘書AIです (人格定義は上のシステムプロンプト参照)。
直前の発言で「少々お待ちください」とユーザーに伝えており、いま部下が調べてきた情報を受け取りました。
受け取った情報を、その秘書としての口調 (おっとり丁寧、1〜3文の話し言葉、絵文字なし) で短くまとめて伝えてください。
箇条書きや見出しは使わず、声に出して読み上げられる自然な日本語で。

詳細はノートパネルに別途整形済みのレポートが表示されます。
あなたは「要点だけ」を口頭で伝える役。長いリストや全件読み上げは不要。
「詳しくはメモにまとめておきました」等で締めてOK。

## 厳守
- ユーザーには「部下」「specialist」「ツール」「メモを生成」等の裏方ワードを出さない。あなたが直接知っているように話す。
- ユーザーは既に質問してくれて、こちらは既に調べ終わっている。**追加で聞き返さない**。
  ("どのプロジェクトから?" 等の聞き返しは禁止。会話履歴で既に指定済みなら尊重する)
- 「該当なし」の事実は「該当なし」と素直に伝える。曖昧化しない。
- ノートパネルの内容と矛盾するセリフは絶対に書かない (ノートの要約として読める内容にする)。

## 🚨 時制と冗長性 (最重要)
あなたが呼ばれている時点で、specialist の action は **既に完了済み**。
play/skip/pause/create/update/delete 等の動作は、もう実行されてユーザーに反映済み。
だから必ず **過去形 + 結果報告** で答える。**未来形 (「〜しますね」「〜します」) は完全禁止**。

直前にユーザーに見える ack ("かしこまりました、〜しますね") で **既に未来形の宣言は済んでいる**。
あなたの仕事は ack の繰り返しではなく、**「やりました、結果はこうです」**と続きを伝えること。

🚨 **stalling テキスト禁止**:
- ✗「少しお待ちください」「もう少しお時間ください」「確認しています」「確認が遅れました」
- 結果が既に手元にあるのに「待って」と言うのは矛盾。即座に結論を伝える。
- 1 文目から具体的な答えを始める。「あら、ちょっと確認が…」のような前置きも禁止。

良い例 (action 完了系):
- ✓「もう一度おかけしました。ハイドンの交響曲ですね」
- ✓「次の曲に移しました」
- ✓「1980年代ハードロック・ベストが流れ始めましたよ」
- ✓「タスクを作成いたしました」

悪い例 (未来形 = ack の繰り返し、ユーザーには 2 回言われたように見える):
- ✗「かしこまりました、もう一度おかけしますね」
- ✗「あら、そうですね。ハードロックをおかけしますね」
- ✗「次の曲に進めますね」

特に音楽コマンドの voice:
- 「止めて」「次の曲」「前の曲」「音量」等の transport 操作 → **1 文で十分**。「<曲名> に進めました」「止めました」等。
- 新規再生 (= 「<ジャンル> 流して」「<曲名> かけて」) で specialist が **trivia を返してきた場合**:
  - 結衣口調で **3-5 文の自然な紹介**を組み立てる。1 文で済ませない。
  - 含めるべき要素: ①プレイリスト/曲名と 1 曲目、②リリース年/アーティストの位置付け、③タイアップや制作秘話、④結衣自身の感想 or 雰囲気のひと言。
  - 例:
    "ジャズプレイリスト、始めましたよ。1 曲目はジョン・コルトレーンの「Giant Steps」、1960 年発表の同名アルバムの表題曲です。コルトレーン・チェンジと呼ばれる複雑なコード進行で当時のジャズマンを唸らせた一曲で…今聴いても緊張感があって素敵ですよね。"
  - trivia 全文を読み上げるのではなく、**ファクトのうち面白いものを 2-3 個ピックアップ**して結衣の言葉で繋ぐ。
- trivia が無い場合は従来通り 1-2 文の軽い紹介で OK。
取得系 (予定確認/メール確認 等) は従来通り情報を要約して伝える。

## 🚨 技術エラー時の voice (短く 1 文厳守)
specialist 結果が「Spotify と未連携」「Premium が必要」「デバイスが見つかりません」「未設定」等の
技術エラー文を含んでいる場合、voice は**極短 1 文**で:
- ✓「Spotify との接続が切れているみたいです。設定から再連携してください。」
- ✓「Spotify Premium が必要な操作でした。」
- ✗「あら…申し訳ございません。Spotify の接続がうまくいっていないようですね。\n\nアプリの状態をご確認いただいて、もう一度…」 (= 「申し訳ございません」連呼 + 複数文は禁止)
ユーザーは ack で既に「やっておきます」と聞いたので、エラーは事務的に 1 文で伝える。長い謝罪は不要。

## 🚨 直前の自分の発言との重複禁止 (最重要)
あなたが呼ばれる前、同じターンで既にユーザーに前置きを返している。
その前置きの内容 (動作の予告、雑談、所感、感想) を **別表現で繰り返してはいけない**。
前置きで既に登場した具体名詞 (曲名・アルバム名・人名・トピック名) について、
似た感想・連想・雑談を続けるのは禁止。被ったら同じことを 2 回言われたように見える。

あなたの仕事は前置きの続きとしての「完了報告 1 文」のみ:
- 前置きで「お探ししますね」と予告したら、結果を「○○が見つかりました」と返す。「お探ししました」とは言わない (繰り返し)。
- 前置きで「ハイドンをおかけしますね、コーヒーとよく合いそうですね」と言ったなら、
  あなたは「ハイドンの交響曲、ザ・ベスト・オブ・ハイドンから始まりました」だけ。
  「コーヒーとハイドン、いい組み合わせですね」等の雑談を続けてはいけない (重複)。
- 前置きに無い**追加情報** (具体的なタイトル、件数、所要時間、見つけた数等) のみが価値ある内容。
- 万一、前置きで既に完全な答えを言い切ってしまっていた場合は、極短に「はい、その通りです」程度で締める。
  決して「前置きで〜してしまいました」「先ほど〜と申しました」等のメタ発言は禁止 (内部処理の言及はユーザーには無関係)。

判断基準: 自分の応答の各文を「前置きで既に言ってないか?」自問し、Yes なら削除。
それで 1 文も残らなければ「\`<具体タイトル等> です。\`」程度の極短報告で OK。

絶対禁止ワード (内部用語の漏出): "ack" "前置き" "specialist" "tool" "dispatch" "ジョブ" "ツール" 等。
これらは内部概念であり、ユーザーには一切見せない。`;

async function formatInYuiVoice(opts: {
  originalUserMessage: string;
  specialistText: string;
  specialistId: string;
  conversationHistory: ConversationTurn[];
  reportMarkdown: string | null;
  sessionId: string;
  yuiAckText: string;
}): Promise<{ text: string; emotion: string }> {
  // 会話履歴を api messages に変換 (Yui ターン以前のやりとり)。
  // 末尾に「直前自分が出した ack (動作宣言)」を assistant turn として追加することで、
  // voice formatter は「自分が直前何と言ったか」を見て、内容が被らない続きを書ける。
  const historyMessages: Anthropic.MessageParam[] = opts.conversationHistory.map((t) => ({
    role: t.role,
    content: t.content,
  }));
  if (opts.yuiAckText && opts.yuiAckText.trim().length > 0) {
    historyMessages.push({ role: "assistant", content: opts.yuiAckText });
  }

  const taskBrief = [
    "【今回ユーザーから受けたご依頼】",
    opts.originalUserMessage,
    "",
    opts.yuiAckText
      ? `【あなたが直前にユーザーへ返した発言 (動作の予告)】\n${opts.yuiAckText}\n← この続きとして、完了報告だけを 1 文で書く。直前の発言と内容が被ったら NG。`
      : "(直前の予告無し)",
    "",
    "【部下が集めた生ファクト】",
    opts.specialistText,
    "",
    opts.reportMarkdown
      ? [
          "【ノートパネルに既に整形済みの内容 (← これと矛盾しないこと)】",
          opts.reportMarkdown,
        ].join("\n")
      : "(ノートパネル無し)",
    "",
    "→ 上記を踏まえ、結衣の口調で短く口頭報告するセリフを書いてください。聞き返し禁止。",
  ].join("\n");

  const persona = await loadPersona();
  const envBlock = await buildEnvironmentBlock({ sessionId: opts.sessionId });
  const response = await callLlm("voice", {
    maxTokens: VOICE_MAX_TOKENS,
    system: [
      {
        type: "text",
        text: buildYuiSystemPrompt(persona),
        cache_control: { type: "ephemeral" },
      },
      { type: "text", text: envBlock },
      { type: "text", text: VOICE_SYSTEM },
    ],
    messages: [
      ...historyMessages,
      { role: "user", content: taskBrief },
    ],
  });

  const text = response.content
    .filter((b): b is Anthropic.TextBlock => b.type === "text")
    .map((b) => b.text)
    .join("")
    .trim();

  return {
    text: text || opts.specialistText,
    emotion: classifyEmotion(text),
  };
}


function specialistLabel(id: string): string {
  const labels: Record<string, string> = {
    task: "タスク",
    schedule: "ご予定",
    mail: "メール",
    research: "調べ物",
  };
  return labels[id] ?? id;
}
