import page from '../../docs/contracts/comic-page.example.json';
import panels from '../../docs/contracts/comic-panels.example.json';
import { comicSchema } from './schemas';
export const pageComic = comicSchema.parse(page);
export const panelsComic = comicSchema.parse(panels);
export const sampleDiary = '朝はトーストを食べた。図書館で本を読んだ。帰り道で猫を見かけた。';
