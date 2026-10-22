/**
 * One persistent partition per firm number: persist:wa-<number_id> (§7.25.3). Numbers never share
 * data, and each number's WhatsApp login survives restarts. A PC a Partner removed wipes every
 * one of them (§7.25.7, §18.3 Partner 13).
 */

import type { Session } from "electron";

const NUMBER_ID = /^[A-Za-z0-9-]{1,64}$/;

export function waPartition(numberId: string): string {
  if (!NUMBER_ID.test(numberId)) throw new Error("Invalid number id for a partition name");
  return `persist:wa-${numberId}`;
}

export function isWaPartition(name: string): boolean {
  return /^persist:wa-[A-Za-z0-9-]{1,64}$/.test(name);
}

/** Electron keeps persist:<name> partitions in userData/Partitions/<name>. */
export function waPartitionsFromDirNames(dirNames: readonly string[]): string[] {
  return dirNames.filter((d) => /^wa-[A-Za-z0-9-]{1,64}$/.test(d)).map((d) => `persist:${d}`);
}

/** Every WhatsApp partition to wipe: the ones this PC recorded plus any found on disk. */
export function partitionsToWipe(recorded: readonly string[], onDisk: readonly string[]): string[] {
  return [...new Set([...recorded.filter(isWaPartition), ...waPartitionsFromDirNames(onDisk)])].sort();
}

export type WipeableSession = Pick<Session, "clearStorageData" | "clearCache" | "clearAuthCache">;

/** Clears cookies, storage, service workers, caches and auth for each partition. Returns the names wiped. */
export async function wipeWhatsAppPartitions(names: readonly string[], fromPartition: (name: string) => WipeableSession): Promise<string[]> {
  const wiped: string[] = [];
  for (const name of names) {
    if (!isWaPartition(name)) continue;
    const ses = fromPartition(name);
    await ses.clearStorageData();
    await ses.clearCache();
    await ses.clearAuthCache();
    wiped.push(name);
  }
  return wiped;
}
