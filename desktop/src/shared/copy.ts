/**
 * Every sentence TaxWise Desktop shows, in one place (§3.4 writing voice: say what happened and
 * what to do next; never blame the user). Wording fixed by the spec is quoted exactly.
 */

export const COPY = {
  /** §7.25.4 */
  linkThisPc: (label: string) =>
    `Link this PC: on the ${label} phone, open WhatsApp → Settings → Linked devices → Link a device, and scan this code.`,
  linkOwnNumberOnlyHere: "Link your own number only on your own PC.",
  fourteenDayRule: "Open the phone at least every 14 days, or WhatsApp unlinks this PC.",

  /** §7.25.5 */
  couldNotFind: (groupName: string, label: string) =>
    `Couldn't find '${groupName}' on the ${label} WhatsApp. Check the group name, or that this number is in the group.`,
  notOneOfYourClients: "Not one of your clients",
  notOneOfYourClientsDetail: "This chat was closed. Open a client's chat from their page in TaxWise.",
  clientModeIdleTitle: "Client mode",
  clientModeIdleDetail: "Open a client's chat from their page in TaxWise. Only that chat shows here.",
  opening: (groupName: string) => `Opening ${groupName}…`,
  clientModeUnavailable: "Client mode is unavailable because WhatsApp changed its page. A Partner has been told.",
  clientModeChip: (clientName: string) => `${clientName} · client mode`,
  clientModeChipIdle: "Client mode",

  /** §7.25.7 removed PC */
  removedTitle: "This PC was removed from TaxWise",
  removedDetail:
    "A Partner removed this PC in Settings → Linked PCs, so its WhatsApp data has been cleared and TaxWise no longer accepts it.",
  removedPartnerReminder:
    "Partners: also remove this PC from each phone's list (WhatsApp → Settings → Linked devices), so the phone stops trusting it.",

  noNumbersTitle: "No WhatsApp number for you on this PC",
  noNumbersDetail: "Ask a Partner which firm number you use in TaxWise Desktop.",
  linkTitle: "Link a WhatsApp number on this PC",
  linkDetail: "Choose a number, then scan the code with its phone. The number stays linked on this PC for whoever signs in next, and shows only to people who may use it.",
  linkNumber: (label: string) => `Link ${label}`,
  notLinkedYet: "not linked yet",
  loading: "Loading WhatsApp…",
  offlineTitle: "Can't reach TaxWise",
  offlineDetail: "WhatsApp comes back here as soon as TaxWise answers again.",

  signInFirst: "Sign in to TaxWise first.",
  notLinkedHere: (label: string) =>
    `The ${label} WhatsApp isn't linked on this PC yet. Scan the code in the WhatsApp panel to link it.`,
  numberNotYours: "This client's group is on a WhatsApp number you don't use in TaxWise Desktop.",
  pcRemoved: "This PC was removed from TaxWise, so WhatsApp can't open here.",
  whatsappNotReady: "WhatsApp didn't finish loading. Try Open chat again in a moment.",

  downloadTitle: "Save this file from WhatsApp?",
  downloadDetail: (fileName: string) => fileName,
} as const;
