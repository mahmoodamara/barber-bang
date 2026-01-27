import sanitizeHtml from "sanitize-html";

export function sanitizeRichText(input) {
  const html = String(input || "");

  return sanitizeHtml(html, {
    allowedTags: ["p", "br", "b", "strong", "i", "em", "u", "ul", "ol", "li", "a"],
    allowedAttributes: {
      a: ["href", "title", "target", "rel"],
    },
    allowedSchemes: ["http", "https", "mailto"],
    transformTags: {
      a: (tagName, attribs) => {
        const href = attribs.href || "";
        const safe = { ...attribs };

        // prevent javascript: or other dangerous protocols
        if (href && !/^(https?:|mailto:)/i.test(href)) {
          safe.href = "#";
        }

        // enforce safe rel for target=_blank
        if (safe.target === "_blank") {
          safe.rel = "noopener noreferrer";
        } else {
          // keep rel safe even without target blank
          safe.rel = "noopener noreferrer";
        }

        return { tagName, attribs: safe };
      },
    },
    disallowedTagsMode: "discard",
  });
}

export function sanitizePlainText(input, { maxLen = 600 } = {}) {
  const raw = String(input ?? "");
  const noTags = raw.replace(/<[^>]*>/g, "");
  const noProto = noTags.replace(/javascript:/gi, "").replace(/data:/gi, "");
  const normalized = noProto.replace(/\s+/g, " ").trim();
  if (maxLen && normalized.length > maxLen) return normalized.slice(0, maxLen);
  return normalized;
}
