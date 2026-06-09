"use client";

/**
 * VRM ファイルをオフスクリーンで描画してサムネ PNG を生成する client-side helper。
 * アップロード時に呼んで、結果を /api/vrm/models の POST に thumb として乗せる。
 *
 * 処理:
 *   1. 一時 <canvas> + Three.js renderer (256x256, 透過 BG) を組む
 *   2. URL.createObjectURL(file) → GLTFLoader + VRMLoaderPlugin で VRM load
 *   3. VRMUtils.rotateVRM0 + 顔のあたりにカメラ → 1 frame render → canvas.toBlob('png')
 *   4. 完了後 cleanup (renderer dispose / object URL revoke)
 *
 * 設計: docs/vrm-wardrobe.md (Phase 1)
 */
import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { VRMLoaderPlugin, VRMUtils, type VRM } from "@pixiv/three-vrm";

const SIZE = 256;

export async function generateVrmThumbnail(file: File): Promise<Blob> {
  const url = URL.createObjectURL(file);
  const renderer = new THREE.WebGLRenderer({
    antialias: true,
    alpha: true,
    preserveDrawingBuffer: true, // toBlob で読み出すため
  });
  renderer.setPixelRatio(2);
  renderer.setSize(SIZE, SIZE);
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.setClearColor(0x000000, 0); // 透過

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(22, 1, 0.1, 20);
  // 顔〜胸あたりが画角に収まるよう、Y= ~1.35m, Z= ~1.0m に置く
  camera.position.set(0, 1.45, 0.8);
  camera.lookAt(0, 1.4, 0);

  // 簡易 lighting
  scene.add(new THREE.AmbientLight(0xffffff, 0.85));
  const key = new THREE.DirectionalLight(0xffffff, 0.6);
  key.position.set(1, 2, 2);
  scene.add(key);

  try {
    const loader = new GLTFLoader();
    loader.register((parser) => new VRMLoaderPlugin(parser));
    const gltf = await loader.loadAsync(url);
    const vrm = gltf.userData.vrm as VRM;
    VRMUtils.removeUnnecessaryVertices(gltf.scene);
    VRMUtils.combineSkeletons(gltf.scene);
    VRMUtils.combineMorphs(vrm);
    vrm.scene.traverse((obj) => {
      obj.frustumCulled = false;
    });
    VRMUtils.rotateVRM0(vrm);
    scene.add(vrm.scene);

    renderer.render(scene, camera);
    const canvas = renderer.domElement;
    const blob = await new Promise<Blob | null>((resolve) =>
      canvas.toBlob(resolve, "image/png")
    );
    if (!blob) throw new Error("toBlob returned null");
    return blob;
  } finally {
    renderer.dispose();
    URL.revokeObjectURL(url);
  }
}
