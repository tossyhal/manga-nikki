import { comicSchema } from '../../shared/schemas.ts';

// 完成漫画と同じ文字数・コマ順のルールを、画像情報なしで再利用する。
export const scriptSchema = comicSchema.pick({ title: true, panels: true });
