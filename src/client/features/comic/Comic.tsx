import type { ComicDocument } from '../../../shared/schemas';

export function Comic({
  comic,
  images,
  mock = false,
}: {
  comic: ComicDocument;
  images: Record<string, string>;
  mock?: boolean;
}) {
  const ids = comic.visual.kind === 'page' ? [comic.visual.assetId] : comic.visual.assetIds;
  return (
    <figure className="comic">
      <div className="comic-images">
        {ids.map(
          (id, index) =>
            images[id] && (
              <img
                key={id}
                src={images[id]}
                alt={
                  comic.visual.kind === 'page'
                    ? `${comic.title}の4コマ漫画`
                    : `${index + 1}コマ目：${comic.panels[index]?.scene}`
                }
              />
            ),
        )}
      </div>
      <figcaption>
        <strong>{comic.title}</strong>
        <ol>
          {comic.panels.map((panel) => (
            <li key={panel.index}>
              <p>{panel.scene}</p>
              {panel.caption && <p>{panel.caption}</p>}
              {panel.dialogue && <p>「{panel.dialogue}」</p>}
            </li>
          ))}
        </ol>
        {mock && <small>固定サンプルです。入力した日記から生成した画像ではありません。</small>}
      </figcaption>
    </figure>
  );
}
