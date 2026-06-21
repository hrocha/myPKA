// nodeIcon.ts — entity type -> Lucide glyph, per GL-003 §8.9.3 / §5.5.
//
// The node's TYPE is a SHAPE concern (icon), NEVER a colour concern. There is no
// per-type hue anywhere in the graph (GL-003 §8.6 / §8.8.7 / §9.5 ban, fully in
// force on this surface). The glyph is the only type differentiator; colour is
// reserved for the single Gen-0 brass moment (§8.9.2).
//
// Vocabulary extends the NoteView type→glyph set across all 10 entity tables.
import {
  FileText,
  Calendar,
  Target,
  Flag,
  Repeat,
  User,
  Building2,
  Tag,
  Package,
  KeyRound,
  UsersRound,
  ListChecks,
  Workflow,
  BookOpen,
  type LucideIcon,
} from 'lucide-react';
import type { GraphNodeType } from '../../lib/cockpitTypes';

// One canonical glyph per node type. Monochrome; size/strokeWidth set at render
// per the §8.9.1 ladder. The 10 entity tables plus the agent-graph node kinds
// (a sibling agent + the three Team-Knowledge kinds). Type is a SHAPE concern
// (glyph) only — never a colour concern (§8.6 ban holds on this surface too).
const TYPE_ICON: Record<GraphNodeType, LucideIcon> = {
  key_elements: KeyRound,
  topics: Tag,
  habits: Repeat,
  people: User,
  organizations: Building2,
  projects: Package,
  goals: Flag,
  documents: FileText,
  deliverables: Target,
  journal: Calendar,
  agents: UsersRound,
  sops: ListChecks,
  workstreams: Workflow,
  guidelines: BookOpen,
};

export function iconForType(type: string): LucideIcon {
  return TYPE_ICON[type as GraphNodeType] ?? FileText;
}
