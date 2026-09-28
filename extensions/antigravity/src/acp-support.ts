/**
 * Agent Client Protocol (ACP) Architecture Reference for Google Antigravity.
 *
 * This module explains and exposes helpers for the official ACP agent
 * (`agy_acp_server`), which is Google's officially published headless ACP binary
 * hosted on `https://dl.google.com/agy-extensions/releases/` and registered
 * in the Agent Client Protocol registry:
 * `https://github.com/agentclientprotocol/registry/blob/main/antigravity-acp/agent.json`
 *
 * Both T3 Code and this extension use official Google channels and standard protocols,
 * ensuring complete adherence to Google's Terms of Service.
 */

import * as os from "node:os";
import * as path from "node:path";
import * as fs from "node:fs";

export const ACP_REGISTRY_URL =
  "https://github.com/agentclientprotocol/registry/blob/main/antigravity-acp/agent.json";

export const ACP_RELEASE_VERSION = "agy_acp_server_1.1.1";

export interface AcpReleaseAsset {
  version: string;
  url: string;
  sha256: string;
  executableName: string;
  harnessName: string;
}

export const ACP_OFFICIAL_ASSETS: Record<string, AcpReleaseAsset> = {
  "win32-x64": {
    version: ACP_RELEASE_VERSION,
    url: `https://dl.google.com/agy-extensions/releases/windows/agy-acp-server-${ACP_RELEASE_VERSION}-windows-x86_64.zip`,
    sha256: "47cb50eef14f0a4655d78cfcfda869bcea7aaee5f9787e936bc2935ea612c3b8",
    executableName: "agy_acp_server.exe",
    harnessName: "localharness_external.exe",
  },
  "win32-arm64": {
    version: ACP_RELEASE_VERSION,
    url: `https://dl.google.com/agy-extensions/releases/windows/agy-acp-server-${ACP_RELEASE_VERSION}-windows-arm64.zip`,
    sha256: "35f4b1f47ba6a3fea7b0a3e30010df5ea73a64b4f0e7cf991cddc673ddfbcafc",
    executableName: "agy_acp_server.exe",
    harnessName: "localharness_external.exe",
  },
  "darwin-arm64": {
    version: ACP_RELEASE_VERSION,
    url: `https://dl.google.com/agy-extensions/releases/macos/agy-acp-server-${ACP_RELEASE_VERSION}-darwin-arm64.zip`,
    sha256: "fdfa915652cdb7ba8085cc8fffed072cbe009251aa2c951aabdda07a8c28a189",
    executableName: "agy_acp_server.par",
    harnessName: "localharness_external",
  },
  "linux-x64": {
    version: ACP_RELEASE_VERSION,
    url: `https://dl.google.com/agy-extensions/releases/linux/agy-acp-server-${ACP_RELEASE_VERSION}-linux-x86_64.zip`,
    sha256: "38f62d01b32deb0907b3d39a71ec301fd36369f6ffd1cf262d4af385177f79df",
    executableName: "agy_acp_server.par",
    harnessName: "localharness_external",
  },
};

/**
 * Resolves the official ACP asset metadata for the current platform.
 */
export function getAcpAssetForCurrentPlatform(): AcpReleaseAsset | null {
  const key = `${process.platform}-${process.arch}`;
  return ACP_OFFICIAL_ASSETS[key] || null;
}

/**
 * Returns the default managed ACP directory path.
 */
export function getAcpManagedDirectory(): string {
  return path.join(os.homedir(), ".gemini", "antigravity-acp");
}

/**
 * Checks if the official agy_acp_server binary is installed locally.
 */
export function findAcpServerBinary(): { executablePath: string; harnessPath: string } | null {
  const managedDir = getAcpManagedDirectory();
  const asset = getAcpAssetForCurrentPlatform();
  if (!asset) return null;

  const exePath = path.join(managedDir, asset.executableName);
  const harnessPath = path.join(managedDir, asset.harnessName);

  if (fs.existsSync(exePath) && fs.existsSync(harnessPath)) {
    return { executablePath: exePath, harnessPath };
  }

  return null;
}
