/**
 * Specialist registry: Yui から見える specialist 一覧を集約。
 *
 * 新しい specialist を追加するときはここに 1 行登録するだけ。
 * Yui の prompt も /api/chat も触らずに済む。
 *
 * isAvailable は async: DB に行く specialist (OAuth 連携状態を確認するもの) を
 * サポートするため。chat ごとに 1 DB クエリ走るが Yui は単一ユーザー前提なので OK。
 */
import type Anthropic from "@anthropic-ai/sdk";
import { isGoogleClientConfigured, loadCurrentToken } from "@/lib/google-oauth";
import { isSpotifyClientConfigured, getAccessToken } from "@/lib/spotify";
import { scheduleSpecialist } from "./schedule";
import { mailSpecialist } from "./mail";
import { musicSpecialist } from "./music";
import type { Specialist } from "./types";
import { YUI_DELEGATION_SCHEMA } from "./types";

type Registration = {
  spec: Specialist;
  /** specialist が現在使えるかの判定 (依存サービスの設定確認等) */
  isAvailable: () => boolean | Promise<boolean>;
};

/**
 * Google 連携済みかどうかの判定。
 * .env に client 設定があり、かつ DB に token row があり、要求スコープを含む。
 */
async function isGoogleScopeAvailable(scopeSuffix: string): Promise<boolean> {
  if (!isGoogleClientConfigured()) return false;
  try {
    const row = await loadCurrentToken();
    if (!row) return false;
    return row.scopes.some((s) => s.endsWith(scopeSuffix));
  } catch {
    return false;
  }
}

const REGISTRATIONS: Registration[] = [
  // Plane (task specialist) は廃止。tasks 系操作は Yui 直接 tool (add_todo / list_todos / ...) で実行。
  {
    spec: scheduleSpecialist,
    isAvailable: () => isGoogleScopeAvailable("/calendar.readonly"),
  },
  {
    spec: mailSpecialist,
    isAvailable: () => isGoogleScopeAvailable("/gmail.readonly"),
  },
  // Spotify は client 設定済 + token row 存在 (= 連携済) のときに有効。
  // search/play 系の Spotify Web API は token 必須なので、未連携なら specialist 自体を Yui から消す。
  {
    spec: musicSpecialist,
    isAvailable: async () => {
      if (!(await isSpotifyClientConfigured())) return false;
      try {
        const t = await getAccessToken();
        return t !== null;
      } catch {
        return false;
      }
    },
  },
  // 将来:
  // { spec: researchSpecialist,      isAvailable: () => true },
  // { spec: documentSpecialist,      isAvailable: () => true },
];

export async function activeSpecialists(): Promise<Specialist[]> {
  const checks = await Promise.all(
    REGISTRATIONS.map(async (r) => ({
      spec: r.spec,
      available: await r.isAvailable(),
    }))
  );
  return checks.filter((c) => c.available).map((c) => c.spec);
}

/**
 * Yui の Claude API に渡す tools 配列を自動生成。
 * 各 specialist について `ask_X_specialist` wrapper を作る。
 */
export async function yuiSpecialistTools(): Promise<Anthropic.Tool[]> {
  const specs = await activeSpecialists();
  return specs.map((spec) => ({
    name: spec.yuiToolName,
    description: spec.yuiDescription,
    input_schema: YUI_DELEGATION_SCHEMA,
  }));
}

/** Yui tool 名から specialist を引く */
export async function findSpecialistByYuiToolName(
  toolName: string
): Promise<Specialist | undefined> {
  const specs = await activeSpecialists();
  return specs.find((s) => s.yuiToolName === toolName);
}

