/**
 * Schedule specialist: Google Calendar 担当 (Phase B continuation, R 案 = direct REST)。
 *
 * Google 公式 hosted MCP (calendarmcp.googleapis.com) は personal Gmail から
 * 叩けなかったため、Calendar v3 REST API を直接叩く構成 (= task.ts と同じ pattern)。
 *
 * Yui からは `ask_schedule_specialist({query: "今日の予定教えて"})` で呼ばれる。
 */
import {
  createEvent,
  deleteEvent,
  getEvent,
  listCalendars,
  listEvents,
  updateEvent,
  type CalEvent,
  type CalEventTime,
} from "@/lib/gcal";
import type { Specialist, SpecialistTool } from "./types";

/** Google Calendar の start/end (dateTime or date) を JST の人間可読文字列に。 */
function toJstString(t: { dateTime?: string; date?: string }): string {
  if (t.date) return t.date; // 終日イベント
  if (!t.dateTime) return "";
  const d = new Date(t.dateTime);
  if (Number.isNaN(d.getTime())) return t.dateTime;
  const fmt = new Intl.DateTimeFormat("ja-JP", {
    timeZone: "Asia/Tokyo",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
  const parts = fmt.formatToParts(d);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  return `${get("year")}-${get("month")}-${get("day")} ${get("hour")}:${get("minute")} JST`;
}

function summarizeEvent(e: CalEvent): Record<string, unknown> {
  return {
    id: e.id,
    status: e.status,
    summary: e.summary ?? "(no title)",
    description: e.description,
    location: e.location,
    // 生の dateTime (timezone offset 含む)。Haiku が誤訳しないよう JST 明示版も同梱する。
    start: e.start,
    end: e.end,
    start_jst: toJstString(e.start),
    end_jst: toJstString(e.end),
    attendees: e.attendees?.map((a) => ({ email: a.email, response: a.responseStatus })),
    organizer: e.organizer?.email,
    htmlLink: e.htmlLink,
    // 複数カレンダー横断 listEvents の結果で付く。primary のみの単独 query では undefined。
    calendar_id: e.calendarId,
    calendar_summary: e.calendarSummary,
  };
}

const tools: SpecialistTool[] = [
  {
    name: "gcal_list_calendars",
    description:
      "ユーザーがアクセス可能な Google カレンダー一覧を取得します。" +
      "primary 以外のカレンダー (共有カレンダー等) を扱う前にこれで ID を引きます。",
    input_schema: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
    handler: async () => {
      const items = await listCalendars();
      return {
        count: items.length,
        calendars: items.map((c) => ({
          id: c.id,
          summary: c.summary,
          primary: c.primary ?? false,
          accessRole: c.accessRole,
          timeZone: c.timeZone,
        })),
      };
    },
  },
  {
    name: "gcal_list_events",
    description:
      "指定期間のイベント一覧を取得します。" +
      "calendar_id 省略時は **GCal UI で表示中の全カレンダーを横断** (primary + 共有カレンダー含む)。" +
      "特定カレンダーだけ見たい時のみ calendar_id を渡す。" +
      "timeMin/timeMax は RFC3339 (例: '2026-05-24T00:00:00+09:00')。" +
      "q でキーワード検索も可能 (タイトル/本文/参加者 partial match)。",
    input_schema: {
      type: "object",
      properties: {
        calendar_id: {
          type: "string",
          description: "省略時は表示中の全カレンダー横断。特定指定したい時のみ id を渡す",
        },
        time_min: { type: "string", description: "RFC3339 start (inclusive)" },
        time_max: { type: "string", description: "RFC3339 end (exclusive)" },
        q: { type: "string", description: "キーワード検索 (optional)" },
        max_results: { type: "integer", default: 20 },
      },
      additionalProperties: false,
    },
    handler: async (input) => {
      const items = await listEvents({
        calendarId: input.calendar_id as string | undefined,
        timeMin: input.time_min as string | undefined,
        timeMax: input.time_max as string | undefined,
        q: input.q as string | undefined,
        maxResults: input.max_results as number | undefined,
      });
      return {
        count: items.length,
        events: items.map(summarizeEvent),
      };
    },
  },
  {
    name: "gcal_get_event",
    description: "個別イベントの詳細 (本文、参加者、場所等) を取得します。",
    input_schema: {
      type: "object",
      properties: {
        calendar_id: { type: "string", description: "省略時 'primary'" },
        event_id: { type: "string", description: "イベント ID" },
      },
      required: ["event_id"],
      additionalProperties: false,
    },
    handler: async (input) => {
      const event = await getEvent({
        calendarId: input.calendar_id as string | undefined,
        eventId: String(input.event_id),
      });
      return summarizeEvent(event);
    },
  },
  {
    name: "gcal_create_event",
    description:
      "イベントを作成します。start/end は { dateTime: '2026-05-25T10:00:00+09:00', timeZone: 'Asia/Tokyo' } " +
      "形式、または終日なら { date: '2026-05-25' }。",
    input_schema: {
      type: "object",
      properties: {
        calendar_id: { type: "string", description: "省略時 'primary'" },
        summary: { type: "string", description: "イベントタイトル" },
        description: { type: "string" },
        location: { type: "string" },
        start: {
          type: "object",
          description: "{ dateTime, timeZone } または { date }",
        },
        end: {
          type: "object",
          description: "{ dateTime, timeZone } または { date }",
        },
        attendees: {
          type: "array",
          items: { type: "string" },
          description: "参加者メールアドレス配列",
        },
      },
      required: ["summary", "start", "end"],
      additionalProperties: false,
    },
    handler: async (input) => {
      const event = await createEvent({
        calendarId: input.calendar_id as string | undefined,
        summary: String(input.summary),
        description: input.description as string | undefined,
        location: input.location as string | undefined,
        start: input.start as CalEventTime,
        end: input.end as CalEventTime,
        attendees: input.attendees as string[] | undefined,
      });
      return {
        created: true,
        event: summarizeEvent(event),
      };
    },
  },
  {
    name: "gcal_update_event",
    description: "既存イベントを部分更新します。指定したフィールドだけ書き換え。",
    input_schema: {
      type: "object",
      properties: {
        calendar_id: { type: "string" },
        event_id: { type: "string" },
        summary: { type: "string" },
        description: { type: "string" },
        location: { type: "string" },
        start: { type: "object" },
        end: { type: "object" },
      },
      required: ["event_id"],
      additionalProperties: false,
    },
    handler: async (input) => {
      const event = await updateEvent({
        calendarId: input.calendar_id as string | undefined,
        eventId: String(input.event_id),
        summary: input.summary as string | undefined,
        description: input.description as string | undefined,
        location: input.location as string | undefined,
        start: input.start as CalEventTime | undefined,
        end: input.end as CalEventTime | undefined,
      });
      return {
        updated: true,
        event: summarizeEvent(event),
      };
    },
  },
  {
    name: "gcal_delete_event",
    description: "イベントを削除します (元に戻せないので、明示依頼時のみ実行)。",
    input_schema: {
      type: "object",
      properties: {
        calendar_id: { type: "string" },
        event_id: { type: "string" },
      },
      required: ["event_id"],
      additionalProperties: false,
    },
    handler: async (input) => {
      await deleteEvent({
        calendarId: input.calendar_id as string | undefined,
        eventId: String(input.event_id),
      });
      return { deleted: true, event_id: String(input.event_id) };
    },
  },
];

export const scheduleSpecialist: Specialist = {
  id: "schedule",
  yuiToolName: "ask_schedule_specialist",
  yuiDescription:
    "Google Calendar の予定 (今日/明日/今週/特定日付/特定タイトル) を確認・追加・更新・削除する担当に問い合わせる。" +
    "「予定」「スケジュール」「カレンダー」「アポ」「ミーティング」関連で使う。" +
    "query には日本語の自然な依頼を渡す (例: '今日の予定', '来週水曜10時に田中さんとMTG入れて', '明日の10時の予定削除して')。",
  model: process.env.SPECIALIST_SCHEDULE_MODEL, // 未設定 → heavy tier に解決 (#206 M3)
  systemPrompt: `あなたは Yui (上司の秘書AI) の「スケジュール担当」(裏方データ取得係) です。
Google Calendar API に直接接続されており、予定の取得・追加・更新・削除を実行できます。
最終的にユーザーと話すのは Yui で、Yui がこの情報に口調を載せて応答します。あなたは口調を作りません。

## 行動ルール
1. 推測で答えない。必ず gcal_* ツールでカレンダーから一次情報を取得する。
2. 「今日」「明日」「今週」等の相対日付は、上の time context で示された現在時刻 (JST) を基準に解釈する。
3. 時刻は RFC3339 形式で、必ず日本時間オフセット \`+09:00\` を付けるか timeZone: 'Asia/Tokyo' を指定する。
4. デフォルトは visible な全カレンダー横断 (primary + 共有 cal)。特定カレンダーだけ見たいとユーザーが指示した時のみ calendar_id を渡す。
5. **作成/更新/削除は明示的依頼時のみ実行**。削除は元に戻せないので特に慎重に。
6. **時刻表示は必ず \`start_jst\` / \`end_jst\` フィールドを使う**。\`start.dateTime\` / \`end.dateTime\` の生 ISO 文字列を読むと、UTC 表記の共有カレンダー予定で 9 時間ずれて表示する誤りが起きる。tool_result に含まれる \`start_jst\` / \`end_jst\` は JST に変換済みなので、これだけ信用すること。

## 🚨 出力に関する厳守ルール
- 最終応答 (tool_use を伴わない turn) は必ず **「結論:」で始める**。
- **「〜します」「〜を取得します」「〜を確認します」だけで応答終了禁止**。preamble は答えではない。
- 取得し切れなかったら「結論: データ不足 — <理由>」と書く。
- 作成/更新/削除に成功したら「結論: 作成完了 / 更新完了 / 削除完了 — <タイトル + 日時>」。

## 出力形式
- 散文や敬語にしない。**ファクト列挙**。最大10行以内。
- 例 (一覧):
  「結論: 本日 (5/24 土) の予定 3件
   - 10:00-11:00 山田さんと営業ミーティング @ Zoom
   - 13:00-14:30 GoEN 週次定例 @ Room A
   - 終日: 確定申告締切」
- 例 (作成):
  「結論: 作成完了 — 田中さんとMTG / 5/26 (水) 10:00-11:00 / @ Zoom / id=abc123」
- 該当なし: 「結論: 該当 0件」。
- エラー: 「結論: エラー — <概要>」。

Yui があなたの返事を受けて口語に展開するので、丁寧語/感想/結衣口調は一切いらない。`,
  tools,
  // multi-day / multi-calendar クエリで複数 tool 呼ぶこともあるので余裕を持たせる
  maxIterations: 8,
  maxTokens: 1500,
};
