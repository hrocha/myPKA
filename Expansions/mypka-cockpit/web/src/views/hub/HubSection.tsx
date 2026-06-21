// HubSection.tsx — the shared Hub section frame (header + hint + optional action
// + children). Extracted from HubView so the Hub's modular cards (OpenInvoices,
// RecentlyScanned, and the in-file sections) all render the SAME chrome. Pure
// presentational; token-only styling lives in hub.css (.hub-section*).
import { ArrowRight } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import type { ReactNode } from 'react';

export function HubSection({
  icon: Icon, title, hint, action, children,
}: {
  icon: LucideIcon;
  title: string;
  hint?: string;
  action?: { label: string; onClick: () => void };
  children: ReactNode;
}) {
  return (
    <section className="hub-section">
      <header className="hub-section-head">
        <h2 className="hub-section-title">
          <Icon size={15} strokeWidth={1.5} aria-hidden="true" />
          {title}
        </h2>
        {hint && <p className="hub-section-hint">{hint}</p>}
        {action && (
          <button type="button" className="hub-section-action" onClick={action.onClick}>
            {action.label}
            <ArrowRight size={13} strokeWidth={1.5} aria-hidden="true" />
          </button>
        )}
      </header>
      {children}
    </section>
  );
}
