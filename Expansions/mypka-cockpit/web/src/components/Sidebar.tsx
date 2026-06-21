// Sidebar.tsx — the cockpit's left navigation.
//
// Mirrors the shadcn/ui Sidebar anatomy: SidebarMenu > SidebarMenuItem >
// SidebarMenuButton (data-active) + SidebarMenuBadge for the per-type counts,
// the Cmd/Ctrl+B toggle, and the mobile off-canvas that collapses into an
// overlay. Built with the design tokens + ZERO new deps (structure and a11y
// contract reproduced, not the package).
import {
  NotebookPen, Sparkles, Users, Hash, FolderKanban,
  KeyRound, Repeat2, Target, Building2, FileText, Package, PanelLeftClose,
  UsersRound, LayoutDashboard, StickyNote, Plug, SlidersHorizontal, Search,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import type { NavType, EntityType } from '../lib/cockpitTypes';
import { type Route, hrefFor } from '../lib/router';
import { modulesForSection, type ModuleNavSection } from '../lib/moduleRegistry';
import { QuickTerminalButton } from './QuickTerminalButton';
import { S } from '../lib/strings';

const TYPE_ICON: Record<EntityType, LucideIcon> = {
  journal: NotebookPen,
  people: Users,
  topics: Hash,
  projects: FolderKanban,
  key_elements: KeyRound,
  habits: Repeat2,
  goals: Target,
  organizations: Building2,
  documents: FileText,
  deliverables: Package,
};

interface SidebarProps {
  navTypes: NavType[];
  route: Route;
  open: boolean;
  onToggle: () => void;
  onNavigate: () => void; // close the mobile drawer after a click
  onOpenSearch: () => void; // open the ⌘K command palette
}

// Mac shows ⌘K; everyone else shows Ctrl+K. navigator.platform is deprecated but
// still the most reliable client-side OS hint for this cosmetic shortcut badge.
const IS_MAC = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform);

function isActive(route: Route, target: Route): boolean {
  // The "Fleeting Notes" nav (target #/notes) stays lit inside an open doc
  // and on a whiteboard too.
  if (target.name === 'notes' && (route.name === 'notes-doc' || route.name === 'board')) return true;
  if (route.name !== target.name) return false;
  if (target.name === 'type' && route.name === 'type') return route.type === target.type;
  // Drop-in modules disambiguate by slug (one nav row per module).
  if (target.name === 'module' && route.name === 'module') return route.slug === target.slug;
  return true;
}

function NavRow({
  icon: Icon, label, count, href, active, onClick,
}: {
  icon: LucideIcon; label: string; count?: number; href: string; active: boolean; onClick: () => void;
}) {
  return (
    <li className="menu-item">
      <a href={href} onClick={onClick} data-active={active} className="menu-button" aria-current={active ? 'page' : undefined}>
        <Icon size={18} strokeWidth={1.5} aria-hidden="true" className="menu-icon" />
        <span className="menu-label">{label}</span>
        {count != null && <span className="menu-badge" aria-label={`${count} entries`}>{count}</span>}
      </a>
    </li>
  );
}

// Renders the nav rows for every active drop-in module attached to a sidebar
// section. A module without its pack (gated off / not installed) contributes
// nothing — the section simply doesn't show its row.
function ModuleRows({
  section, route, onNavigate,
}: {
  section: ModuleNavSection; route: Route; onNavigate: () => void;
}) {
  return (
    <>
      {modulesForSection(section).map((m) => (
        <NavRow
          key={m.slug}
          icon={m.navIcon}
          label={m.navLabel}
          href={hrefFor({ name: 'module', slug: m.slug })}
          active={isActive(route, { name: 'module', slug: m.slug })}
          onClick={onNavigate}
        />
      ))}
    </>
  );
}

export function Sidebar({ navTypes, route, open, onToggle, onNavigate, onOpenSearch }: SidebarProps) {
  // The Library group hosts drop-in library modules (recipes, films, …); it
  // disappears entirely while no module is attached to it.
  const libraryModules = modulesForSection('library');
  // The pinned-top block (Deliverables, Team Inbox) sits ABOVE the Overview
  // group as an ungrouped block with no section header. It disappears entirely
  // while no module is attached to the 'top' section.
  const topModules = modulesForSection('top');

  return (
    <>
      {/* Mobile scrim (only visible when the drawer is open on small screens). */}
      <div
        className={`sidebar-scrim ${open ? 'is-open' : ''}`}
        onClick={onToggle}
        aria-hidden="true"
      />
      <nav className={`cockpit-sidebar ${open ? 'is-open' : ''}`} aria-label="Cockpit navigation">
        <div className="sidebar-header">
          <span className="sidebar-brand-mark" aria-hidden="true">
            <Sparkles size={18} strokeWidth={1.5} />
          </span>
          <div className="sidebar-brand-text">
            <span className="sidebar-brand-title">myPKA Cockpit</span>
            <span className="sidebar-brand-sub">Personal Knowledge Assistance</span>
          </div>
          {/* Collapse affordance lives IN the sidebar header (moved out of the top
              content bar). Collapses the rail on desktop; closes the drawer on mobile. */}
          <button
            type="button"
            className="sidebar-collapse"
            onClick={onToggle}
            aria-label="Collapse navigation"
            title="Collapse sidebar"
          >
            <PanelLeftClose size={18} strokeWidth={1.5} aria-hidden="true" />
          </button>
        </div>

        {/* Global search trigger — opens the ⌘K command palette (FTS5 over note
            titles AND bodies). Looks like a search field but is a button: the
            real input lives in the modal (focus trap + keyboard nav). */}
        <div className="sidebar-search">
          <button
            type="button"
            className="sidebar-search-trigger"
            onClick={() => { onOpenSearch(); onNavigate(); }}
            aria-label="Search your knowledge base"
            aria-keyshortcuts={IS_MAC ? 'Meta+K' : 'Control+K'}
          >
            <Search size={16} strokeWidth={1.5} aria-hidden="true" className="sidebar-search-icon" />
            <span className="sidebar-search-placeholder">Search…</span>
            <kbd className="sidebar-search-kbd" aria-hidden="true">{IS_MAC ? '⌘K' : 'Ctrl K'}</kbd>
          </button>
        </div>

        <div className="sidebar-content">
          {/* Pinned-top block: Deliverables + Team Inbox, ABOVE Hub. Ungrouped
              (no section header) so they read as a primary top-of-rail block;
              absent entirely when no module is attached to the 'top' section. */}
          {topModules.length > 0 && (
            <div className="sidebar-group">
              <ul className="menu">
                <ModuleRows section="top" route={route} onNavigate={onNavigate} />
              </ul>
            </div>
          )}

          <div className="sidebar-group">
            <span className="sidebar-group-label">Overview</span>
            <ul className="menu">
              <NavRow
                icon={LayoutDashboard} label="Hub" href={hrefFor({ name: 'hub' })}
                active={isActive(route, { name: 'hub' })} onClick={onNavigate}
              />
              <NavRow
                icon={NotebookPen} label="Journal" href={hrefFor({ name: 'journal' })}
                active={isActive(route, { name: 'journal' })} onClick={onNavigate}
              />
              <NavRow
                icon={StickyNote} label="Fleeting Notes" href={hrefFor({ name: 'notes' })}
                active={isActive(route, { name: 'notes' })} onClick={onNavigate}
              />
              {/* Drop-in extension modules attached to the Overview group. */}
              <ModuleRows section="overview" route={route} onNavigate={onNavigate} />
            </ul>
          </div>

          <div className="sidebar-group">
            <span className="sidebar-group-label">Knowledge</span>
            <ul className="menu">
              {navTypes
                .filter((t) => t.type !== 'journal' && t.type !== 'deliverables') // journal has its own dated view above
                .map((t) => (
                  <NavRow
                    key={t.type}
                    icon={TYPE_ICON[t.type]}
                    label={t.label}
                    count={t.count}
                    href={hrefFor({ name: 'type', type: t.type })}
                    active={isActive(route, { name: 'type', type: t.type })}
                    onClick={onNavigate}
                  />
                ))}
              <ModuleRows section="knowledge" route={route} onNavigate={onNavigate} />
            </ul>
          </div>

          {libraryModules.length > 0 && (
            <div className="sidebar-group">
              <span className="sidebar-group-label">{S.sidebar.groupLibrary}</span>
              <ul className="menu">
                <ModuleRows section="library" route={route} onNavigate={onNavigate} />
              </ul>
            </div>
          )}
        </div>

        {/* Pinned to the BOTTOM of the rail, just above the footer. It lives
            OUTSIDE .sidebar-content (which is flex:1 + scrolls), so it stays put
            regardless of how long the Overview/Knowledge lists grow. */}
        <div className="sidebar-bottom">
          <ul className="menu">
            {/* Quick-launch terminal: opens a prompt composer that launches the
                configured LLM CLI at the scaffold root (no file context). Sits
                with the utility actions; closes the mobile drawer on open. */}
            <li className="menu-item">
              <QuickTerminalButton onAfterOpen={onNavigate} />
            </li>
            <NavRow
              icon={Plug} label="Connections" href={hrefFor({ name: 'connections' })}
              active={isActive(route, { name: 'connections' })} onClick={onNavigate}
            />
            <NavRow
              icon={UsersRound} label="My AI Team" href={hrefFor({ name: 'roster' })}
              active={isActive(route, { name: 'roster' })} onClick={onNavigate}
            />
            <NavRow
              icon={SlidersHorizontal} label="Settings" href={hrefFor({ name: 'settings' })}
              active={isActive(route, { name: 'settings' })} onClick={onNavigate}
            />
          </ul>
        </div>

        <div className="sidebar-footer">
          <p className="sidebar-footer-note">
            Live from <span className="font-mono">mypka.db</span>. Read-only. Markdown is canonical.
          </p>
        </div>
      </nav>
    </>
  );
}
