// PageHeader.tsx — the shared, minimalist index-page header.
//
// The X.com header pattern, standardised across every index/list page: the
// page TITLE (with its icon + a quiet count/subtitle line) sits top-LEFT, and
// the page's primary ACTION (a "+ New …" button, a composer affordance, …) sits
// top-RIGHT. Generous whitespace, minimal chrome.
//
// CONTRACT
//   title    — the page name (required). Rendered as the <h1>.
//   icon     — optional Lucide icon component (the UI convention is 22px @
//              strokeWidth 1.5); painted brass via .title-icon.
//   subtitle — optional quiet line beneath the title (count + ordering, a one-
//              line description). A string or any node.
//   action   — optional primary-action node, pinned top-right. Pass a <button>
//              or a self-contained affordance (e.g. the journal/fleeting
//              composer trigger) — PageHeader does not style it, it only places
//              it, so each surface keeps its own action semantics.
//   id       — optional id forwarded to the <h1> (for aria-labelledby on the
//              owning <section>).
//
// Tokens only (cockpit.css .page-header / .page-title / .page-sub / .title-icon);
// no hardcoded colour or size. Replaces the per-view header wrappers
// (.documents-header, .ft-view-header, .dashboard-header, .type-list-header,
// .workbench-list-header) with one component + one style.
import type { ReactNode } from 'react';
import type { LucideIcon } from 'lucide-react';

export function PageHeader({
  title,
  icon: Icon,
  subtitle,
  action,
  id,
}: {
  title: ReactNode;
  icon?: LucideIcon;
  subtitle?: ReactNode;
  action?: ReactNode;
  id?: string;
}) {
  return (
    <header className="page-header">
      <div className="page-header-heading">
        <h1 className="page-title" id={id}>
          {Icon && (
            <Icon size={22} strokeWidth={1.5} aria-hidden="true" className="title-icon" />
          )}
          {title}
        </h1>
        {subtitle != null && subtitle !== '' && (
          <p className="page-sub">{subtitle}</p>
        )}
      </div>
      {action != null && <div className="page-header-action">{action}</div>}
    </header>
  );
}
