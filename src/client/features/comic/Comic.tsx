import type { ComicDocument } from '../../../shared/schemas';

export function Comic({
  comic,
  images,
  mock = false,
  titleAs: Title = 'h2',
}: {
  comic: ComicDocument;
  images: Record<string, string>;
  mock?: boolean;
  /** 漫画タイトルの見出しレベル。周囲の見出し階層に合わせて選ぶ */
  titleAs?: 'h2' | 'h3';
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
        <Title className="comic-title">{comic.title}</Title>
        <ol>
          {comic.panels.map((panel) => (
            <li key={panel.index}>
              <p>{panel.scene}</p>
              {panel.caption && <p>{panel.caption}</p>}
              {panel.dialogue && <p>「{panel.dialogue}」</p>}
            </li>
          ))}
        </ol>
        {mock && <small>固定サンプルです。入力内容は反映されず、AIにも送信されません。</small>}
      </figcaption>
    </figure>
  );
}
