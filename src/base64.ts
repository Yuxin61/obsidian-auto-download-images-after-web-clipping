/* global Buffer -- Node.js global available in Electron renderer */

// ─── Base64 image extraction ───────────────────────────────────────────────

// Markdown: ![alt](data:image/png;base64,...)
const BASE64_MD_REGEX = /!\[([^\]]*)\]\((data:image\/([a-zA-Z+]+);base64,([A-Za-z0-9+/=]+))\)/g;

// HTML: <img src="data:image/png;base64,..."> or single-quoted
const BASE64_HTML_REGEX = /<img\s[^>]*\bsrc=(?:"(data:image\/[^;]+;base64,[^"]+)"|'(data:image\/[^;]+;base64,[^']+)')[^>]*>/gi;

const MAX_BASE64_BYTES = 5 * 1024 * 1024; // 5 MB decoded
const MIN_IMAGE_BYTES  = 1024;             // 1 KB — skip tracking pixels

const MIME_EXT_MAP: Record<string, string> = {
  'image/jpeg':    '.jpg',
  'image/png':     '.png',
  'image/gif':     '.gif',
  'image/webp':    '.webp',
  'image/svg+xml': '.svg',
  'image/avif':    '.avif',
  'image/bmp':     '.bmp',
};

/** Vault write helpers passed in from the plugin. */
export interface Base64Context {
  resolveDestPath(folder: string, name: string): Promise<string>;
  ensureFolder(folder: string): Promise<void>;
  writeBinary(path: string, data: ArrayBuffer): Promise<void>;
}

/**
 * Scan `content` for inline base64 data URIs (Markdown and HTML img syntax),
 * decode and write each one as an image file, and return a Map from
 * data URI → local vault path.
 */
export async function extractBase64Images(
  content: string,
  attachmentFolder: string,
  titleBase: string,
  ctx: Base64Context,
  onTooLarge: (bytes: number, n: number) => void,
  onTooSmall: (bytes: number, n: number) => void,
  onWriteFailed: (path: string, err: unknown) => void,
): Promise<Map<string, string>> {
  const uris: string[] = [];
  for (const m of content.matchAll(BASE64_MD_REGEX)) {
    const uri = m[2];
    if (uri && !uris.includes(uri)) uris.push(uri);
  }
  for (const m of content.matchAll(BASE64_HTML_REGEX)) {
    const uri = m[1] ?? m[2];
    if (uri && !uris.includes(uri)) uris.push(uri);
  }

  if (uris.length === 0) return new Map();

  await ctx.ensureFolder(attachmentFolder);

  const uriToLocal = new Map<string, string>();
  let savedCount = 1;

  for (let i = 0; i < uris.length; i++) {
    const uri = uris[i]!;
    const mimeMatch = uri.match(/^data:(image\/[^;]+);base64,/);
    const mime = mimeMatch?.[1] ?? '';
    const b64data = uri.slice(uri.indexOf(',') + 1);

    let decoded: ArrayBuffer;
    try {
      const buf = Buffer.from(b64data, 'base64');
      decoded = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
    } catch {
      console.warn(`[AutoDL] Failed to decode base64 image #${i + 1}, skipping`);
      continue;
    }

    if (decoded.byteLength > MAX_BASE64_BYTES) { onTooLarge(decoded.byteLength, i + 1); continue; }
    if (decoded.byteLength < MIN_IMAGE_BYTES)  { onTooSmall(decoded.byteLength,  i + 1); continue; }

    const ext = MIME_EXT_MAP[mime] ?? '.bin';
    const rawName = `${titleBase}-b64-${savedCount}${ext}`
      .replace(/\s+/g, '-')
      .replace(/[\\:*?"<>|]/g, '_');
    const destPath = await ctx.resolveDestPath(attachmentFolder, rawName);

    try {
      await ctx.writeBinary(destPath, decoded);
      uriToLocal.set(uri, destPath);
      savedCount++;
    } catch (err) {
      onWriteFailed(destPath, err);
    }
  }

  return uriToLocal;
}

/**
 * Apply base64 URI → local path replacements to `content`.
 * Uses plain string split/join (not RegExp) to avoid issues with `/` in data URIs.
 */
export function replaceBase64Uris(
  content: string,
  uriToLocal: Map<string, string>,
  formatLink: (destPath: string, alt: string) => string,
): string {
  let updated = content;

  for (const [uri, destPath] of uriToLocal) {
    // Markdown: ![alt](data:...)
    updated = updated.split(`](${uri})`).map((part, idx, arr) => {
      if (idx === arr.length - 1) return part;
      const altStart = part.lastIndexOf('![');
      if (altStart === -1) return part + `](${uri})`;
      const alt = part.slice(altStart + 2);
      const before = part.slice(0, altStart);
      return before + formatLink(destPath, alt);
    }).join('');

    // HTML: <img src="data:...">
    const tagRe = /<img\s[^>]*\bsrc=(?:"[^"]*"|'[^']*')[^>]*>/gi;
    updated = updated.replace(tagRe, (fullTag: string) => {
      if (!fullTag.includes(uri)) return fullTag;
      const altMatch = fullTag.match(/\balt=(?:"([^"]*)"|'([^']*)')/i);
      const alt = altMatch ? (altMatch[1] ?? altMatch[2] ?? '') : '';
      return formatLink(destPath, alt);
    });
  }

  return updated;
}
