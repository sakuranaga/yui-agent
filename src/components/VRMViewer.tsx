"use client";

import { useEffect, useRef, useState } from "react";
import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import {
  VRM,
  VRMHumanBoneName,
  VRMLoaderPlugin,
  VRMUtils,
} from "@pixiv/three-vrm";
import {
  VRMAnimationLoaderPlugin,
  createVRMAnimationClip,
  VRMAnimation,
  VRMLookAtQuaternionProxy,
} from "@pixiv/three-vrm-animation";

export type VRMExpression =
  | "neutral"
  | "happy"
  | "sad"
  | "angry"
  | "relaxed"
  | "surprised";

export type AudioBridgeRef = {
  current: { analyser: AnalyserNode | null; speaking: boolean };
};

type Props = {
  expression: VRMExpression;
  /** Live audio analyser for TTS-driven lip sync. When analyser is null but
   *  speaking is true, lip sync falls back to random viseme animation. */
  audioBridge: AudioBridgeRef;
  vrmaUrl?: string;
  /** 動的 VRM URL。Phase 1 では切替時に親 (page.tsx) が key を変えて remount する想定。
   *  未指定なら従来の /girl.vrm (初回起動 / DB 未登録時の fallback) */
  vrmUrl?: string;
};

const ACTIVE_EXPRESSIONS: VRMExpression[] = [
  "happy",
  "sad",
  "angry",
  "relaxed",
  "surprised",
];
const VISEMES = ["aa", "ih", "ou", "ee", "oh"] as const;

export default function VRMViewer({
  expression,
  audioBridge,
  vrmaUrl = "/animations/idle.vrma",
  vrmUrl = "/girl.vrm",
}: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const expressionRef = useRef<VRMExpression>(expression);
  // TTS の再生 start/end を直接 CustomEvent で受け取って強制リップシンクを起動する。
  // audioBridge 経路と並行に動くので、analyser 不在や ref 共有の問題に強い (フェイルセーフ)。
  const forceLipSyncRef = useRef(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    expressionRef.current = expression;
  }, [expression]);

  useEffect(() => {
    const onStart = () => {
      forceLipSyncRef.current = true;
    };
    const onEnd = () => {
      forceLipSyncRef.current = false;
    };
    window.addEventListener("yui-lip-sync-start", onStart);
    window.addEventListener("yui-lip-sync-end", onEnd);
    return () => {
      window.removeEventListener("yui-lip-sync-start", onStart);
      window.removeEventListener("yui-lip-sync-end", onEnd);
    };
  }, []);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const width = container.clientWidth;
    const height = container.clientHeight;

    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.setSize(width, height);
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    container.appendChild(renderer.domElement);

    const scene = new THREE.Scene();

    const camera = new THREE.PerspectiveCamera(28, width / height, 0.1, 20);
    camera.position.set(0, 1.35, 2.2);

    /**
     * 右側 chat panel (width + margin) が常に画面右を占有するので、
     * avatar が「見える領域」の中央に来るよう camera を左にシフト。
     * 画面 px → world 単位:
     *   worldHeightAtCamera = 2 * z * tan(fov/2)
     *   worldOffsetX = (pxOffset / canvasHeight) * worldHeightAtCamera
     * モバイル (chat-panel が下半分) ではオフセットしない。
     */
    const CHAT_PANEL_RESERVED_PX = 380 + 16 + 16; // panel width + right margin + left margin
    const MOBILE_BREAKPOINT = 768;
    const computeAvatarOffset = (_w: number, h: number): number => {
      if (typeof window !== "undefined" && window.innerWidth <= MOBILE_BREAKPOINT) {
        return 0;
      }
      const fovRad = (camera.fov * Math.PI) / 180;
      const worldHeightAtCamera = 2 * camera.position.z * Math.tan(fovRad / 2);
      // camera を右にシフトすると視野が右にずれ、world 原点の avatar は画面の左に映る。
      // chat-panel が右の N px を覆うので、視野中心を N/2 px 分右へずらす。
      return (CHAT_PANEL_RESERVED_PX / 2) * (worldHeightAtCamera / h);
    };
    const initialOffsetX = computeAvatarOffset(width, height);
    camera.position.x = initialOffsetX;

    const controls = new OrbitControls(camera, renderer.domElement);
    controls.target.set(initialOffsetX, 1.25, 0);
    controls.enableDamping = true;
    controls.minDistance = 0.8;
    controls.maxDistance = 4;
    controls.maxPolarAngle = Math.PI * 0.55;
    controls.update();

    const hemi = new THREE.HemisphereLight(0xfff0e6, 0x202040, 1.0);
    scene.add(hemi);
    const key = new THREE.DirectionalLight(0xffffff, 1.6);
    key.position.set(1.5, 2.5, 1.5);
    scene.add(key);
    const fill = new THREE.DirectionalLight(0xa0b8ff, 0.5);
    fill.position.set(-2, 1, -1);
    scene.add(fill);

    let vrm: VRM | null = null;
    let mixer: THREE.AnimationMixer | null = null;
    let mounted = true;

    // Look-at target tracks mouse position on the canvas, with smoothing.
    const lookTarget = new THREE.Object3D();
    lookTarget.position.set(0, 1.4, 2);
    scene.add(lookTarget);
    const mouse = { x: 0, y: 0 };
    const onPointerMove = (e: PointerEvent) => {
      const rect = renderer.domElement.getBoundingClientRect();
      mouse.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
      mouse.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;
    };
    renderer.domElement.addEventListener("pointermove", onPointerMove);

    const loader = new GLTFLoader();
    loader.register((parser) => new VRMLoaderPlugin(parser));
    loader.register((parser) => new VRMAnimationLoaderPlugin(parser));

    loader.load(
      vrmUrl,
      (gltf) => {
        const loaded = gltf.userData.vrm as VRM;
        if (!mounted) {
          // unmount 後に load 完了 → gltf は既に GPU リソース (geometry/texture/material)
          // を作っているので、early return せずにここで明示 dispose する (= leak 防止)。
          VRMUtils.deepDispose(loaded.scene);
          return;
        }
        vrm = loaded;
        VRMUtils.removeUnnecessaryVertices(gltf.scene);
        VRMUtils.combineSkeletons(gltf.scene);
        VRMUtils.combineMorphs(vrm);
        vrm.scene.traverse((obj) => {
          obj.frustumCulled = false;
        });
        VRMUtils.rotateVRM0(vrm);

        // Bring arms down from T-pose. Tuned to keep hands clear of a typical
        // VRoid maid-skirt silhouette:
        //   z = ±(π/2 - 0.28) → ~16° outward from vertical (hands sit beside hips,
        //     not in front of them)
        //   y = ∓0.12        → arms drift very slightly forward of the body plane,
        //     so a profile view doesn't put the hand inside the skirt's depth
        //   lowerArm.x small forward bend keeps the elbow soft, not locked straight
        // If a different costume needs more clearance, widen z; if hands look too
        // open/akimbo, tighten z back toward π/2.
        const setPose = (
          name: VRMHumanBoneName,
          x: number,
          y: number,
          z: number
        ) => {
          const b = vrm!.humanoid.getNormalizedBoneNode(name);
          if (b) {
            b.rotation.set(x, y, z);
            b.userData.basePose = { x, y, z };
          }
        };
        setPose("leftUpperArm", 0, -0.12, -Math.PI / 2 + 0.28);
        setPose("rightUpperArm", 0, 0.12, Math.PI / 2 - 0.28);
        setPose("leftLowerArm", 0.08, -0.1, 0);
        setPose("rightLowerArm", 0.08, 0.1, 0);

        // lookAt: character now faces +Z (toward camera), so a target in +Z is "in front".
        if (vrm.lookAt) {
          vrm.lookAt.target = lookTarget;
          vrm.lookAt.autoUpdate = true;
          // VRMA animation の lookAt track が解決される時、createVRMAnimationClip が
          // VRMLookAtQuaternionProxy を scene 中から探す。先に作って置かないと
          // 「VRMLookAtQuaternionProxy is not found. Creating a new one automatically」
          // という warning が出るので明示的に追加する。
          const lookAtProxy = new VRMLookAtQuaternionProxy(vrm.lookAt);
          lookAtProxy.name = "VRMLookAtQuaternionProxy";
          vrm.scene.add(lookAtProxy);
        }

        scene.add(vrm.scene);
        setLoading(false);

        // Optional VRMA. If not present, the model stays in its natural rest pose.
        loader.load(
          vrmaUrl,
          (animGltf) => {
            if (!mounted || !vrm) return;
            const anims = animGltf.userData.vrmAnimations as
              | VRMAnimation[]
              | undefined;
            if (!anims || anims.length === 0) return;
            try {
              const clip = createVRMAnimationClip(anims[0], vrm);
              mixer = new THREE.AnimationMixer(vrm.scene);
              const action = mixer.clipAction(clip);
              action.setLoop(THREE.LoopRepeat, Infinity);
              action.play();
              if (vrm.lookAt) {
                vrm.lookAt.autoUpdate = anims[0].lookAtTrack == null;
              }
            } catch (e) {
              console.warn("VRMA clip creation failed:", e);
            }
          },
          undefined,
          () => {
            /* 404 OK */
          }
        );
      },
      undefined,
      (err) => {
        console.error("VRM load error:", err);
        setError("VRMの読み込みに失敗しました");
        setLoading(false);
      }
    );

    const clock = new THREE.Clock();
    // --- まばたき制御 (非対称: 閉じる速、開く遅、たまに二度) ---
    let blinkTimer = 0;
    let nextBlinkAt = 2.5 + Math.random() * 4;
    // blinkPhase: null = 平常時 / {t, dur} = 開閉中
    let blinkPhase: { t: number; dur: number } | null = null;
    let doubleBlinkPending = false;

    // --- 視線サッカード (target を中心点周りに微移動) ---
    // 既存 lookTarget はマウス追従中心、その上に gazeOffset を足してわずかな揺らぎを乗せる
    const gazeOffset = new THREE.Vector3();
    const gazeGoal = new THREE.Vector3();
    let gazeTimer = 0;
    let nextGazeAt = 1.5 + Math.random() * 3;

    let mouthPhase = 0;
    let mouthShape = 0;
    let mouthShapeTimer = 0;
    let nextMouthShapeAt = 0.12;
    let smoothedAmp = 0;
    const timeDomain = new Uint8Array(1024);

    let frameId = 0;
    const animate = () => {
      frameId = requestAnimationFrame(animate);
      const delta = Math.min(clock.getDelta(), 0.05);
      const t = clock.elapsedTime;

      // --- 視線: マウス追従の中心 + サッカード (微小ランダム移動) ---
      gazeTimer += delta;
      if (gazeTimer >= nextGazeAt) {
        gazeTimer = 0;
        nextGazeAt = 1.5 + Math.random() * 3; // 1.5〜4.5 秒間隔
        const a = 0.05;
        gazeGoal.set(
          (Math.random() - 0.5) * 2 * a,
          (Math.random() - 0.5) * 1.2 * a,
          0
        );
      }
      // gazeOffset を gazeGoal に滑らかに追従 (サッカードの後の固視)
      gazeOffset.lerp(gazeGoal, Math.min(1, delta * 8));

      lookTarget.position.x +=
        (mouse.x * 0.6 + gazeOffset.x - lookTarget.position.x) * 0.05;
      lookTarget.position.y +=
        (1.4 + mouse.y * 0.25 + gazeOffset.y - lookTarget.position.y) * 0.05;

      if (mixer) mixer.update(delta);

      if (vrm) {
        const TAU = Math.PI * 2;
        const humanoid = vrm.humanoid;
        if (!mixer) {
          // 周期感を消すため、各軸を 2 つの周波数の合成波で駆動。
          // 値は意図的に微小 (息づかい以上、ダンス以下)。

          // --- 呼吸: spine / chest ピッチ ---
          const breath = Math.sin(t * 0.22 * TAU);
          const spine = humanoid.getNormalizedBoneNode("spine");
          if (spine) spine.rotation.x = breath * 0.020;
          const chest = humanoid.getNormalizedBoneNode("chest");
          if (chest) chest.rotation.x = breath * 0.012;

          // --- 重心: hips をごく僅かに左右へ (2 波合成) ---
          const hips = humanoid.getNormalizedBoneNode("hips");
          if (hips) {
            const sway =
              Math.sin(t * 0.11 * TAU) * 0.7 +
              Math.sin(t * 0.11 * TAU * 0.37 + 1.7) * 0.3;
            hips.rotation.z = sway * 0.012;
          }

          // --- 頭の微動: yaw / pitch を異なる周波数で合成 ---
          const head = humanoid.getNormalizedBoneNode("head");
          if (head) {
            const yaw =
              Math.sin(t * 0.17 * TAU) * 0.6 +
              Math.sin(t * 0.17 * TAU * 0.53 + 1.3) * 0.4;
            const pitch = Math.sin(t * 0.17 * TAU * 0.41 + 2.1);
            head.rotation.y = yaw * 0.022;
            head.rotation.x = pitch * 0.011;
            head.rotation.z = Math.sin(t * 0.5) * 0.012; // 既存の小さな z 揺れも残す
          }
        }

        const expMgr = vrm.expressionManager;
        if (expMgr) {
          // --- 非対称まばたき: 閉じる方が速い、開く方は緩やか ---
          if (blinkPhase) {
            blinkPhase.t += delta;
            const p = blinkPhase.t / blinkPhase.dur;
            if (p >= 1) {
              expMgr.setValue("blink", 0);
              blinkPhase = null;
              if (doubleBlinkPending) {
                // 二度目はすぐ
                doubleBlinkPending = false;
                nextBlinkAt = 0.15 + Math.random() * 0.10;
                blinkTimer = 0;
              }
            } else {
              // 0→1→0: 前半 (閉じ) を速く、後半 (開) を緩やかに
              const w = p < 0.35 ? p / 0.35 : 1 - (p - 0.35) / 0.65;
              expMgr.setValue("blink", Math.max(0, w));
            }
          } else {
            blinkTimer += delta;
            if (blinkTimer >= nextBlinkAt) {
              blinkTimer = 0;
              nextBlinkAt = 2.5 + Math.random() * 4; // 2.5〜6.5 秒
              blinkPhase = { t: 0, dur: 0.13 + Math.random() * 0.05 };
              // ~15% の確率で二度まばたき
              if (Math.random() < 0.15) doubleBlinkPending = true;
            } else {
              expMgr.setValue("blink", 0);
            }
          }

          const curExpr = expressionRef.current;
          const bridge = audioBridge.current;
          // 発話 (or 強制 lip-sync) 判定: audioBridge 経路と CustomEvent 経路の OR。
          // CustomEvent 経路は ChatPanel の playBuffer が source.start() / onended で
          // 明示的に dispatch するので、analyser/ref 共有が壊れていてもこちらが効く。
          const speaking = bridge.speaking || forceLipSyncRef.current;
          // 発話中は表情 (happy 等) の強度を下げる。VRoid モデルの happy preset は
          // 口角・口元の morph target を含むため、満強度のままだと viseme の口パクが
          // 視覚的にほぼ見えなくなる。発話中だけ blend 余地を作る。
          const activeExpressionStrength = speaking ? 0.55 : 1;
          for (const e of ACTIVE_EXPRESSIONS) {
            const target = e === curExpr ? activeExpressionStrength : 0;
            const cur = expMgr.getValue(e) ?? 0;
            const next = cur + (target - cur) * Math.min(1, delta * 6);
            expMgr.setValue(e, next);
          }

          if (speaking) {
            // Pick a target viseme amplitude: prefer live RMS from the TTS analyser,
            // fall back to a sinusoidal mock if no audio is wired up.
            let amp = 0;
            if (bridge.analyser) {
              const a = bridge.analyser;
              const buf =
                a.fftSize === timeDomain.length
                  ? timeDomain
                  : new Uint8Array(a.fftSize);
              a.getByteTimeDomainData(buf);
              let sum = 0;
              for (let i = 0; i < buf.length; i++) {
                const v = (buf[i] - 128) / 128;
                sum += v * v;
              }
              const rms = Math.sqrt(sum / buf.length);
              amp = Math.min(1, rms * 4.5);
            } else {
              mouthPhase += delta;
              amp = 0.45 + 0.35 * Math.abs(Math.sin(mouthPhase * 9.0));
            }
            smoothedAmp += (amp - smoothedAmp) * Math.min(1, delta * 25);

            // Switch viseme shape periodically so the mouth has variation, not just
            // a single open-close pulse. Intensity is gated by the amplitude.
            mouthShapeTimer += delta;
            if (mouthShapeTimer >= nextMouthShapeAt) {
              mouthShapeTimer = 0;
              mouthShape =
                (mouthShape + 1 + Math.floor(Math.random() * 3)) %
                VISEMES.length;
              nextMouthShapeAt = 0.09 + Math.random() * 0.09;
            }
            for (let i = 0; i < VISEMES.length; i++) {
              const v = VISEMES[i];
              const target = i === mouthShape ? smoothedAmp : 0;
              const cur = expMgr.getValue(v) ?? 0;
              expMgr.setValue(
                v,
                cur + (target - cur) * Math.min(1, delta * 18)
              );
            }
          } else {
            smoothedAmp = 0;
            for (const v of VISEMES) {
              const cur = expMgr.getValue(v) ?? 0;
              expMgr.setValue(v, Math.max(0, cur - delta * 8));
            }
          }
        }

        vrm.update(delta);
      }

      controls.update();
      renderer.render(scene, camera);
    };
    animate();

    const handleResize = () => {
      if (!containerRef.current) return;
      const w = containerRef.current.clientWidth;
      const h = containerRef.current.clientHeight;
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
      renderer.setSize(w, h);
      // ウィンドウサイズに応じて avatar 中央位置を再計算
      const newOffsetX = computeAvatarOffset(w, h);
      // 現在の camera x が「自動オフセット中」なら追従。ユーザが OrbitControls で動かしてたら邪魔しない。
      // 簡易判定: 現 x が前回 offset 付近 (±0.05) なら自動追従と見做す
      const prevExpected = camera.userData.autoOffsetX ?? initialOffsetX;
      const isAutoTracking = Math.abs(camera.position.x - prevExpected) < 0.05;
      if (isAutoTracking) {
        camera.position.x = newOffsetX;
        controls.target.x = newOffsetX;
        controls.update();
        camera.userData.autoOffsetX = newOffsetX;
      }
    };
    camera.userData.autoOffsetX = initialOffsetX;
    window.addEventListener("resize", handleResize);

    const ro = new ResizeObserver(handleResize);
    ro.observe(container);

    return () => {
      mounted = false;
      cancelAnimationFrame(frameId);
      window.removeEventListener("resize", handleResize);
      ro.disconnect();
      renderer.domElement.removeEventListener("pointermove", onPointerMove);
      controls.dispose();
      mixer?.stopAllAction();
      if (vrm) {
        scene.remove(vrm.scene);
        VRMUtils.deepDispose(vrm.scene);
      }
      renderer.dispose();
      // dispose() だけでは WebGL context が即解放されない。Chrome は 16 context までしか
      // 同時保持できず、VRM 連続切替で枯渇するので明示的に loseContext を呼ぶ。
      renderer.forceContextLoss();
      if (renderer.domElement.parentElement === container) {
        container.removeChild(renderer.domElement);
      }
    };
    // audioBridge は最新値を render loop 内から参照するが、deps に入れると VRM scene が
    // 毎レンダー再構築されて口パクが切れる。意図的に固定。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [vrmaUrl, vrmUrl]);

  return (
    <>
      <div ref={containerRef} className="vrm-container" />
      {loading && !error && <div className="vrm-loading">Loading VRM...</div>}
      {error && <div className="vrm-loading">{error}</div>}
      <div className="viewer-hint">ドラッグで回転 / スクロールでズーム</div>
    </>
  );
}
