import { cn } from "@/lib/utils"
import { parseNotice, type Inline } from "@/components/portal/markdown"

/**
 * The privacy notice as the firm wrote it (§6.10), rendered from its markdown as text: headings,
 * paragraphs, lists and bold. Readable line length; the page's own title is the h1, so the notice's
 * headings start one level down. Server-safe.
 */

function Text({ value }: { value: Inline }) {
  return (
    <>
      {value.map((s, i) =>
        s.bold ? (
          <strong key={i} className="font-semibold text-text">
            {s.text}
          </strong>
        ) : (
          <span key={i}>{s.text}</span>
        )
      )}
    </>
  )
}

export function PrivacyNotice({ body, className }: { body: string; className?: string }) {
  const blocks = parseNotice(body)
  // The notice's own top heading repeats the page title.
  const shown = blocks[0]?.kind === "h1" ? blocks.slice(1) : blocks
  return (
    <div className={cn("max-w-[70ch] text-base leading-6 text-text", className)}>
      {shown.map((b, i) => {
        switch (b.kind) {
          case "h1":
          case "h2":
            return (
              <h2 key={i} className="mt-6 mb-2 font-serif text-[19px] leading-7 font-medium tracking-[-0.005em] text-text first:mt-0">
                <Text value={b.text} />
              </h2>
            )
          case "h3":
            return (
              <h3 key={i} className="mt-4 mb-1.5 text-base font-semibold text-text first:mt-0">
                <Text value={b.text} />
              </h3>
            )
          case "ul":
          case "ol": {
            const List = b.kind === "ul" ? "ul" : "ol"
            return (
              <List key={i} className={cn("my-2 space-y-1 pl-5", b.kind === "ul" ? "list-disc" : "list-decimal")}>
                {b.items.map((item, j) => (
                  <li key={j}>
                    <Text value={item} />
                  </li>
                ))}
              </List>
            )
          }
          default:
            return (
              <p key={i} className="my-2">
                <Text value={b.text} />
              </p>
            )
        }
      })}
    </div>
  )
}
