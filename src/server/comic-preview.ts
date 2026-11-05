import type { ScriptResult } from './ai/script-provider.ts';

const escapeHtml = (value: string) =>
  value.replace(
    /[&<>"']/g,
    (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]!,
  );

// OpenAIの開発APIで生成した4コマを同じプレビューに表示する。
export function renderComicPreview(input: {
  script: ScriptResult;
  images: { index: number; url: string }[];
  notice: string;
}): string {
  const figures = input.script.panels
    .map((panel) => {
      const image = input.images.find((item) => item.index === panel.index);
      return `<figure><p>${panel.index}コマ目</p>${image ? `<img src="${escapeHtml(image.url)}" alt="${escapeHtml(panel.scene)}">` : '<p>画像未生成</p>'}<figcaption>${panel.caption ? `<p>${escapeHtml(panel.caption)}</p>` : ''}${panel.dialogue ? `<p>「${escapeHtml(panel.dialogue)}」</p>` : ''}</figcaption></figure>`;
    })
    .join('\n');
  return `<!doctype html><html lang="ja"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src 'self' file:; style-src 'unsafe-inline'; base-uri 'none'"><title>${escapeHtml(input.script.title)}</title><style>body{font-family:system-ui,sans-serif;background:#eee;color:#111;margin:0;padding:24px 12px}main{max-width:520px;margin:auto}h1{font-size:24px}figure{background:white;border:2px solid #111;margin:20px 0;padding:8px}img{display:block;width:100%;height:auto}figcaption{padding:8px;white-space:pre-wrap;line-height:1.7}p{margin:4px 0}.notice{font-size:14px}</style></head><body><main><h1>${escapeHtml(input.script.title)}</h1><p class="notice">${escapeHtml(input.notice)}</p>${figures}</main></body></html>`;
}
