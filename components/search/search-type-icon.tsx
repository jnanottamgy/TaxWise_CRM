import {
  Building2Icon,
  ContactRoundIcon,
  FileTextIcon,
  FolderOpenIcon,
  ListChecksIcon,
  ReceiptTextIcon,
  SearchIcon,
  TargetIcon,
  UserRoundIcon,
  type LucideIcon,
} from "lucide-react"
import type { SearchType } from "@/lib/schemas/search"

/** One grey outline icon per result type, the same as the command palette's (§3.4, DESIGN.md §3). */
export const SEARCH_TYPE_ICON: Readonly<Record<SearchType, LucideIcon>> = {
  client: Building2Icon,
  contact: ContactRoundIcon,
  task: ListChecksIcon,
  document: FolderOpenIcon,
  employee: UserRoundIcon,
  lead: TargetIcon,
  invoice: ReceiptTextIcon,
  quotation: FileTextIcon,
}

export function SearchTypeIcon({ type, className }: { type: SearchType; className?: string }) {
  const Icon = SEARCH_TYPE_ICON[type] ?? SearchIcon
  return <Icon aria-hidden="true" className={className ?? "size-4 flex-none text-text-muted"} />
}
