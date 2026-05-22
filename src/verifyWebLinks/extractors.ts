import type { LinkRef, MetaTags } from "./types";

export interface ExtractResult {
  links: Array<{ href: string; tag: LinkRef["kind"] }>;
  meta: MetaTags;
  ids: Set<string>;
}

export async function extractFromHtml(response: Response): Promise<ExtractResult> {
  const links: Array<{ href: string; tag: LinkRef["kind"] }> = [];
  const meta: MetaTags = { byKey: {} };
  const ids = new Set<string>();
  let titleBuf = "";

  const rewriter = new HTMLRewriter();
  rewriter.on("a[href]", {
    element(el) {
      const h = el.getAttribute("href");
      if (h) links.push({ href: h, tag: "a" });
    },
  });
  rewriter.on("img[src]", {
    element(el) {
      const h = el.getAttribute("src");
      if (h) links.push({ href: h, tag: "img" });
    },
  });
  rewriter.on("script[src]", {
    element(el) {
      const h = el.getAttribute("src");
      if (h) links.push({ href: h, tag: "script" });
    },
  });
  rewriter.on("link[href]", {
    element(el) {
      const h = el.getAttribute("href");
      if (h) links.push({ href: h, tag: "link" });
    },
  });
  rewriter.on("iframe[src]", {
    element(el) {
      const h = el.getAttribute("src");
      if (h) links.push({ href: h, tag: "iframe" });
    },
  });
  rewriter.on("[id]", {
    element(el) {
      const id = el.getAttribute("id");
      if (id) ids.add(id);
    },
  });
  rewriter.on("meta", {
    element(el) {
      const property = el.getAttribute("property");
      const name = el.getAttribute("name");
      const content = el.getAttribute("content");
      if (!content) return;
      if (property?.startsWith("og:") || property?.startsWith("article:")) {
        meta.byKey[property] = content;
        if (property === "og:image") {
          links.push({ href: content, tag: "og-image" });
        }
      } else if (name === "description") {
        meta.byKey.description = content;
      } else if (name?.startsWith("twitter:")) {
        meta.byKey[name] = content;
      }
    },
  });
  rewriter.on("title", {
    text(chunk) {
      titleBuf += chunk.text;
      if (chunk.lastInTextNode && titleBuf.trim()) {
        meta.byKey.title = titleBuf.trim();
        titleBuf = "";
      }
    },
  });

  await rewriter.transform(response).arrayBuffer();
  return { links, meta, ids };
}
