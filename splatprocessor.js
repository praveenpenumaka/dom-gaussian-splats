class SplatProcessor {
  static prepare(splats, output = []) {
    if (!Array.isArray(splats)) {
      throw new TypeError("SplatProcessor.prepare requires an array of projected splats.");
    }
    if (!Array.isArray(output)) {
      throw new TypeError("SplatProcessor.prepare output must be an array.");
    }
    if (output === splats) {
      throw new TypeError("SplatProcessor.prepare output must not be the input array.");
    }

    for (let sourceIndex = 0; sourceIndex < splats.length; sourceIndex += 1) {
      const splat = splats[sourceIndex];
      const cameraDistance = splat.cameraDistance ?? splat.distance ?? splat.depth ?? 0;
      if (
        !Number.isFinite(cameraDistance) ||
        !Number.isFinite(splat.x) ||
        !Number.isFinite(splat.y) ||
        !Number.isFinite(splat.radiusX) ||
        !Number.isFinite(splat.radiusY) ||
        !Number.isFinite(splat.rotation)
      ) {
        throw new Error(`Projected splat ${sourceIndex} contains non-finite geometry.`);
      }
      const r = SplatProcessor.colorChannel(splat.color?.r);
      const g = SplatProcessor.colorChannel(splat.color?.g);
      const b = SplatProcessor.colorChannel(splat.color?.b);
      const alpha = SplatProcessor.clamp((splat.color?.a ?? 255) / 255, 0, 1);
      const centerX = splat.x * 100;
      const centerY = splat.y * 100;
      const rotationDegrees = splat.rotation * 180 / Math.PI;
      const rgb = `rgb(${r} ${g} ${b})`;
      const packet = output[sourceIndex] ?? {};
      output[sourceIndex] = packet;
      packet.cameraDistance = cameraDistance;
      packet.zIndex = Number.isInteger(splat.zIndex)
        ? splat.zIndex
        : 2000000000 - Math.min(1999999999, Math.max(0, Math.round(cameraDistance * 10000)));
      packet.svgDepthBucket = Math.min(255, Math.max(0, Math.floor(cameraDistance * 16)));
      packet.centerX = centerX;
      packet.centerY = centerY;
      packet.left = `${centerX}%`;
      packet.top = `${centerY}%`;
      packet.width = `max(1px, ${splat.radiusX * 200}%)`;
      packet.height = `max(1px, ${splat.radiusY * 200}%)`;
      packet.svgRadiusX = Math.max(0.1, splat.radiusX * 100);
      packet.svgRadiusY = Math.max(0.1, splat.radiusY * 100);
      packet.rotationRadians = splat.rotation;
      packet.rotationDegrees = rotationDegrees;
      packet.divTransform = `translate(-50%, -50%) rotate(${splat.rotation}rad)`;
      packet.svgTransform = `rotate(${rotationDegrees} ${centerX} ${centerY})`;
      packet.r = r;
      packet.g = g;
      packet.b = b;
      packet.rgb = rgb;
      packet.alpha = alpha;
      packet.divBackground = `radial-gradient(ellipse at center, ${rgb} 0%, rgb(${r} ${g} ${b} / 0.61) 33%, rgb(${r} ${g} ${b} / 0.14) 67%, transparent 100%)`;
    }

    output.length = splats.length;
    return output;
  }

  static colorChannel(value) {
    return Math.round(SplatProcessor.clamp(Number(value) || 0, 0, 255));
  }

  static clamp(value, minimum, maximum) {
    return Math.min(maximum, Math.max(minimum, value));
  }
}

if (typeof window !== "undefined") {
  window.SplatProcessor = SplatProcessor;
}

if (typeof module !== "undefined") {
  module.exports = { SplatProcessor };
}
