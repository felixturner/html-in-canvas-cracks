import * as THREE from 'three/webgpu';
import { texture, uv, vec2, vec4, float, oneMinus, pow } from 'three/tsl';

/**
 * Compositor that blends a foreground RT over a background RT using the
 * foreground's alpha channel as a mask. Output goes to the current render
 * target (null = screen).
 *
 * Call `render(renderer)` after both RTs have been populated for the frame.
 * `dispose()` releases GPU resources.
 */
export function createCompositor(bgRT, fgRT) {
  const scene = new THREE.Scene();
  const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);

  // RT-sampled textures are Y-flipped in WebGPU; flip V when reading.
  const flippedUv = vec2(uv().x, float(1).sub(uv().y));
  const bg = texture(bgRT.texture, flippedUv);
  const fg = texture(fgRT.texture, flippedUv);

  const mat = new THREE.MeshBasicNodeMaterial({
    depthTest: false,
    depthWrite: false,
    toneMapped: false,
  });
  // fg is stored premultiplied (default alpha blending). Porter-Duff "over":
  //   result = bg * (1 - fg.a) + fg.rgb
  // Both RTs are linear; renderer auto-applies sRGB encode on write to screen.
  mat.colorNode = vec4(bg.rgb.mul(oneMinus(fg.a)).add(fg.rgb), 1);

  const quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), mat);
  quad.frustumCulled = false;
  scene.add(quad);

  return {
    render(renderer) {
      renderer.render(scene, camera);
    },
    dispose() {
      quad.geometry.dispose();
      mat.dispose();
    },
  };
}
