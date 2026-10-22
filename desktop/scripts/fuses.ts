/**
 * electron-builder afterPack hook: flips Electron's fuses in the packaged binary before it is
 * signed (§7.25.3 security):
 *   RunAsNode off · EnableNodeCliInspectArguments off · EnableEmbeddedAsarIntegrityValidation on ·
 *   OnlyLoadAppFromAsar on · EnableCookieEncryption on
 * plus NODE_OPTIONS ignored and no extra file:// privileges (the app never uses file:// pages).
 */

import path from "node:path";
import { flipFuses, FuseV1Options, FuseVersion, type FuseV1Config } from "@electron/fuses";
import type { AfterPackContext } from "electron-builder";

export const FUSES: FuseV1Config = {
  version: FuseVersion.V1,
  [FuseV1Options.RunAsNode]: false,
  [FuseV1Options.EnableNodeCliInspectArguments]: false,
  [FuseV1Options.EnableEmbeddedAsarIntegrityValidation]: true,
  [FuseV1Options.OnlyLoadAppFromAsar]: true,
  [FuseV1Options.EnableCookieEncryption]: true,
  [FuseV1Options.EnableNodeOptionsEnvironmentVariable]: false,
  [FuseV1Options.GrantFileProtocolExtraPrivileges]: false,
};

/** Where electron-builder put the Electron binary for a platform. */
export function electronBinaryPath(platform: string, appOutDir: string, productFilename: string, executableName: string): string {
  if (platform === "darwin" || platform === "mas") return path.join(appOutDir, `${productFilename}.app`);
  if (platform === "win32") return path.join(appOutDir, `${productFilename}.exe`);
  return path.join(appOutDir, executableName);
}

/** electron-builder's Arch enum: 3 is arm64. Apple silicon needs its ad-hoc signature reset after flipping. */
const ARM64 = 3;

export default async function afterPack(context: AfterPackContext): Promise<void> {
  const platform = context.electronPlatformName;
  const info = context.packager.appInfo;
  const linuxName = (context.packager as { executableName?: string }).executableName ?? info.sanitizedName;
  const binary = electronBinaryPath(platform, context.appOutDir, info.productFilename, linuxName);
  await flipFuses(binary, {
    ...FUSES,
    resetAdHocDarwinSignature: platform === "darwin" && context.arch === ARM64,
  });
  console.log(`fuses: flipped in ${binary}`);
}
