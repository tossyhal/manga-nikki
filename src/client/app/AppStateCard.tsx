import type { ReactNode } from 'react';
import { Icon } from './Icon';

export const configUnavailableMessage =
  '現在、読み込めません。通信を確認して再読み込みしてください。';

type AppStateCardProps = {
  title: string;
  description: string;
  actions?: ReactNode;
  role?: 'alert';
  status?: boolean;
  headingLevel?: 'h1' | 'h2';
};

export function AppStateCard({
  title,
  description,
  actions,
  role,
  status = false,
  headingLevel = 'h1',
}: AppStateCardProps) {
  const Heading = headingLevel;
  return (
    <section
      className="app-state-card"
      role={role}
      aria-labelledby="app-state-title"
      aria-live={status ? 'polite' : undefined}
      aria-atomic={status ? true : undefined}
    >
      <Icon name={role === 'alert' ? 'alert' : status ? 'clock' : 'book'} size={40} />
      <Heading id="app-state-title">{title}</Heading>
      <p>{description}</p>
      {actions && <div className="app-state-actions">{actions}</div>}
    </section>
  );
}
