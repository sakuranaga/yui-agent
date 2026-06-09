/**
 * 結衣自身のステータス (Lv / XP / お給料 / ハート総数) 参照 tool。
 * ご主人様から「今のレベルは?」「いいねいくつもらった?」等で呼ぶ。
 */
import { collectSecretaryStats } from "@/lib/secretary-stats";
import type { ToolDef } from "../types";

export const getMyStatus: ToolDef = {
  name: "get_my_status",
  description:
    "自分 (結衣) の現在のステータスを取得する: Lv、XP の進捗、" +
    "お給料 (今月・累計、JPY)、いただいたハート (いいね) の総数。" +
    "「レベルは?」「給料いくらだっけ?」「ハート何個もらった?」等で呼ぶ。引数なし。",
  input_schema: {
    type: "object",
    properties: {},
    additionalProperties: false,
  },
  callableBy: [{ kind: "main" }],
  surface: "read",
  domain: "status",
  untrustedOutput: false,
  allowedModes: ["normal", "timer", "background"],
  confirmationPolicy: "auto",
  handler: async () => {
    return await collectSecretaryStats();
  },
};
