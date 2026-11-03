const SUMMARY_MAX = 40;

export function summarizeDiary(body: string): string {
  const text = body.trim().replace(/\s+/g, ' ');
  if (!text) return '無題の記録';
  const sentence = text.match(/^.+?(?:[。！？]|$)/u)?.[0] ?? text;
  const chars = [...sentence];
  if (chars.length <= SUMMARY_MAX) return sentence;
  return `${chars.slice(0, SUMMARY_MAX - 1).join('')}…`;
}
