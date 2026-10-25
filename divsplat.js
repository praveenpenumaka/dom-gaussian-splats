class DivSplatRenderer {
  constructor(container) {
    if (!(container instanceof HTMLDivElement)) {
      throw new TypeError("DivSplatRenderer requires a div container.");
    }

    this.container = container;
    this.stage = null;
    this.elements = [];
  }

  clear() {
    this.container.replaceChildren();
    this.stage = null;
    this.elements.length = 0;
  }

  createStage() {
    const stage = document.createElement("div");
    stage.className = "div-splat-stage";
    stage.setAttribute("aria-hidden", "true");
    stage.style.cssText = `
      position: absolute;
      inset: 0;
      overflow: visible;
      background: #000;
    `;
    this.container.appendChild(stage);
    this.stage = stage;
    return stage;
  }

  createSplatElement() {
    const element = document.createElement("div");
    element.style.position = "absolute";
    element.style.borderRadius = "50%";
    element.style.pointerEvents = "none";
    return element;
  }

  render(renderPackets) {
    if (!Array.isArray(renderPackets)) {
      throw new TypeError("DivSplatRenderer.render requires an array of render packets.");
    }

    const stage = this.stage ?? this.createStage();

    if (this.elements.length < renderPackets.length) {
      const fragment = document.createDocumentFragment();
      for (let index = this.elements.length; index < renderPackets.length; index += 1) {
        const element = this.createSplatElement();
        this.elements.push(element);
        fragment.appendChild(element);
      }
      stage.appendChild(fragment);
    } else if (this.elements.length > renderPackets.length) {
      for (let index = this.elements.length - 1; index >= renderPackets.length; index -= 1) {
        this.elements[index].remove();
      }
      this.elements.length = renderPackets.length;
    }

    for (let index = 0; index < renderPackets.length; index += 1) {
      const packet = renderPackets[index];
      const element = this.elements[index];
      element.dataset.cameraDistance = packet.cameraDistance;
      element.style.zIndex = packet.zIndex;
      element.style.left = packet.left;
      element.style.top = packet.top;
      element.style.width = packet.width;
      element.style.height = packet.height;
      element.style.transform = packet.divTransform;
      element.style.background = packet.divBackground;
      element.style.opacity = packet.alpha;
    }
  }
}

window.DivSplatRenderer = DivSplatRenderer;
