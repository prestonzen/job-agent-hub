// WebGL identity normalization: the container has no GPU, so Chrome reports the
// SwiftShader software renderer — an instant automation flag to reCAPTCHA/Turnstile.
// Report a common real-GPU string instead (constant per agent profile = stable machine).
// Pixel output still comes from SwiftShader; no consumer anti-bot compares the two.
(() => {
  const VENDOR = "Google Inc. (NVIDIA)";
  const RENDERER = "ANGLE (NVIDIA, NVIDIA GeForce RTX 3060/PCIe/SSE2, OpenGL 4.5.0 NVIDIA 535.154.05)";
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
