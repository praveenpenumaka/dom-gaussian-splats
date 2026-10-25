class WebGpuSplatProcessor {
  static floatsPerInput = 12;
  static floatsPerOutput = 8;
  static workgroupSize = 64;
  static pipelineDepth = 3;

  static async create() {
    if (typeof navigator === "undefined" || !navigator.gpu) {
      throw new Error("WebGPU is unavailable. Use HTTPS, localhost, or a browser development override for this origin.");
    }
    const initializationStart = performance.now();
    const adapter = await navigator.gpu.requestAdapter({ powerPreference: "high-performance" });
    if (!adapter) throw new Error("No WebGPU adapter is available.");
    const device = await adapter.requestDevice();
    const processor = new WebGpuSplatProcessor(adapter, device);
    await processor.initializePipeline();
    processor.initializationDuration = performance.now() - initializationStart;
    return processor;
  }

  constructor(adapter, device) {
    this.adapter = adapter;
    this.device = device;
    this.pipeline = null;
    this.sampleResources = new WeakMap();
    this.initializationDuration = 0;
    this.lastTimings = { upload: 0, submit: 0, readback: 0, decode: 0 };
    this.operationQueue = Promise.resolve();
    this.lostReason = null;
    device.lost.then((info) => {
      this.lostReason = info.message || info.reason || "WebGPU device lost.";
    });
  }

  async initializePipeline() {
    const shaderModule = this.device.createShaderModule({
      label: "Gaussian projection compute shader",
      code: `
        struct GaussianInput {
          position: vec4f,
          covariance0: vec4f,
          covariance1: vec4f,
        }
        struct GaussianOutput {
          projection: vec4f,
          ellipse: vec4f,
        }
        struct ProjectionUniforms {
          cameraPosition: vec4f,
          cameraRight: vec4f,
          cameraUp: vec4f,
          cameraForward: vec4f,
          parameters: vec4f,
        }
        @group(0) @binding(0) var<storage, read> inputs: array<GaussianInput>;
        @group(0) @binding(1) var<storage, read_write> outputs: array<GaussianOutput>;
        @group(0) @binding(2) var<uniform> uniforms: ProjectionUniforms;

        fn finiteFloat(value: f32) -> bool {
          return value == value && abs(value) < 3.402823e38;
        }
        fn covarianceBilinear(leftVector: vec3f, rightVector: vec3f, gaussian: GaussianInput) -> f32 {
          let multiplied = vec3f(
            gaussian.covariance0.x * rightVector.x + gaussian.covariance0.y * rightVector.y + gaussian.covariance0.z * rightVector.z,
            gaussian.covariance0.y * rightVector.x + gaussian.covariance1.x * rightVector.y + gaussian.covariance1.y * rightVector.z,
            gaussian.covariance0.z * rightVector.x + gaussian.covariance1.y * rightVector.y + gaussian.covariance1.z * rightVector.z
          );
          return dot(leftVector, multiplied);
        }

        @compute @workgroup_size(${WebGpuSplatProcessor.workgroupSize})
        fn main(@builtin(global_invocation_id) globalId: vec3u) {
          let index = globalId.x;
          if (f32(index) >= uniforms.parameters.w) { return; }
          let gaussian = inputs[index];
          let cameraPosition = uniforms.cameraPosition.xyz;
          let cameraRight = uniforms.cameraRight.xyz;
          let cameraUp = uniforms.cameraUp.xyz;
          let cameraForward = uniforms.cameraForward.xyz;
          let focalLength = uniforms.parameters.x;
          let nearPlane = uniforms.parameters.y;
          let sigmaExtent = uniforms.parameters.z;
          let relativePosition = gaussian.position.xyz - cameraPosition;
          let cameraPoint = vec3f(
            dot(relativePosition, cameraRight),
            dot(relativePosition, cameraUp),
            dot(relativePosition, cameraForward)
          );
          let depth = cameraPoint.z;
          if (!finiteFloat(depth) || depth <= nearPlane) {
            outputs[index].projection = vec4f(0.0);
            outputs[index].ellipse = vec4f(0.0);
            return;
          }
          let inverseDepth = 1.0 / depth;
          let inverseDepthSquared = inverseDepth * inverseDepth;
          let projectionScale = focalLength * inverseDepth;
          let horizontalDepthScale = focalLength * cameraPoint.x * inverseDepthSquared;
          let verticalDepthScale = focalLength * cameraPoint.y * inverseDepthSquared;
          let jacobianX = projectionScale * cameraRight - horizontalDepthScale * cameraForward;
          let jacobianY = -projectionScale * cameraUp + verticalDepthScale * cameraForward;
          let covarianceXX = covarianceBilinear(jacobianX, jacobianX, gaussian);
          let covarianceXY = covarianceBilinear(jacobianX, jacobianY, gaussian);
          let covarianceYY = covarianceBilinear(jacobianY, jacobianY, gaussian);
          let trace = covarianceXX + covarianceYY;
          let difference = covarianceXX - covarianceYY;
          let discriminant = sqrt(max(0.0, difference * difference + 4.0 * covarianceXY * covarianceXY));
          let radiusX = sigmaExtent * sqrt(max(0.0, 0.5 * (trace + discriminant)));
          let radiusY = sigmaExtent * sqrt(max(0.0, 0.5 * (trace - discriminant)));
          let rotation = 0.5 * atan2(2.0 * covarianceXY, difference);
          let projected = vec2f(
            0.5 + focalLength * cameraPoint.x * inverseDepth,
            0.5 - focalLength * cameraPoint.y * inverseDepth
          );
          let cameraDistance = length(relativePosition);
          let valid = finiteFloat(projected.x) && finiteFloat(projected.y)
            && finiteFloat(radiusX) && finiteFloat(radiusY)
            && finiteFloat(rotation) && finiteFloat(cameraDistance);
          if (valid) {
            outputs[index].projection = vec4f(projected, depth, cameraDistance);
            outputs[index].ellipse = vec4f(radiusX, radiusY, rotation, 1.0);
          } else {
            outputs[index].projection = vec4f(0.0);
            outputs[index].ellipse = vec4f(0.0);
          }
        }
      `
    });
    const compilation = await shaderModule.getCompilationInfo();
    const errors = compilation.messages.filter(({ type }) => type === "error");
    if (errors.length > 0) {
      throw new Error(`Unable to compile WebGPU projection shader: ${errors.map(({ message }) => message).join("; ")}`);
    }
    this.device.pushErrorScope("validation");
    this.pipeline = this.device.createComputePipeline({
      label: "Gaussian projection pipeline",
      layout: "auto",
      compute: { module: shaderModule, entryPoint: "main" }
    });
    const validationError = await this.device.popErrorScope();
    if (validationError) throw new Error(`Unable to create WebGPU projection pipeline: ${validationError.message}`);
  }

  ensureSample(points) {
    const cached = this.sampleResources.get(points);
    if (cached) return { resource: cached, uploadDuration: 0 };
    const uploadStart = performance.now();
    const inputByteLength = points.length * WebGpuSplatProcessor.floatsPerInput * 4;
    const outputByteLength = points.length * WebGpuSplatProcessor.floatsPerOutput * 4;
    const inputBuffer = this.device.createBuffer({
      label: "Cached Gaussian positions and covariances",
      size: inputByteLength,
      usage: GPUBufferUsage.STORAGE,
      mappedAtCreation: true
    });
    const packed = new Float32Array(inputBuffer.getMappedRange());
    for (let index = 0; index < points.length; index += 1) {
      const point = points[index];
      const position = point.centeredPosition ?? point.position;
      const covariance = point.covariance;
      const offset = index * WebGpuSplatProcessor.floatsPerInput;
      packed[offset] = position.x;
      packed[offset + 1] = position.y;
      packed[offset + 2] = position.z;
      packed[offset + 4] = covariance.cxx;
      packed[offset + 5] = covariance.cxy;
      packed[offset + 6] = covariance.cxz;
      packed[offset + 8] = covariance.cyy;
      packed[offset + 9] = covariance.cyz;
      packed[offset + 10] = covariance.czz;
    }
    inputBuffer.unmap();
    const slots = Array.from({ length: WebGpuSplatProcessor.pipelineDepth }, (_, index) => {
      const outputBuffer = this.device.createBuffer({
        label: `Gaussian projection output ${index + 1}`,
        size: outputByteLength,
        usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC
      });
      const readbackBuffer = this.device.createBuffer({
        label: `Gaussian projection readback ${index + 1}`,
        size: outputByteLength,
        usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ
      });
      const uniformBuffer = this.device.createBuffer({
        label: `Gaussian projection uniforms ${index + 1}`,
        size: 20 * Float32Array.BYTES_PER_ELEMENT,
        usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST
      });
      const bindGroup = this.device.createBindGroup({
        label: `Gaussian projection bindings ${index + 1}`,
        layout: this.pipeline.getBindGroupLayout(0),
        entries: [
          { binding: 0, resource: { buffer: inputBuffer } },
          { binding: 1, resource: { buffer: outputBuffer } },
          { binding: 2, resource: { buffer: uniformBuffer } }
        ]
      });
      return {
        index,
        busy: false,
        completion: null,
        output: [],
        outputBuffer,
        readbackBuffer,
        uniformBuffer,
        bindGroup
      };
    });
    const resource = {
      count: points.length,
      outputByteLength,
      inputBuffer,
      slots
    };
    this.sampleResources.set(points, resource);
    return { resource, uploadDuration: performance.now() - uploadStart };
  }

  project(points, options = {}) {
    const operation = () => this.projectInternal(points, options);
    const result = this.operationQueue.then(operation, operation);
    this.operationQueue = result.then(() => undefined, () => undefined);
    return result;
  }

  tryProject(points, options = {}) {
    if (!Array.isArray(points)) {
      throw new TypeError("WebGPU projection requires a point array.");
    }
    if (!options.cameraPosition) {
      throw new TypeError("WebGPU projection requires cameraPosition.");
    }
    if (this.lostReason) throw new Error(this.lostReason);
    if (points.length === 0) {
      return Promise.resolve({
        points: [],
        timings: { upload: 0, submit: 0, readback: 0, decode: 0 },
        slotIndex: -1
      });
    }

    const { resource, uploadDuration } = this.ensureSample(points);
    const slot = resource.slots.find((candidate) => !candidate.busy);
    if (!slot) return null;
    slot.busy = true;
    const completion = this.projectInSlot(points, options, resource, slot, uploadDuration)
      .finally(() => {
        slot.busy = false;
        slot.completion = null;
      });
    slot.completion = completion;
    return completion;
  }

  async projectInternal(points, {
    cameraPosition,
    target = { x: 0, y: 0, z: 0 },
    worldUp = { x: 0, y: 1, z: 0 },
    fieldOfView = 50,
    near = 0.01,
    output = []
  } = {}) {
    if (!Array.isArray(points) || !Array.isArray(output)) {
      throw new TypeError("WebGPU projection requires point and output arrays.");
    }
    if (!cameraPosition) throw new TypeError("WebGPU projection requires cameraPosition.");
    if (this.lostReason) throw new Error(this.lostReason);
    if (points.length === 0) {
      output.length = 0;
      return output;
    }
    let completion = this.tryProject(points, {
      cameraPosition,
      target,
      worldUp,
      fieldOfView,
      near,
      output
    });
    const { resource } = this.ensureSample(points);
    while (!completion) {
      const active = resource.slots
        .filter((slot) => slot.busy && slot.completion)
        .map((slot) => slot.completion.catch(() => undefined));
      if (active.length === 0) throw new Error("WebGPU projection pipeline has no available slot.");
      await Promise.race(active);
      completion = this.tryProject(points, {
        cameraPosition,
        target,
        worldUp,
        fieldOfView,
        near,
        output
      });
    }
    const result = await completion;
    this.lastTimings = result.timings;
    return result.points;
  }

  async projectInSlot(points, {
    cameraPosition,
    target = { x: 0, y: 0, z: 0 },
    worldUp = { x: 0, y: 1, z: 0 },
    fieldOfView = 50,
    near = 0.01,
    output = null
  }, resource, slot, uploadDuration) {
    const projectedOutput = output ?? slot.output;
    const forward = SplatReader.normalizeVector({
      x: target.x - cameraPosition.x,
      y: target.y - cameraPosition.y,
      z: target.z - cameraPosition.z
    });
    const right = SplatReader.normalizeVector(SplatReader.cross(forward, worldUp));
    const cameraUp = SplatReader.normalizeVector(SplatReader.cross(right, forward));
    const focalLength = 0.5 / Math.tan(fieldOfView * Math.PI / 360);
    const uniforms = new Float32Array(20);
    uniforms.set([cameraPosition.x, cameraPosition.y, cameraPosition.z], 0);
    uniforms.set([right.x, right.y, right.z], 4);
    uniforms.set([cameraUp.x, cameraUp.y, cameraUp.z], 8);
    uniforms.set([forward.x, forward.y, forward.z], 12);
    uniforms.set([focalLength, near, 3, points.length], 16);
    this.device.queue.writeBuffer(slot.uniformBuffer, 0, uniforms);

    const submitStart = performance.now();
    const encoder = this.device.createCommandEncoder({ label: "Gaussian projection commands" });
    const pass = encoder.beginComputePass({ label: "Gaussian projection pass" });
    pass.setPipeline(this.pipeline);
    pass.setBindGroup(0, slot.bindGroup);
    pass.dispatchWorkgroups(Math.ceil(points.length / WebGpuSplatProcessor.workgroupSize));
    pass.end();
    encoder.copyBufferToBuffer(
      slot.outputBuffer,
      0,
      slot.readbackBuffer,
      0,
      resource.outputByteLength
    );
    this.device.queue.submit([encoder.finish()]);
    const submitDuration = performance.now() - submitStart;
    const readbackStart = performance.now();
    await slot.readbackBuffer.mapAsync(GPUMapMode.READ);
    const readbackDuration = performance.now() - readbackStart;
    const readback = new Float32Array(slot.readbackBuffer.getMappedRange());
    const decodeStart = performance.now();
    let outputIndex = 0;
    try {
      for (let inputIndex = 0; inputIndex < resource.count; inputIndex += 1) {
        const offset = inputIndex * WebGpuSplatProcessor.floatsPerOutput;
        if (readback[offset + 7] < 0.5) continue;
        const cameraDistance = readback[offset + 3];
        const projected = projectedOutput[outputIndex] ?? {};
        projected.inputIndex = inputIndex;
        projected.x = readback[offset];
        projected.y = readback[offset + 1];
        projected.depth = readback[offset + 2];
        projected.cameraDistance = cameraDistance;
        projected.zIndex = SplatReader.quantizeDistanceZIndex(cameraDistance);
        projected.color = points[inputIndex].color;
        projected.radiusX = readback[offset + 4];
        projected.radiusY = readback[offset + 5];
        projected.rotation = readback[offset + 6];
        projectedOutput[outputIndex] = projected;
        outputIndex += 1;
      }
      projectedOutput.length = outputIndex;
    } finally {
      slot.readbackBuffer.unmap();
    }
    const decodeDuration = performance.now() - decodeStart;
    const timings = {
      upload: uploadDuration,
      submit: submitDuration,
      readback: readbackDuration,
      decode: decodeDuration
    };
    return { points: projectedOutput, timings, slotIndex: slot.index };
  }
}

if (typeof window !== "undefined") window.WebGpuSplatProcessor = WebGpuSplatProcessor;
if (typeof module !== "undefined") module.exports = { WebGpuSplatProcessor };
