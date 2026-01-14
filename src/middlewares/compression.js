import compression from "compression";

export const compressionMiddleware = compression({
  level: 6,
  threshold: 1024,
});
