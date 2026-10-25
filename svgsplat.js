class SvgSplatRenderer {
  static namespace = "http://www.w3.org/2000/svg";

  constructor(svg) {
    if (!(svg instanceof SVGSVGElement)) {
      throw new TypeError("SvgSplatRenderer requires an SVG element.");
    }

    this.svg = svg;
  }

  clear() {
    this.svg.replaceChildren();
  }

  render(renderPackets) {
    this.clear();

    const background = document.createElementNS(SvgSplatRenderer.namespace, "rect");
    background.setAttribute("width", "100");
    background.setAttribute("height", "100");
    background.setAttribute("fill", "#000");

    const defs = document.createElementNS(SvgSplatRenderer.namespace, "defs");
    const gradient = document.createElementNS(SvgSplatRenderer.namespace, "radialGradient");
    gradient.id = "svg-splat-alpha";
    for (const [offset, opacity] of [["0%", "1"], ["33%", "0.61"], ["67%", "0.14"], ["100%", "0"]]) {
      const stop = document.createElementNS(SvgSplatRenderer.namespace, "stop");
      stop.setAttribute("offset", offset);
      stop.setAttribute("stop-color", "white");
      stop.setAttribute("stop-opacity", opacity);
      gradient.appendChild(stop);
    }
    const mask = document.createElementNS(SvgSplatRenderer.namespace, "mask");
    mask.id = "svg-splat-mask";
    mask.setAttribute("maskContentUnits", "objectBoundingBox");
    const maskRect = document.createElementNS(SvgSplatRenderer.namespace, "rect");
    maskRect.setAttribute("width", "1");
    maskRect.setAttribute("height", "1");
    maskRect.setAttribute("fill", "url(#svg-splat-alpha)");
    mask.appendChild(maskRect);
    defs.append(gradient, mask);

    const group = document.createElementNS(SvgSplatRenderer.namespace, "g");
    group.classList.add("svg-splat-stage");

    const depthBuckets = new Array(256);
    for (let bucket = depthBuckets.length - 1; bucket >= 0; bucket -= 1) {
      const bucketGroup = document.createElementNS(SvgSplatRenderer.namespace, "g");
      bucketGroup.classList.add("svg-depth-bucket");
      bucketGroup.dataset.depthBucket = bucket;
      depthBuckets[bucket] = bucketGroup;
      group.appendChild(bucketGroup);
    }

    for (const packet of renderPackets) {
      const ellipse = document.createElementNS(SvgSplatRenderer.namespace, "ellipse");
      ellipse.dataset.cameraDistance = packet.cameraDistance;
      ellipse.dataset.quantizedZIndex = packet.zIndex;
      ellipse.setAttribute("cx", packet.centerX);
      ellipse.setAttribute("cy", packet.centerY);
      ellipse.setAttribute("rx", packet.svgRadiusX);
      ellipse.setAttribute("ry", packet.svgRadiusY);
      ellipse.setAttribute("fill", packet.rgb);
      ellipse.setAttribute("opacity", packet.alpha);
      ellipse.setAttribute("mask", "url(#svg-splat-mask)");
      ellipse.setAttribute("transform", packet.svgTransform);
      depthBuckets[packet.svgDepthBucket].appendChild(ellipse);
    }

    this.svg.append(defs, background, group);
  }
}

window.SvgSplatRenderer = SvgSplatRenderer;
