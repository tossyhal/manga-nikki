import { Link, useLocation } from 'react-router';
import { validateLibraryBackTo } from '../features/library/librarySearch';
import { Icon } from './Icon';

export function BottomNav() {
  const location = useLocation();
  const { pathname, search } = location;
  const active = pathname === '/' ? 'home' : pathname === '/new' ? 'write' : 'records';
  const stateBackTo =
    typeof location.state === 'object' && location.state !== null
      ? (location.state as { backTo?: unknown }).backTo
      : undefined;
  const libraryBackTo =
    validateLibraryBackTo(pathname === '/library' ? `${pathname}${search}` : stateBackTo) ??
    '/library';

  return (
    <nav className="bottom-nav" aria-label="メインナビゲーション">
      <Link
        className={`bottom-nav-item${active === 'home' ? ' is-active' : ''}`}
        to="/"
        aria-label="ホーム"
        aria-current={active === 'home' ? 'page' : undefined}
      >
        <span className="bottom-nav-icon" aria-hidden="true">
          <Icon name="home" />
        </span>
        <span className="bottom-nav-label" aria-hidden={active !== 'home'}>
          ホーム
        </span>
      </Link>
      <Link
        className={`bottom-nav-item${active === 'write' ? ' is-active' : ''}`}
        to="/new"
        aria-label="日記を書く"
        aria-current={active === 'write' ? 'page' : undefined}
      >
        <span className="bottom-nav-icon" aria-hidden="true">
          <Icon name="plus" />
        </span>
        <span className="bottom-nav-label" aria-hidden={active !== 'write'}>
          書く
        </span>
      </Link>
      <Link
        className={`bottom-nav-item${active === 'records' ? ' is-active' : ''}`}
        to={libraryBackTo}
        aria-label="記録"
        aria-current={active === 'records' ? 'page' : undefined}
      >
        <span className="bottom-nav-icon" aria-hidden="true">
          <Icon name="calendar" />
        </span>
        <span className="bottom-nav-label" aria-hidden={active !== 'records'}>
          記録
        </span>
      </Link>
    </nav>
  );
}
