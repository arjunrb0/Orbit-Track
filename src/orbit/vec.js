// Tiny 3-vector helpers. Vectors are plain arrays [x, y, z].

export const add = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
export const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
export const scale = (a, k) => [a[0] * k, a[1] * k, a[2] * k];
export const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
export const norm = (a) => Math.hypot(a[0], a[1], a[2]);
export const cross = (a, b) => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];

// Rotations of a vector by `angle` radians about an axis. Positive angle =
// anticlockwise when looking back down the axis from its positive end
// (the right-hand rule). These rotate the *vector*, not the axes.

/** Rotate v about the x axis. */
export const rotateX = ([x, y, z], angle) => {
  const c = Math.cos(angle), s = Math.sin(angle);
  return [x, c * y - s * z, s * y + c * z];
};

/** Rotate v about the z axis. */
export const rotateZ = ([x, y, z], angle) => {
  const c = Math.cos(angle), s = Math.sin(angle);
  return [c * x - s * y, s * x + c * y, z];
};
