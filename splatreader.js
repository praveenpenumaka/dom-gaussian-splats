class SplatReader {
  static bytesPerSplat = 32;

  static async load(url) {
    const response = await fetch(url);

    if (!response.ok) {
      throw new Error(`Unable to load ${url}: ${response.status} ${response.statusText}`);
    }

    return SplatReader.parse(await response.arrayBuffer());
  }

  static parse(buffer) {
    if (!(buffer instanceof ArrayBuffer)) {
      throw new TypeError("SplatReader.parse requires an ArrayBuffer.");
    }

    if (buffer.byteLength % SplatReader.bytesPerSplat !== 0) {
      throw new Error(
        `Invalid .splat byte length: ${buffer.byteLength} is not divisible by ${SplatReader.bytesPerSplat}.`
      );
    }

    const view = new DataView(buffer);
    const count = buffer.byteLength / SplatReader.bytesPerSplat;
    const points = new Array(count);

    for (let index = 0; index < count; index += 1) {
      const offset = index * SplatReader.bytesPerSplat;

      points[index] = {
        position: {
          x: view.getFloat32(offset, true),
          y: view.getFloat32(offset + 4, true),
          z: view.getFloat32(offset + 8, true)
        },
        scale: {
          x: view.getFloat32(offset + 12, true),
          y: view.getFloat32(offset + 16, true),
          z: view.getFloat32(offset + 20, true)
        },
        color: {
          r: view.getUint8(offset + 24),
          g: view.getUint8(offset + 25),
          b: view.getUint8(offset + 26),
          a: view.getUint8(offset + 27)
        },
        rotation: {
          w: (view.getUint8(offset + 28) - 128) / 128,
          x: (view.getUint8(offset + 29) - 128) / 128,
          y: (view.getUint8(offset + 30) - 128) / 128,
          z: (view.getUint8(offset + 31) - 128) / 128
        }
      };
    }

    return { count, points };
  }

  static projectFromPositiveX(points, {
    cameraX = 2,
    fieldOfView = 50,
    near = 0.01,
    upAxis = "z"
  } = {}) {
    if (!Array.isArray(points) || points.length === 0) {
      return [];
    }

    const fieldOfViewRadians = fieldOfView * Math.PI / 180;
    const focalLength = 0.5 / Math.tan(fieldOfViewRadians / 2);

    return points
      .filter(({ position }) =>
        Number.isFinite(position.x) &&
        Number.isFinite(position.y) &&
        Number.isFinite(position.z)
      )
      .map((point) => {
        const depth = cameraX - point.position.x;

        if (depth <= near) {
          return null;
        }

        const ellipse = SplatReader.projectCovariance(point, depth, focalLength, 3, upAxis);
        const horizontal = upAxis === "y" ? point.position.z : point.position.y;
        const vertical = upAxis === "y" ? point.position.y : point.position.z;

        const cameraDistance = Math.hypot(
          cameraX - point.position.x,
          point.position.y,
          point.position.z
        );

        return {
          x: 0.5 + focalLength * horizontal / depth,
          y: 0.5 - focalLength * vertical / depth,
          depth,
          cameraDistance,
          zIndex: SplatReader.quantizeDistanceZIndex(cameraDistance),
          color: point.color,
          radiusX: ellipse.radiusX,
          radiusY: ellipse.radiusY,
          rotation: ellipse.rotation
        };
      })
      .filter((point) =>
        point !== null &&
        point.x >= 0 && point.x <= 1 &&
        point.y >= 0 && point.y <= 1
      );
  }

  static projectFromCamera(points, {
    cameraPosition,
    target = { x: 0, y: 0, z: 0 },
    worldUp = { x: 0, y: 1, z: 0 },
    fieldOfView = 50,
    near = 0.01,
    output = []
  } = {}) {
    if (!Array.isArray(output)) {
      throw new TypeError("projectFromCamera output must be an array.");
    }
    if (!Array.isArray(points) || points.length === 0) {
      output.length = 0;
      return output;
    }
    if (!cameraPosition) throw new TypeError("projectFromCamera requires cameraPosition.");

    const forward = SplatReader.normalizeVector({
      x: target.x - cameraPosition.x,
      y: target.y - cameraPosition.y,
      z: target.z - cameraPosition.z
    });
    const right = SplatReader.normalizeVector(SplatReader.cross(forward, worldUp));
    const cameraUp = SplatReader.normalizeVector(SplatReader.cross(right, forward));
    const focalLength = 0.5 / Math.tan(fieldOfView * Math.PI / 360);
    const basis = { right, up: cameraUp, forward };
    const cameraPoint = { x: 0, y: 0, z: 0 };
    const ellipse = { radiusX: 0, radiusY: 0, rotation: 0 };
    let outputIndex = 0;

    for (const point of points) {
      const position = point.centeredPosition ?? point.position;
      const relativeX = position.x - cameraPosition.x;
      const relativeY = position.y - cameraPosition.y;
      const relativeZ = position.z - cameraPosition.z;
      const cameraX = relativeX * right.x + relativeY * right.y + relativeZ * right.z;
      const cameraY = relativeX * cameraUp.x + relativeY * cameraUp.y + relativeZ * cameraUp.z;
      const depth = relativeX * forward.x + relativeY * forward.y + relativeZ * forward.z;
      if (!Number.isFinite(depth) || depth <= near) continue;

      cameraPoint.x = cameraX;
      cameraPoint.y = cameraY;
      cameraPoint.z = depth;
      SplatReader.projectCovarianceFromCamera(
        point,
        cameraPoint,
        basis,
        focalLength,
        3,
        ellipse
      );
      const projectedX = 0.5 + focalLength * cameraX / depth;
      const projectedY = 0.5 - focalLength * cameraY / depth;
      if (
        !Number.isFinite(projectedX) ||
        !Number.isFinite(projectedY) ||
        !Number.isFinite(ellipse.radiusX) ||
        !Number.isFinite(ellipse.radiusY)
      ) {
        continue;
      }

      const cameraDistance = Math.hypot(relativeX, relativeY, relativeZ);
      const projected = output[outputIndex] ?? {};
      projected.x = projectedX;
      projected.y = projectedY;
      projected.depth = depth;
      projected.cameraDistance = cameraDistance;
      projected.zIndex = SplatReader.quantizeDistanceZIndex(cameraDistance);
      projected.color = point.color;
      projected.radiusX = ellipse.radiusX;
      projected.radiusY = ellipse.radiusY;
      projected.rotation = ellipse.rotation;
      output[outputIndex] = projected;
      outputIndex += 1;
    }

    output.length = outputIndex;
    return output;
  }

  static projectCovarianceFromCamera(
    point,
    cameraPoint,
    basis,
    focalLength,
    sigmaExtent = 3,
    output = {}
  ) {
    const covariance = SplatReader.getWorldCovariance(point);

    const inverseDepth = 1 / cameraPoint.z;
    const inverseDepthSquared = inverseDepth * inverseDepth;
    const projectionScale = focalLength * inverseDepth;
    const horizontalDepthScale = focalLength * cameraPoint.x * inverseDepthSquared;
    const verticalDepthScale = focalLength * cameraPoint.y * inverseDepthSquared;
    const jUx = projectionScale * basis.right.x - horizontalDepthScale * basis.forward.x;
    const jUy = projectionScale * basis.right.y - horizontalDepthScale * basis.forward.y;
    const jUz = projectionScale * basis.right.z - horizontalDepthScale * basis.forward.z;
    const jVx = -projectionScale * basis.up.x + verticalDepthScale * basis.forward.x;
    const jVy = -projectionScale * basis.up.y + verticalDepthScale * basis.forward.y;
    const jVz = -projectionScale * basis.up.z + verticalDepthScale * basis.forward.z;
    const covarianceXX = SplatReader.covarianceBilinear(
      covariance,
      jUx, jUy, jUz,
      jUx, jUy, jUz
    );
    const covarianceXY = SplatReader.covarianceBilinear(
      covariance,
      jUx, jUy, jUz,
      jVx, jVy, jVz
    );
    const covarianceYY = SplatReader.covarianceBilinear(
      covariance,
      jVx, jVy, jVz,
      jVx, jVy, jVz
    );
    const trace = covarianceXX + covarianceYY;
    const difference = covarianceXX - covarianceYY;
    const discriminant = Math.sqrt(Math.max(0, difference ** 2 + 4 * covarianceXY ** 2));

    output.radiusX = sigmaExtent * Math.sqrt(Math.max(0, (trace + discriminant) / 2));
    output.radiusY = sigmaExtent * Math.sqrt(Math.max(0, (trace - discriminant) / 2));
    output.rotation = 0.5 * Math.atan2(2 * covarianceXY, difference);
    return output;
  }

  static dot(a, b) {
    return a.x * b.x + a.y * b.y + a.z * b.z;
  }

  static quantizeDistanceZIndex(cameraDistance, bucketsPerWorldUnit = 10000) {
    if (!Number.isFinite(cameraDistance) || cameraDistance < 0) return 1;
    const maximumZIndex = 2000000000;
    const distanceBucket = Math.min(
      maximumZIndex - 1,
      Math.max(0, Math.round(cameraDistance * bucketsPerWorldUnit))
    );
    return maximumZIndex - distanceBucket;
  }

  static cross(a, b) {
    return {
      x: a.y * b.z - a.z * b.y,
      y: a.z * b.x - a.x * b.z,
      z: a.x * b.y - a.y * b.x
    };
  }

  static normalizeVector(vector) {
    const length = Math.hypot(vector.x, vector.y, vector.z);
    if (!Number.isFinite(length) || length < 1e-12) {
      throw new Error("Camera direction and up vector must not be parallel or zero length.");
    }
    return { x: vector.x / length, y: vector.y / length, z: vector.z / length };
  }

  static getWorldCovariance(point) {
    const cached = point.covariance;
    if (
      cached &&
      Number.isFinite(cached.cxx) &&
      Number.isFinite(cached.cxy) &&
      Number.isFinite(cached.cxz) &&
      Number.isFinite(cached.cyy) &&
      Number.isFinite(cached.cyz) &&
      Number.isFinite(cached.czz)
    ) {
      return cached;
    }

    let { w, x, y, z } = point.rotation;
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
    const sx2 = point.scale.x * point.scale.x;
    const sy2 = point.scale.y * point.scale.y;
    const sz2 = point.scale.z * point.scale.z;
    const covariance = {
      cxx: r00 * r00 * sx2 + r01 * r01 * sy2 + r02 * r02 * sz2,
      cxy: r00 * r10 * sx2 + r01 * r11 * sy2 + r02 * r12 * sz2,
      cxz: r00 * r20 * sx2 + r01 * r21 * sy2 + r02 * r22 * sz2,
      cyy: r10 * r10 * sx2 + r11 * r11 * sy2 + r12 * r12 * sz2,
      cyz: r10 * r20 * sx2 + r11 * r21 * sy2 + r12 * r22 * sz2,
      czz: r20 * r20 * sx2 + r21 * r21 * sy2 + r22 * r22 * sz2
    };
    point.covariance = covariance;
    return covariance;
  }

  static covarianceBilinear(covariance, lx, ly, lz, rx, ry, rz) {
    return lx * (covariance.cxx * rx + covariance.cxy * ry + covariance.cxz * rz)
      + ly * (covariance.cxy * rx + covariance.cyy * ry + covariance.cyz * rz)
      + lz * (covariance.cxz * rx + covariance.cyz * ry + covariance.czz * rz);
  }

  static projectCovariance(point, depth, focalLength, sigmaExtent = 3, upAxis = "z") {
    const covariance = SplatReader.getWorldCovariance(point);

    const inverseDepth = 1 / depth;
    const horizontal = upAxis === "y" ? point.position.z : point.position.y;
    const vertical = upAxis === "y" ? point.position.y : point.position.z;
    const horizontalDepthScale = focalLength * horizontal * inverseDepth * inverseDepth;
    const verticalDepthScale = -focalLength * vertical * inverseDepth * inverseDepth;
    const projectionScale = focalLength * inverseDepth;
    const jUx = horizontalDepthScale;
    const jUy = upAxis === "y" ? 0 : projectionScale;
    const jUz = upAxis === "y" ? projectionScale : 0;
    const jVx = verticalDepthScale;
    const jVy = upAxis === "y" ? -projectionScale : 0;
    const jVz = upAxis === "y" ? 0 : -projectionScale;
    const covarianceXX = SplatReader.covarianceBilinear(
      covariance,
      jUx, jUy, jUz,
      jUx, jUy, jUz
    );
    const covarianceXY = SplatReader.covarianceBilinear(
      covariance,
      jUx, jUy, jUz,
      jVx, jVy, jVz
    );
    const covarianceYY = SplatReader.covarianceBilinear(
      covariance,
      jVx, jVy, jVz,
      jVx, jVy, jVz
    );

    const trace = covarianceXX + covarianceYY;
    const difference = covarianceXX - covarianceYY;
    const discriminant = Math.sqrt(
      Math.max(0, difference * difference + 4 * covarianceXY * covarianceXY)
    );
    const majorVariance = Math.max(0, (trace + discriminant) / 2);
    const minorVariance = Math.max(0, (trace - discriminant) / 2);

    return {
      radiusX: sigmaExtent * Math.sqrt(majorVariance),
      radiusY: sigmaExtent * Math.sqrt(minorVariance),
      rotation: 0.5 * Math.atan2(2 * covarianceXY, difference)
    };
  }
}

if (typeof window !== "undefined") {
  window.SplatReader = SplatReader;
}

if (typeof module !== "undefined") {
  module.exports = { SplatReader };
}
