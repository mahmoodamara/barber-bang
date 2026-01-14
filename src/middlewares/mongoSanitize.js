import mongoSanitize from "express-mongo-sanitize";

export const mongoSanitizeMiddleware = mongoSanitize({
  replaceWith: "_",
});
