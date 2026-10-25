class PlyReader {
  static typeReaders = {
    char: { size: 1, read: (view, offset) => view.getInt8(offset) },
    int8: { size: 1, read: (view, offset) => view.getInt8(offset) },
    uchar: { size: 1, read: (view, offset) => view.getUint8(offset) },
    uint8: { size: 1, read: (view, offset) => view.getUint8(offset) },
    short: { size: 2, read: (view, offset) => view.getInt16(offset, true) },
    int16: { size: 2, read: (view, offset) => view.getInt16(offset, true) },
    ushort: { size: 2, read: (view, offset) => view.getUint16(offset, true) },
    uint16: { size: 2, read: (view, offset) => view.getUint16(offset, true) },
    int: { size: 4, read: (view, offset) => view.getInt32(offset, true) },
    int32: { size: 4, read: (view, offset) => view.getInt32(offset, true) },
    uint: { size: 4, read: (view, offset) => view.getUint32(offset, true) },
    uint32: { size: 4, read: (view, offset) => view.getUint32(offset, true) },
    float: { size: 4, read: (view, offset) => view.getFloat32(offset, true) },
    float32: { size: 4, read: (view, offset) => view.getFloat32(offset, true) },
    double: { size: 8, read: (view, offset) => view.getFloat64(offset, true) },
    float64: { size: 8, read: (view, offset) => view.getFloat64(offset, true) }
  };

  static async load(url, options = {}) {
    const response = await fetch(url);

    if (!response.ok) {
      throw new Error(`Unable to load ${url}: ${response.status} ${response.statusText}`);
    }

    return PlyReader.parse(await response.arrayBuffer(), options);
  }

  static parse(buffer, options = {}) {
    return PlyReader.sample(PlyReader.parseModel(buffer), options);
  }

  static parseModel(buffer) {
    if (!(buffer instanceof ArrayBuffer)) {
      throw new TypeError("PlyReader.parseModel requires an ArrayBuffer.");
    }

    const { dataOffset, elements, format, comments, objInfo } = PlyReader.parseHeader(buffer);
    if (format !== "binary_little_endian") {
      throw new Error(`Unsupported PLY format: ${format}. Expected binary_little_endian.`);
    }

    const vertexIndex = elements.findIndex(({ name }) => name === "vertex");
    if (vertexIndex < 0) {
      throw new Error("PLY has no vertex element.");
    }

    let vertexDataOffset = dataOffset;
    for (let index = 0; index < vertexIndex; index += 1) {
      const element = elements[index];
      const stride = PlyReader.elementStride(element);
      vertexDataOffset += element.count * stride;
    }

    const vertex = elements[vertexIndex];
    const stride = PlyReader.elementStride(vertex);
    const properties = new Map();
    let propertyOffset = 0;
    for (const property of vertex.properties) {
      if (property.list) {
        throw new Error("List properties are not supported in the vertex element.");
      }
      const type = PlyReader.typeReaders[property.type];
      properties.set(property.name, { offset: propertyOffset, ...type });
      propertyOffset += type.size;
    }

    const required = [
      "x", "y", "z",
      "f_dc_0", "f_dc_1", "f_dc_2",
      ...Array.from({ length: 45 }, (_, index) => `f_rest_${index}`),
      "opacity",
      "scale_0", "scale_1", "scale_2",
      "rot_0", "rot_1", "rot_2", "rot_3"
    ];
    const missing = required.filter((name) => !properties.has(name));
    if (missing.length > 0) {
      throw new Error(`Not a standard 3DGS PLY; missing properties: ${missing.join(", ")}`);
    }

    const byteLength = vertex.count * stride;
    if (vertexDataOffset + byteLength > buffer.byteLength) {
      throw new Error("PLY vertex data is truncated.");
    }

    const view = new DataView(buffer);
    const read = (base, name) => {
      const property = properties.get(name);
      return property.read(view, base + property.offset);
    };
    const positions = new Float32Array(vertex.count * 3);
    const scales = new Float32Array(vertex.count * 3);
    const rotations = new Float32Array(vertex.count * 4);
    const alphas = new Uint8Array(vertex.count);
    const sphericalHarmonics = new Float32Array(vertex.count * 48);

    for (let sourceIndex = 0; sourceIndex < vertex.count; sourceIndex += 1) {
      const base = vertexDataOffset + sourceIndex * stride;
      const positionOffset = sourceIndex * 3;
      positions[positionOffset] = read(base, "x");
      positions[positionOffset + 1] = read(base, "y");
      positions[positionOffset + 2] = read(base, "z");
      scales[positionOffset] = Math.exp(read(base, "scale_0"));
      scales[positionOffset + 1] = Math.exp(read(base, "scale_1"));
      scales[positionOffset + 2] = Math.exp(read(base, "scale_2"));

      const shOffset = sourceIndex * 48;
      for (let channel = 0; channel < 3; channel += 1) {
        const channelOffset = shOffset + channel * 16;
        sphericalHarmonics[channelOffset] = read(base, `f_dc_${channel}`);
        for (let coefficient = 0; coefficient < 15; coefficient += 1) {
          sphericalHarmonics[channelOffset + coefficient + 1] = read(
            base,
            `f_rest_${channel * 15 + coefficient}`
          );
        }
      }

      let w = read(base, "rot_0");
      let x = read(base, "rot_1");
      let y = read(base, "rot_2");
      let z = read(base, "rot_3");
      const quaternionLength = Math.hypot(w, x, y, z) || 1;
      w /= quaternionLength;
      x /= quaternionLength;
      y /= quaternionLength;
      z /= quaternionLength;
      const rotationOffset = sourceIndex * 4;
      rotations[rotationOffset] = w;
      rotations[rotationOffset + 1] = x;
      rotations[rotationOffset + 2] = y;
      rotations[rotationOffset + 3] = z;
      alphas[sourceIndex] = Math.round(255 * PlyReader.sigmoid(read(base, "opacity")));
    }

    return {
      sourceCount: vertex.count,
      positions,
      scales,
      rotations,
      alphas,
      sphericalHarmonics,
      metadata: {
        comments,
        objInfo,
        upAxis: PlyReader.findDeclaredAxis(comments, objInfo, /(?:vertical|up)\s+axis\s*:\s*([+-]?\s*[xyz])/i),
        frontAxis: PlyReader.findDeclaredAxis(comments, objInfo, /(?:front|forward)\s+axis\s*:\s*([+-]?\s*[xyz])/i)
      }
    };
  }

  static findDeclaredAxis(comments = [], objInfo = [], pattern) {
    for (const entry of [...comments, ...objInfo]) {
      const match = entry.match(pattern);
      if (!match) continue;
      const axis = match[1].replace(/\s+/g, "").toLowerCase();
      return axis.startsWith("+") || axis.startsWith("-") ? axis : `+${axis}`;
    }
    return null;
  }

  static createSample(model, { maxPoints = 10000 } = {}) {
    if (!model || !Number.isInteger(model.sourceCount) || model.sourceCount < 0) {
      throw new TypeError("PlyReader.createSample requires a parsed 3DGS model.");
    }
    if (!Number.isInteger(maxPoints) || maxPoints <= 0) {
      throw new RangeError("maxPoints must be a positive integer.");
    }

    const selectedCount = Math.min(maxPoints, model.sourceCount);
    const points = new Array(selectedCount);
    for (let outputIndex = 0; outputIndex < selectedCount; outputIndex += 1) {
      const sourceIndex = selectedCount === 1
        ? 0
        : Math.round(outputIndex * (model.sourceCount - 1) / (selectedCount - 1));
      const positionOffset = sourceIndex * 3;
      const rotationOffset = sourceIndex * 4;
      const scale = {
        x: model.scales[positionOffset],
        y: model.scales[positionOffset + 1],
        z: model.scales[positionOffset + 2]
      };
      const rotation = {
        w: model.rotations[rotationOffset],
        x: model.rotations[rotationOffset + 1],
        y: model.rotations[rotationOffset + 2],
        z: model.rotations[rotationOffset + 3]
      };

      points[outputIndex] = {
        sourceIndex,
        position: {
          x: model.positions[positionOffset],
          y: model.positions[positionOffset + 1],
          z: model.positions[positionOffset + 2]
        },
        scale,
        rotation,
        covariance: PlyReader.computeWorldCovariance(scale, rotation),
        color: {
          r: 0,
          g: 0,
          b: 0,
          a: model.alphas[sourceIndex]
        }
      };
    }

    return {
      count: selectedCount,
      sourceCount: model.sourceCount,
      points,
      model
    };
  }

  static updateSampleColors(sample, { cameraPosition = { x: 2, y: 0, z: 0 } } = {}) {
    if (
      !sample ||
      !sample.model ||
      !Array.isArray(sample.points) ||
      sample.points.length !== sample.count
    ) {
      throw new TypeError("PlyReader.updateSampleColors requires a reusable Gaussian sample.");
    }

    const model = sample.model;
    const colorKeys = ["r", "g", "b"];
    for (const point of sample.points) {
      const direction = PlyReader.normalize({
        x: point.position.x - cameraPosition.x,
        y: point.position.y - cameraPosition.y,
        z: point.position.z - cameraPosition.z
      });
      const shOffset = point.sourceIndex * 48;
      for (let channel = 0; channel < 3; channel += 1) {
        point.color[colorKeys[channel]] = Math.round(
          255 * PlyReader.clamp(
            PlyReader.evaluateSh(
              model.sphericalHarmonics,
              direction,
              shOffset + channel * 16
            ) + 0.5
          )
        );
      }
    }

    return sample;
  }

  static computeWorldCovariance(scale, rotation) {
    let { w, x, y, z } = rotation;
    const quaternionLength = Math.hypot(w, x, y, z) || 1;
    w /= quaternionLength;
    x /= quaternionLength;
    y /= quaternionLength;
    z /= quaternionLength;
    const r00 = 1 - 2 * (y * y + z * z);
    const r01 = 2 * (x * y - w * z);
    const r02 = 2 * (x * z + w * y);
    const r10 = 2 * (x * y + w * z);
    const r11 = 1 - 2 * (x * x + z * z);
    const r12 = 2 * (y * z - w * x);
    const r20 = 2 * (x * z - w * y);
    const r21 = 2 * (y * z + w * x);
    const r22 = 1 - 2 * (x * x + y * y);
    const sx2 = scale.x * scale.x;
    const sy2 = scale.y * scale.y;
    const sz2 = scale.z * scale.z;

    return {
      cxx: r00 * r00 * sx2 + r01 * r01 * sy2 + r02 * r02 * sz2,
      cxy: r00 * r10 * sx2 + r01 * r11 * sy2 + r02 * r12 * sz2,
      cxz: r00 * r20 * sx2 + r01 * r21 * sy2 + r02 * r22 * sz2,
      cyy: r10 * r10 * sx2 + r11 * r11 * sy2 + r12 * r12 * sz2,
      cyz: r10 * r20 * sx2 + r11 * r21 * sy2 + r12 * r22 * sz2,
      czz: r20 * r20 * sx2 + r21 * r21 * sy2 + r22 * r22 * sz2
    };
  }

  static sample(model, {
    maxPoints = 10000,
    cameraPosition = { x: 2, y: 0, z: 0 }
  } = {}) {
    const sample = PlyReader.createSample(model, { maxPoints });
    return PlyReader.updateSampleColors(sample, { cameraPosition });
  }

  static parseHeader(buffer) {
    const bytes = new Uint8Array(buffer);
    const marker = new TextEncoder().encode("end_header");
    let markerOffset = -1;

    outer: for (let index = 0; index <= bytes.length - marker.length; index += 1) {
      for (let markerIndex = 0; markerIndex < marker.length; markerIndex += 1) {
        if (bytes[index + markerIndex] !== marker[markerIndex]) continue outer;
      }
      markerOffset = index;
      break;
    }

    if (markerOffset < 0) {
      throw new Error("Invalid PLY: end_header marker not found.");
    }

    let dataOffset = markerOffset + marker.length;
    if (bytes[dataOffset] === 13) dataOffset += 1;
    if (bytes[dataOffset] !== 10) {
      throw new Error("Invalid PLY: end_header must end with a newline.");
    }
    dataOffset += 1;

    const header = new TextDecoder("ascii").decode(bytes.subarray(0, markerOffset));
    const lines = header.split(/\r?\n/);
    if (lines[0].trim() !== "ply") {
      throw new Error("Invalid PLY magic header.");
    }

    let format = null;
    const elements = [];
    const comments = [];
    const objInfo = [];
    let element = null;
    for (const rawLine of lines.slice(1)) {
      const line = rawLine.trim();
      if (!line) continue;
      if (line.startsWith("comment ")) {
        comments.push(line.slice("comment ".length).trim());
        continue;
      }
      if (line.startsWith("obj_info ")) {
        objInfo.push(line.slice("obj_info ".length).trim());
        continue;
      }
      const parts = line.split(/\s+/);
      if (parts[0] === "format") {
        format = parts[1];
      } else if (parts[0] === "element") {
        element = { name: parts[1], count: Number(parts[2]), properties: [] };
        if (!Number.isInteger(element.count) || element.count < 0) {
          throw new Error(`Invalid count for PLY element ${element.name}.`);
        }
        elements.push(element);
      } else if (parts[0] === "property") {
        if (!element) throw new Error("PLY property appears before an element.");
        if (parts[1] === "list") {
          element.properties.push({ list: true, countType: parts[2], type: parts[3], name: parts[4] });
        } else {
          if (!PlyReader.typeReaders[parts[1]]) {
            throw new Error(`Unsupported PLY property type: ${parts[1]}`);
          }
          element.properties.push({ list: false, type: parts[1], name: parts[2] });
        }
      }
    }

    if (!format) throw new Error("Invalid PLY: format declaration not found.");
    return { dataOffset, elements, format, comments, objInfo };
  }

  static elementStride(element) {
    let stride = 0;
    for (const property of element.properties) {
      if (property.list) {
        throw new Error(`Cannot skip variable-length list data in PLY element ${element.name}.`);
      }
      const type = PlyReader.typeReaders[property.type];
      if (!type) throw new Error(`Unsupported PLY property type: ${property.type}`);
      stride += type.size;
    }
    return stride;
  }

  static evaluateSh(sh, { x, y, z }, offset = 0) {
    const C0 = 0.28209479177387814;
    const C1 = 0.4886025119029199;
    const C2 = [
      1.0925484305920792,
      -1.0925484305920792,
      0.31539156525252005,
      -1.0925484305920792,
      0.5462742152960396
    ];
    const C3 = [
      -0.5900435899266435,
      2.890611442640554,
      -0.4570457994644658,
      0.3731763325901154,
      -0.4570457994644658,
      1.445305721320277,
      -0.5900435899266435
    ];
    const xx = x * x;
    const yy = y * y;
    const zz = z * z;

    return C0 * sh[offset]
      - C1 * y * sh[offset + 1]
      + C1 * z * sh[offset + 2]
      - C1 * x * sh[offset + 3]
      + C2[0] * x * y * sh[offset + 4]
      + C2[1] * y * z * sh[offset + 5]
      + C2[2] * (2 * zz - xx - yy) * sh[offset + 6]
      + C2[3] * x * z * sh[offset + 7]
      + C2[4] * (xx - yy) * sh[offset + 8]
      + C3[0] * y * (3 * xx - yy) * sh[offset + 9]
      + C3[1] * x * y * z * sh[offset + 10]
      + C3[2] * y * (4 * zz - xx - yy) * sh[offset + 11]
      + C3[3] * z * (2 * zz - 3 * xx - 3 * yy) * sh[offset + 12]
      + C3[4] * x * (4 * zz - xx - yy) * sh[offset + 13]
      + C3[5] * z * (xx - yy) * sh[offset + 14]
      + C3[6] * x * (xx - 3 * yy) * sh[offset + 15];
  }

  static normalize(vector) {
    const length = Math.hypot(vector.x, vector.y, vector.z) || 1;
    return { x: vector.x / length, y: vector.y / length, z: vector.z / length };
  }

  static sigmoid(value) {
    if (value >= 0) return 1 / (1 + Math.exp(-value));
    const exponential = Math.exp(value);
    return exponential / (1 + exponential);
  }

  static clamp(value) {
    return Math.min(1, Math.max(0, value));
  }
}

if (typeof window !== "undefined") {
  window.PlyReader = PlyReader;
}

if (typeof module !== "undefined") {
  module.exports = { PlyReader };
}
