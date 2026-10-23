/**
 * A small, safe reader for the privacy notice's markdown (§5.12 privacy_notices.body, §6.10): the
 * headings, paragraphs, bullet and numbered lists and **bold** the seeded notice uses. It produces
 * plain data that React renders as text, so nothing in the notice is ever injected as HTML. Links
 * keep their words and show the address in brackets. Pure and client-safe.
 */

export type Inline = Array<{ text: string; bold: boolean }>

export type Block =
  | { kind: "h1" | "h2" | "h3"; text: Inline }
  | { kind: "p"; text: Inline }
  | { kind: "ul" | "ol"; items: Inline[] }

/** **bold** spans and plain text; [words](url) → "words (url)"; stray markers are dropped. */
export function parseInline(raw: string): Inline {
  const text = raw
    .replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_m, words: string, url: string) => (words.trim() === url.trim() ? url : `${words} (${url})`))
    .replace(/`([^`]+)`/g, "$1")
  const out: Inline = []
  const re = /\*\*(.+?)\*\*/g
  let last = 0
  for (let m = re.exec(text); m; m = re.exec(text)) {
    if (m.index > last) out.push({ text: text.slice(last, m.index), bold: false })
    out.push({ text: m[1], bold: true })
    last = m.index + m[0].length
  }
  if (last < text.length) out.push({ text: text.slice(last), bold: false })
  return out
    .map((s) => ({ ...s, text: s.text.replace(/(^|\s)[*_](\S)/g, "$1$2").replace(/(\S)[*_](\s|$)/g, "$1$2") }))
    .filter((s) => s.text.length > 0)
}

export function parseNotice(md: string | null | undefined): Block[] {
  const lines = (md ?? "").replace(/\r\n?/g, "\n").split("\n")
  const blocks: Block[] = []
  let para: string[] = []
  let list: { kind: "ul" | "ol"; items: string[] } | null = null

  const flushPara = () => {
    if (para.length) blocks.push({ kind: "p", text: parseInline(para.join(" ").replace(/\s+/g, " ").trim()) })
    para = []
  }
  const flushList = () => {
    if (list && list.items.length) blocks.push({ kind: list.kind, items: list.items.map((i) => parseInline(i.trim())) })
    list = null
  }

  for (const rawLine of lines) {
    const line = rawLine.trimEnd()
    const trimmed = line.trim()
    if (!trimmed) {
      flushPara()
      flushList()
      continue
    }
    const heading = /^(#{1,6})\s+(.*)$/.exec(trimmed)
    if (heading) {
      flushPara()
      flushList()
      const level = heading[1].length
      blocks.push({ kind: level === 1 ? "h1" : level === 2 ? "h2" : "h3", text: parseInline(heading[2].trim()) })
      continue
    }
    const bullet = /^[-*+]\s+(.*)$/.exec(trimmed)
    const numbered = /^\d+[.)]\s+(.*)$/.exec(trimmed)
    if (bullet || numbered) {
      flushPara()
      const kind = bullet ? "ul" : "ol"
      if (!list || list.kind !== kind) {
        flushList()
        list = { kind, items: [] }
      }
      list.items.push((bullet ?? numbered)![1])
      continue
    }
    if (list && /^\s{2,}\S/.test(line)) {
      // A wrapped list item continues on an indented line.
      list.items[list.items.length - 1] += ` ${trimmed}`
      continue
    }
    flushList()
    para.push(trimmed)
  }
  flushPara()
  flushList()
  return blocks
}
