/**
 * 朝のブリーフィング (毎朝 9 時 JST 配信) 取得 tool。
 * 呼ぶと自動的に ReportPanel に該当 brief を表示する (= pushToSession で report_update event)。
 */
import {
  getMorningBriefForDate,
  getLatestMorningBrief,
  briefDateYmd,
} from "@/lib/morning-briefs";
import { pushToSession } from "@/lib/jobs/events";
import type { ToolDef } from "../types";

export const getMorningBrief: ToolDef = {
  name: "get_morning_brief",
  description:
    "指定日の朝のブリーフィング (markdown) を取得し、自動的に ReportPanel に表示する。" +
    "「昨日のブリーフ見せて」「5月27日のは?」「今朝の振り返って」等で呼ぶ。" +
    "date 省略時は最新 1 件。返り値は found / date / markdown。",
  input_schema: {
    type: "object",
    properties: {
      date: {
        type: "string",
        description: "(任意) YYYY-MM-DD。'today' / 'yesterday' も解釈する。省略時は最新。",
      },
    },
    additionalProperties: false,
  },
  callableBy: [{ kind: "main" }],
  surface: "read",
  domain: "brief",
  untrustedOutput: false,
  allowedModes: ["normal", "timer", "background"],
  confirmationPolicy: "auto",
  handler: async (input, ctx) => {
    const i = (input ?? {}) as { date?: unknown };
    let target = typeof i.date === "string" ? i.date.trim() : undefined;
    const jstYmd = (d: Date) => {
      const parts = new Intl.DateTimeFormat("ja-JP", {
        timeZone: "Asia/Tokyo",
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
      }).formatToParts(d);
      const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
      return `${get("year")}-${get("month")}-${get("day")}`;
    };
    if (target === "today") target = jstYmd(new Date());
    else if (target === "yesterday") {
      const y = new Date();
      y.setUTCDate(y.getUTCDate() - 1);
      target = jstYmd(y);
    }
    const brief = target
      ? await getMorningBriefForDate(target)
      : await getLatestMorningBrief();
    if (!brief) {
      return { found: false, date: target ?? null };
    }
    const ymd = briefDateYmd(brief);
    // tool 実行時に ReportPanel へ自動表示 (見返しの体験を素早く)
    try {
      pushToSession(ctx.sessionId, {
        type: "report_update",
        jobId: Date.now(),
        title: `${ymd} のブリーフィング`,
        markdown: brief.markdown,
      });
    } catch (pushErr) {
      console.warn("[get_morning_brief] push failed:", pushErr);
    }
    return {
      found: true,
      date: ymd,
      markdown: brief.markdown,
      generated_at: brief.generatedAt.toISOString(),
    };
  },
};
