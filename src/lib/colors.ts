export const C = {
  R: "\x1b[31m", G: "\x1b[32m", Y: "\x1b[33m", C: "\x1b[36m",
  B: "\x1b[1m", X: "\x1b[0m",
  red: (s) => C.R + s + C.X, green: (s) => C.G + s + C.X,
  yellow: (s) => C.Y + s + C.X, bold: (s) => C.B + s + C.X,
};
