"use client";

/**
 * 秘書タブ内の VRM (お着替え) ギャラリー — Phase 1 (登録 + 手動切替)
 *
 * - 一覧: thumbnail + 名前 + 現在マーク + 編集/削除
 * - + アップロード: file picker → client side でサムネ自動レンダ → POST /api/vrm/models
 *   (multipart で vrm + thumb 同送)
 * - クリックで現モデルに切替 (POST /api/vrm/current) → window.dispatchEvent("vrm-current-changed")
 *   → page.tsx が listen して VRMViewer が新 URL でリロード
 *
 * 設計: docs/vrm-wardrobe.md (Phase 1)
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { generateVrmThumbnail } from "@/lib/vrm-thumbnail";

type VrmModel = {
  id: number;
  name: string;
  filename: string;
  thumbnail_filename: string | null;
  file_size_bytes: number;
  is_default: boolean;
  enabled: boolean;
};

export default function VrmGallerySection() {
  const [models, setModels] = useState<VrmModel[]>([]);
  const [currentId, setCurrentId] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);
  const [uploading, setUploading] = useState(false);
  const [progress, setProgress] = useState<string>("");
  const [editingId, setEditingId] = useState<number | null>(null);
  const [editName, setEditName] = useState("");
  const fileInputRef = useRef<HTMLInputElement>(null);
  const thumbInputRef = useRef<HTMLInputElement>(null);
  const [thumbTargetId, setThumbTargetId] = useState<number | null>(null);

  const reload = useCallback(async () => {
    setLoading(true);
    try {
      const [mRes, cRes] = await Promise.all([
        fetch("/api/vrm/models", { cache: "no-store" }),
        fetch("/api/vrm/current", { cache: "no-store" }),
      ]);
      const mJson = (await mRes.json()) as { models: VrmModel[] };
      const cJson = (await cRes.json()) as { model: { id: number } | null };
      setModels(mJson.models);
      setCurrentId(cJson.model?.id ?? null);
    } catch (e) {
      console.warn("[vrm-gallery] load failed:", e);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    // 初回 mount + reload 関数更新時に再 fetch。
    // eslint-disable-next-line react-hooks/set-state-in-effect -- on-mount fetch
    void reload();
  }, [reload]);

  const handleUpload = async (file: File) => {
    // サーバの MAX_VRM_BYTES (= 60MB) と揃えた事前チェック。アップロード前に即フィードバック。
    const MAX_VRM_MB = 60;
    if (file.size > MAX_VRM_MB * 1024 * 1024) {
      alert(
        `VRM が大きすぎます (${(file.size / 1024 / 1024).toFixed(1)}MB)。${MAX_VRM_MB}MB までにしてください。`
      );
      if (fileInputRef.current) fileInputRef.current.value = "";
      return;
    }
    setUploading(true);
    setProgress("サムネ生成中…");
    try {
      let thumb: Blob | null = null;
      try {
        thumb = await generateVrmThumbnail(file);
      } catch (e) {
        console.warn("[vrm-gallery] thumb gen failed, continuing without:", e);
      }
      setProgress("アップロード中…");
      const form = new FormData();
      form.append("file", file);
      form.append("name", file.name.replace(/\.[^.]+$/, ""));
      if (thumb) form.append("thumb", thumb, `${file.name}.png`);
      const res = await fetch("/api/vrm/models", { method: "POST", body: form });
      if (!res.ok) {
        // サーバの { error } を取り出してそのまま見せる (= 413 のサイズ超過メッセージ等)。
        let msg = `アップロードに失敗しました (${res.status})`;
        try {
          const j = (await res.json()) as { error?: string };
          if (j?.error) msg = j.error;
        } catch {
          /* JSON でなければ status のみ */
        }
        throw new Error(msg);
      }
      await reload();
    } catch (e) {
      console.error("[vrm-gallery] upload failed:", e);
      alert(`アップロード失敗: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setUploading(false);
      setProgress("");
      if (fileInputRef.current) fileInputRef.current.value = "";
    }
  };

  const handleSwitch = async (id: number) => {
    try {
      const res = await fetch("/api/vrm/current", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ modelId: id }),
      });
      if (!res.ok) throw new Error(`status ${res.status}`);
      setCurrentId(id);
      // page.tsx が listen して VRMViewer を再ロード
      window.dispatchEvent(new CustomEvent("vrm-current-changed"));
    } catch (e) {
      console.error("[vrm-gallery] switch failed:", e);
    }
  };

  const handleRename = async (id: number) => {
    const t = editName.trim();
    if (!t) {
      setEditingId(null);
      return;
    }
    try {
      const res = await fetch(`/api/vrm/models/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: t }),
      });
      if (!res.ok) throw new Error(`status ${res.status}`);
      setEditingId(null);
      await reload();
    } catch (e) {
      console.warn("[vrm-gallery] rename failed:", e);
    }
  };

  const handleDefault = async (id: number) => {
    try {
      await fetch(`/api/vrm/models/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ isDefault: true }),
      });
      await reload();
    } catch (e) {
      console.warn("[vrm-gallery] default set failed:", e);
    }
  };

  const handleDelete = async (id: number, name: string) => {
    if (!confirm(`「${name}」を削除しますか?`)) return;
    try {
      await fetch(`/api/vrm/models/${id}`, { method: "DELETE" });
      if (currentId === id) {
        setCurrentId(null);
        window.dispatchEvent(new CustomEvent("vrm-current-changed"));
      }
      await reload();
    } catch (e) {
      console.warn("[vrm-gallery] delete failed:", e);
    }
  };

  const handleThumbReplace = async (id: number, file: File) => {
    try {
      const form = new FormData();
      form.append("thumb", file);
      const res = await fetch(`/api/vrm/models/${id}/thumb`, {
        method: "PUT",
        body: form,
      });
      if (!res.ok) throw new Error(`status ${res.status}`);
      await reload();
    } catch (e) {
      console.warn("[vrm-gallery] thumb replace failed:", e);
    }
  };

  return (
    <section className="settings-section vrm-gallery">
      <h3 className="settings-section-title">お着替え (VRM モデル)</h3>
      <p className="settings-section-hint">
        複数の VRM を登録して、カードをクリックで瞬時切替できます。未登録時は内蔵の girl.vrm にフォールバック。
      </p>

      <div className="vrm-gallery-grid">
        {loading ? (
          <div className="vrm-gallery-loading">読み込み中…</div>
        ) : (
          <>
            {models.map((m) => {
              const isCurrent = m.id === currentId;
              const isEditing = editingId === m.id;
              return (
                <div
                  key={m.id}
                  className={`vrm-card ${isCurrent ? "is-current" : ""}`}
                >
                  <button
                    type="button"
                    className="vrm-card-thumb"
                    onClick={() => handleSwitch(m.id)}
                    title={isCurrent ? "現在の秘書" : "この秘書に切替"}
                  >
                    {m.thumbnail_filename ? (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img
                        src={`/api/vrm/models/${m.id}/thumb`}
                        alt={m.name}
                      />
                    ) : (
                      <div className="vrm-card-thumb-placeholder">
                        サムネなし
                      </div>
                    )}
                    {isCurrent && <span className="vrm-card-current-badge">現在</span>}
                  </button>
                  <div className="vrm-card-body">
                    {isEditing ? (
                      <input
                        name="vrm-gallery-name"
                        type="text"
                        className="vrm-card-name-edit"
                        value={editName}
                        autoFocus
                        onChange={(e) => setEditName(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === "Enter") void handleRename(m.id);
                          if (e.key === "Escape") setEditingId(null);
                        }}
                        onBlur={() => void handleRename(m.id)}
                      />
                    ) : (
                      <button
                        type="button"
                        className="vrm-card-name"
                        onClick={() => {
                          setEditingId(m.id);
                          setEditName(m.name);
                        }}
                        title="クリックで名前を編集"
                      >
                        {m.name}
                        {m.is_default && <span className="vrm-card-default-mark">既定</span>}
                      </button>
                    )}
                    <div className="vrm-card-meta">
                      {(m.file_size_bytes / 1024 / 1024).toFixed(1)} MB
                    </div>
                    <div className="vrm-card-actions">
                      {!m.is_default && (
                        <button
                          type="button"
                          className="vrm-mini-btn"
                          onClick={() => void handleDefault(m.id)}
                          title="起動時 / fallback 用の既定モデルに設定"
                        >
                          既定に
                        </button>
                      )}
                      <button
                        type="button"
                        className="vrm-mini-btn"
                        onClick={() => {
                          setThumbTargetId(m.id);
                          thumbInputRef.current?.click();
                        }}
                      >
                        サムネ差替
                      </button>
                      <button
                        type="button"
                        className="vrm-mini-btn vrm-mini-btn-danger"
                        onClick={() => void handleDelete(m.id, m.name)}
                      >
                        削除
                      </button>
                    </div>
                  </div>
                </div>
              );
            })}
            <button
              type="button"
              className="vrm-card vrm-card-add"
              onClick={() => fileInputRef.current?.click()}
              disabled={uploading}
            >
              <div className="vrm-card-add-icon">+</div>
              <div className="vrm-card-add-label">
                {uploading ? progress || "アップロード中…" : "VRM を追加"}
              </div>
            </button>
          </>
        )}
      </div>

      <input
        ref={fileInputRef}
        type="file"
        accept=".vrm,model/gltf-binary"
        style={{ display: "none" }}
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) void handleUpload(f);
        }}
      />
      <input
        ref={thumbInputRef}
        type="file"
        accept="image/png,image/jpeg,image/webp"
        style={{ display: "none" }}
        onChange={(e) => {
          const f = e.target.files?.[0];
          const id = thumbTargetId;
          if (f && id !== null) void handleThumbReplace(id, f);
          if (thumbInputRef.current) thumbInputRef.current.value = "";
          setThumbTargetId(null);
        }}
      />
    </section>
  );
}
