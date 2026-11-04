import { Link, useLocation } from 'react-router';
import { Icon } from './Icon';

export function BottomNav() {
  const { pathname } = useLocation();
  const active = pathname === '/' ? 'home' : pathname === '/new' ? 'write' : 'records';

  return (
    <nav className="bottom-nav" aria-label="メインナビゲーション">
      <Link
        className={`bottom-nav-item${active === 'home' ? ' is-active' : ''}`}
        to="/"
        aria-label="ホーム"
        aria-current={active === 'home' ? 'page' : undefined}
      >
        <Icon name="home" />
        <span aria-hidden={active !== 'home'}>ホーム</span>
      </Link>
      <Link
        className={`bottom-nav-item${active === 'write' ? ' is-active' : ''}`}
        to="/new"
        aria-label="日記を書く"
        aria-current={active === 'write' ? 'page' : undefined}
      >
        <Icon name="plus" size={28} />
        <span aria-hidden={active !== 'write'}>書く</span>
      </Link>
      <Link
        className={`bottom-nav-item${active === 'records' ? ' is-active' : ''}`}
        to="/library"
        aria-label="記録"
        aria-current={active === 'records' ? 'page' : undefined}
      >
        <Icon name="calendar" />
        <span aria-hidden={active !== 'records'}>記録</span>
      </Link>
    </nav>
  );
}
