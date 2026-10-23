/**
 * The portal's Help questions (§7.22 Help "FAQ"), in the order clients ask them. Plain sentences;
 * each answer names the page to go to. Client-safe data.
 */
export interface FaqItem {
  id: string
  question: string
  answer: string[]
  link?: { href: string; label: string }
}

export const PORTAL_FAQ: FaqItem[] = [
  {
    id: "upload",
    question: "How do I send the documents you've asked for?",
    answer: [
      "Open Documents. Each request lists the items we need; press Choose file next to an item, or on a phone, Take a photo.",
      "PDF, JPG, PNG, HEIC, CSV, Excel and Word files up to 25 MB each are accepted. If we can't use a file, the item shows why and you can upload it again.",
    ],
    link: { href: "/portal/documents", label: "Go to Documents" },
  },
  {
    id: "other-documents",
    question: "Can I send a document you haven't asked for?",
    answer: ["Yes. Write to us in Messages and attach the file (up to five at a time). It's saved to your file with us."],
    link: { href: "/portal/messages", label: "Open Messages" },
  },
  {
    id: "pay",
    question: "How do I pay an invoice?",
    answer: [
      "Open Invoices & payments and press Pay. Scan the UPI QR code with any UPI app, or on your phone open your UPI app with the amount filled in, or transfer to our bank account.",
      "Put the invoice number in the payment's remarks so we can match it quickly.",
    ],
    link: { href: "/portal/invoices", label: "Go to Invoices & payments" },
  },
  {
    id: "paid-still-due",
    question: "I've paid. Why does the invoice still show an amount due?",
    answer: [
      "Tell us with I've paid in the Pay dialog: the reference (UTR or transaction ID), the date and, if you like, a screenshot. We check it against our bank account and record the receipt.",
      "The invoice changes to Paid once the receipt is recorded, and the receipt appears under Receipts. Reporting a payment doesn't change the invoice by itself.",
    ],
  },
  {
    id: "tds",
    question: "I deducted TDS on your fees. What do I pay?",
    answer: [
      "Pay the balance after TDS, and mention the TDS amount in I've paid. TDS is worked out on our fee before GST.",
      "We record the TDS against the invoice and check that it reaches our tax statement (Form 26AS or the AIS), so please file your TDS return on time and send us the TDS certificate (Form 16A).",
    ],
  },
  {
    id: "statuses",
    question: "What do the statuses mean?",
    answer: [
      "Tap or hover over any status to see what it means. In short: Documents awaited means we need something from you; In progress means we have what we need and are preparing it; Filed means it's submitted on the government portal; Overdue means the due date has passed.",
    ],
  },
  {
    id: "acknowledgements",
    question: "Where do I find the acknowledgement number (ARN) of a return?",
    answer: [
      "Open Compliance and choose the year. Each filed return shows the date it was filed and its acknowledgement number, with a copy button. Where we've shared the acknowledgement itself, it downloads from the same row.",
    ],
    link: { href: "/portal/compliance", label: "Go to Compliance" },
  },
  {
    id: "extended",
    question: "Why does a deadline say it was extended?",
    answer: ["The government sometimes extends a due date by circular or notification. When it does, we move the date in your portal and show the circular it came from."],
    link: { href: "/portal/deadlines", label: "See your deadlines" },
  },
  {
    id: "privacy",
    question: "Who can see my information?",
    answer: [
      "Only you, through this login, and the people at the firm who work on your account. Your files are stored privately and every download link lasts a minute.",
      "The privacy notice explains what we collect, why, how long we keep it and your rights.",
    ],
    link: { href: "/portal/welcome", label: "Read the privacy notice" },
  },
  {
    id: "password",
    question: "How do I change my password, or what if I forget it?",
    answer: [
      "Sign out, then choose Forgot password? on the sign-in page and we'll email you a link to set a new one. Keep your login to yourself: it opens your financial records.",
    ],
  },
  {
    id: "problem",
    question: "Something isn't working. What should I do?",
    answer: ["Send us a message, or call the office. If the screen showed a Ref, include it: it helps us find what went wrong."],
  },
]
