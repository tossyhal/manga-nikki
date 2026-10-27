import { pageComic } from '../../../shared/fixtures';

export function Comic() {
  return (
    <figure className="comic">
      <img src="/sample-comic.svg" alt="トースト、図書館、帰り道、猫を描いた架空の4コマサンプル" />
      <figcaption>
        <strong>{pageComic.title}</strong>
        <ol>
          {pageComic.panels.map((panel) => (
            <li key={panel.index}>{panel.caption}</li>
          ))}
        </ol>
        <small>固定サンプルです。入力した日記から生成した画像ではありません。</small>
      </figcaption>
    </figure>
  );
}
