import type { ToolDef } from "../types";

export const getRouteTool: ToolDef = {
  name: "get_route",
  description:
    "「現在地 (or 指定地点) → 目的地」のルートを取得する。" +
    "車・徒歩は Google Routes API で時間と距離を返す。" +
    "電車 (transit) は JP データを server で取れないため、Google Maps の URL リンクを返す (= ご主人様にクリックして確認してもらう)。" +
    "「○○までどう行く?」「△△まで車で何分?」「□□までの乗換は?」等で呼ぶ。" +
    "推測で乗換案内 (= 駅名や所要時間) を答えない、必ず本ツールを呼ぶ。" +
    "transit の所要時間 / 乗換数を聞かれた時も推測で答えず、Maps リンクを案内する。" +
    "from 省略時はブラウザ位置情報を使う。modes 省略時は 3 種全部。",
  input_schema: {
    type: "object",
    properties: {
      destination: { type: "string", description: "目的地 (駅名 / 住所 / 施設名)" },
      from: { type: "string", description: "出発地 (任意、省略で現在地)" },
      modes: {
        type: "array",
        items: { type: "string", enum: ["transit", "driving", "walking"] },
        description: "取得したいモード (任意、省略で全部)",
      },
    },
    required: ["destination"],
    additionalProperties: false,
  },
  callableBy: [{ kind: "main" }],
  surface: "external",
  domain: "health",
  // Google Routes API の応答 (place 名 / 経路文字列) は外部由来 → 注入リスクあり
  untrustedOutput: true,
  allowedModes: ["normal"],
  confirmationPolicy: "auto",
  handler: async (input) => {
    const i = (input ?? {}) as { destination?: unknown; from?: unknown; modes?: unknown };
    if (typeof i.destination !== "string" || !i.destination) {
      throw new Error("destination 必須");
    }
    const { getRoute, formatRouteSummary } = await import("@/lib/routing");
    const modes = Array.isArray(i.modes)
      ? (i.modes.filter((m) => m === "transit" || m === "driving" || m === "walking") as Array<
          "transit" | "driving" | "walking"
        >)
      : undefined;
    const result = await getRoute({
      destination: i.destination,
      from: typeof i.from === "string" ? i.from : undefined,
      modes,
    });
    return formatRouteSummary(result);
  },
};
