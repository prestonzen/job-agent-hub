// WebGL identity normalization: the container has no GPU, so Chrome reports the
// SwiftShader software renderer - an instant automation flag to reCAPTCHA/Turnstile.
// Report a common real-GPU string instead (constant per agent profile = stable machine).
// Pixel output still comes from SwiftShader; no consumer anti-bot compares the two.
(() => {
  window.__glspoof = true;
  const VENDOR = "Google Inc. (Intel)";
  const RENDERER = "ANGLE (Intel, Mesa Intel(R) UHD Graphics 630 (CFL GT2), OpenGL 4.6 (Core Profile) Mesa 23.2.1-1ubuntu3.1~22.04.3)";
  const patch = (proto) => {
    if (!proto) return;
    const getParameter = proto.getParameter;
    proto.getParameter = function (p) {
      if (p === 0x9245) return VENDOR;    // UNMASKED_VENDOR_WEBGL
      if (p === 0x9246) return RENDERER;  // UNMASKED_RENDERER_WEBGL
      return getParameter.call(this, p);
    };
    const getExtension = proto.getExtension;
    proto.getExtension = function (name) {
      if (name === "WEBGL_debug_renderer_info") {
        return { UNMASKED_VENDOR_WEBGL: 0x9245, UNMASKED_RENDERER_WEBGL: 0x9246 };
      }
      return getExtension.call(this, name);
    };
  };
  patch(window.WebGLRenderingContext && window.WebGLRenderingContext.prototype);
  patch(window.WebGL2RenderingContext && window.WebGL2RenderingContext.prototype);
})();
