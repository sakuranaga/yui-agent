import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "./schema";

declare global {
  var __vroidDb:
    | {
        sql: ReturnType<typeof postgres>;
        db: ReturnType<typeof drizzle<typeof schema>>;
      }
    | undefined;
}

function createClient() {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is not set");
  const sql = postgres(url, {
    max: 10,
    idle_timeout: 30,
    connect_timeout: 10,
  });
  const db = drizzle(sql, { schema });
  return { sql, db };
}

// 初回アクセス時に lazy に作る。Next 16 の page data collection は build 時に
// route handler module を import するので、module top-level で createClient() を
// 呼ぶと DATABASE_URL 未設定でビルドが落ちる。
// dev では globalThis にも持たせて HMR 跨ぎで接続を使い回す (典型パターン)。
// production は HMR 無いので globalThis 汚染は不要だが、Proxy の property アクセス
// ごとに getClient() が呼ばれるので module-scope cache が必須 (= 無いと createClient()
// が毎回走って pool が無限に増える)。
let cachedClient: ReturnType<typeof createClient> | undefined;

function getClient() {
  if (cachedClient) return cachedClient;
  cachedClient = globalThis.__vroidDb ?? createClient();
  if (process.env.NODE_ENV !== "production") {
    globalThis.__vroidDb = cachedClient;
  }
  return cachedClient;
}

export const db = new Proxy({} as ReturnType<typeof drizzle<typeof schema>>, {
  get(_t, prop, receiver) {
    return Reflect.get(getClient().db, prop, receiver);
  },
});

// postgres-js の sql は tagged template 呼び出し (= 関数) と property アクセス
// (= sql.begin, sql.end など) の両方を持つので、Proxy target は callable function。
const sqlProxyTarget = (() => {}) as unknown as ReturnType<typeof postgres>;
export const sql = new Proxy(sqlProxyTarget, {
  get(_t, prop, receiver) {
    return Reflect.get(getClient().sql, prop, receiver);
  },
  apply(_t, thisArg, args) {
    const real = getClient().sql as unknown as (...a: unknown[]) => unknown;
    return Reflect.apply(real, thisArg, args);
  },
}) as ReturnType<typeof postgres>;
