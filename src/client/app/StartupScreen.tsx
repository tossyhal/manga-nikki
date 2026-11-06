import './StartupScreen.css';

export function StartupScreen() {
  return (
    <section className="startup-screen" aria-busy="true" aria-labelledby="startup-screen-name">
      <div className="startup-screen__content">
        <img
          className="startup-screen__mark"
          src="/cat-mascot.png"
          alt=""
          width={480}
          height={363}
        />
        <h1 id="startup-screen-name" className="startup-screen__name">
          漫画日記
        </h1>
        <output className="startup-screen__status" aria-live="polite">
          <span className="startup-screen__indicator" aria-hidden="true" />
          準備中…
        </output>
      </div>
    </section>
  );
}
