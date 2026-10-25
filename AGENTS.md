# Project Guidance

## Project purpose and architecture

- This is a dependency-free, static experimental Gaussian-splat renderer comparing browser-native DIV and SVG rendering with CPU and WebGPU projection.
- Keep responsibilities separated:
  - `index.html`: UI, camera state, renderer lifecycle, caching orchestration, auto-orbit, and metrics.
  - `plyreader.js`: 3DGS PLY parsing, sampling, model metadata, covariance preparation, and spherical-harmonic color evaluation.
  - `splatreader.js`: CPU camera projection and covariance-to-ellipse math.
  - `splatprocessor.js`: renderer-neutral projected-splat packets.
  - `divsplat.js` and `svgsplat.js`: DOM mutation only.
  - `webgpuprocessor.js`: WebGPU projection and bounded readback pipeline.
- DIV and SVG must consume the same sampled Gaussian set and shared packet representation so comparisons remain fair.
- Only the selected renderer may remain in the live renderer DOM. Clear the inactive renderer and detach its section on every renderer change.
- Preserve a square viewport. Keep the complete UI within the browser height, with statistics overlaid bottom-right and the axis gizmo bottom-left.

## Model, camera, and depth conventions

- Treat input coordinates as right-handed.
- Read declared up/front axes from PLY comments or `obj_info`; otherwise use model defaults. Front and up must be perpendicular.
- Orbit the camera around a fixed model origin; do not rotate the model. Manual orbit and roll steps are 90 degrees. Auto-orbit supports world X, Y, and Z axes.
- Project the full 3D Gaussian covariance into a screen-space ellipse. Derive displayed color and opacity from Gaussian data and spherical harmonics.
- Do not sort splats. DIV uses quantized, distance-derived `z-index`. SVG uses 256 ordered depth-bucket groups because SVG children do not support HTML-style `z-index` ordering.

## Caching and allocation

- Cache downloaded and parsed model buffers.
- Cache sampled Gaussian sets. Resample only when the requested Gaussian count changes.
- Cache centered positions and world covariance.
- Reuse projected-point arrays, packet objects, and DIV elements; avoid per-frame allocation where practical.
- SH color is view-dependent and must be evaluated for the camera frame that is actually presented.
- `PlyReader.updateSampleColors()` mutates shared point colors. Concurrent frames must not accidentally consume colors evaluated for a different camera position.

## Renderer behavior

- The DIV renderer maintains and reuses a persistent element pool.
- The SVG renderer currently rebuilds its tree and 256 depth buckets each frame; expect SVG DOM work to dominate sooner.
- Browser alpha compositing is intentionally used rather than implementing custom CPU compositing.
- Renderer selection and compute-backend selection are independent and persisted in local storage.

## WebGPU pipeline

- WebGPU currently accelerates projection and covariance-to-ellipse work only. SH evaluation, packet creation, DOM/SVG updates, layout, paint, and compositing remain CPU/browser work.
- Auto-orbit uses a bounded three-slot WebGPU pipeline. Each slot owns its uniform, output, readback buffer, bind group, and decoded output array.
- `tryProject()` reserves a free slot immediately and returns `null` when all slots are occupied. Drop submissions instead of growing an unbounded GPU queue.
- Tag asynchronous work with an orbit session/configuration generation and a monotonic frame sequence. Never present stale results after stopping orbit or changing the renderer, model, Gaussian count, axes, or backend.
- Retain each projected result's input index. For pipelined frames, evaluate SH after projection completes and attach the corresponding sampled-point colors before packet preparation.
- Keep manual renders serialized and deterministic.
- Drive auto-orbit with `requestAnimationFrame`, but calculate delivered FPS from successfully presented renderer updates, not animation callbacks. Report dropped submissions.
- Fixed-axis camera-vector rotation is negligible compared with per-Gaussian projection, GPU readback, packet creation, and DOM work. Caching complete angular frames would use substantial memory and produce stepped motion.

## Performance findings

- WebGPU output currently contains eight `float32` values (32 bytes) per Gaussian: about 312.5 KiB for 10,000, 1.27 MiB for 41,470, and 5.28 MiB for 173,161 Gaussians per frame.
- The `GPU readback` metric is not pure transfer time. It includes queued GPU work, compute execution, output-to-staging copy, GPU/CPU synchronization, and the `mapAsync()` wait.
- Triple buffering overlaps GPU projection/readback with CPU work and improves throughput modestly, but it cannot eliminate readback. DIV and SVG need every projected Gaussian in JavaScript.
- Do not assume a higher pipelined per-job readback latency means lower delivered throughput; queued frames may be in flight concurrently.
- High-value future experiments are WebGPU timestamp-query profiling, viewport culling, reducing output from eight to six floats, packed 16-bit output, and a direct WebGPU canvas renderer.
- A direct WebGPU canvas renderer is the only path that removes per-Gaussian readback and bulk DOM/SVG mutation. Keep it as a separate renderer mode so DOM-versus-GPU comparisons remain meaningful.
- Browser heap measurements are approximate and exclude much native DOM and GPU memory.

## Metrics

- Keep one collapsible metrics table for the active renderer, with a useful hover description for every metric.
- Preserve separate metrics for full presented-frame interval/FPS, backend, SH evaluation, centering, total projection, GPU setup/upload, submit, readback/wait, decode, packet preparation, renderer DOM work, estimated heap delta, splat count, and residual browser work.
- When streamed WebGPU auto-orbit is active, expose dropped submissions and measure the full-frame interval between actual presentations.

## Static serving

- When asked to serve this project, use Python's static HTTP server.
- Bind the server to hostname `100.66.145.72` and select an unused port.
- Report the resulting hostname and port after the server starts successfully.
- WebGPU requires a secure context. Raw LAN HTTP may require HTTPS, localhost, or adding the exact origin to Chrome's `chrome://flags/#unsafely-treat-insecure-origin-as-secure` override followed by a browser relaunch.
- If WebGPU initialization, compilation, device work, or mapping fails, show an actionable visible error and fall back to CPU. Never silently report a CPU fallback as GPU execution.
