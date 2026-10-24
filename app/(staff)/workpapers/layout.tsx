import { WorkpapersNav } from "@/components/workpapers/shared/workpapers-nav"

/**
 * Every workpaper page (§7.8): the four workpapers as a link row, then the page. It loads nothing,
 * so it can't fail (§0.1 rule 3); each page checks who may see it (Employees: their own clients,
 * §4.1) and the staff layout's error boundary catches the rest.
 */
export default function WorkpapersLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex min-w-0 flex-col">
      <WorkpapersNav />
      {children}
    </div>
  )
}
