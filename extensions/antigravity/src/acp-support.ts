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
 * Checks custom env var, managed directory, T3 Code install directory, and PATH.
 */
export function findAcpServerBinary(): { executablePath: string; harnessPath: string } | null {
  const asset = getAcpAssetForCurrentPlatform();
  if (!asset) return null;

  const candidateDirs: string[] = [];

  // 1. Explicit environment variable override
  if (process.env.ANTIGRAVITY_ACP_PATH) {
    candidateDirs.push(process.env.ANTIGRAVITY_ACP_PATH);
  }
  if (process.env.AGY_ACP_PATH) {
    candidateDirs.push(process.env.AGY_ACP_PATH);
  }

  const userHome = os.homedir();

  // 2. Default Pi managed directory (~/.gemini/antigravity-acp)
  candidateDirs.push(getAcpManagedDirectory());

  // 3. T3 Code managed tools directory (~/.t3/tools/antigravity-acp/<platform-arch>)
  const platformKey = `${process.platform}-${process.arch}`;
  candidateDirs.push(
    path.join(userHome, ".t3", "tools", "antigravity-acp", platformKey),
    path.join(userHome, ".t3", "tools", "antigravity-acp")
  );

  for (const dir of candidateDirs) {
    const exePath = path.join(dir, asset.executableName);
    const harnessPath = path.join(dir, asset.harnessName);

    if (fs.existsSync(exePath) && fs.existsSync(harnessPath)) {
      return { executablePath: exePath, harnessPath };
    }
  }

  // 4. PATH search
  const pathEnv = process.env.PATH || "";
  const pathDirs = pathEnv.split(path.delimiter);
  for (const dir of pathDirs) {
    const exePath = path.join(dir, asset.executableName);
    const harnessPath = path.join(dir, asset.harnessName);
    if (fs.existsSync(exePath) && fs.existsSync(harnessPath)) {
      return { executablePath: exePath, harnessPath };
    }
  }

  return null;
}

/**
 * Downloads and installs the official Google ACP bundle for this machine.
 * Verifies the official SHA-256 checksum and extracts the archive.
 */
export async function installAcpServer(
  onProgress?: (msg: string) => void
): Promise<{ executablePath: string; harnessPath: string }> {
  const asset = getAcpAssetForCurrentPlatform();
  if (!asset) {
    throw new Error(`Unsupported platform: ${process.platform}-${process.arch}`);
  }

  const existing = findAcpServerBinary();
  if (existing) {
    onProgress?.(`Google Antigravity ACP already installed at: ${existing.executablePath}`);
    return existing;
  }

  const managedDir = getAcpManagedDirectory();
  await fs.promises.mkdir(managedDir, { recursive: true });

  const tempZip = path.join(managedDir, `agy-acp-${Date.now()}.zip`);
  onProgress?.(`Connecting to Google CDN for official release (${asset.version})...`);

  // 1. Download archive via native fetch with streaming
  const response = await fetch(asset.url);
  if (!response.ok || !response.body) {
    throw new Error(`Failed to download ACP release: HTTP ${response.status} ${response.statusText}`);
  }

  const { createHash } = await import("node:crypto");
  const { Readable } = await import("node:stream");
  const { pipeline } = await import("node:stream/promises");
  const { Transform } = await import("node:stream");

  const hash = createHash("sha256");
  let receivedBytes = 0;
  const totalBytes = Number(response.headers.get("content-length")) || 0;
  let lastReportedTime = Date.now();

  const progressAndHashStream = new Transform({
    transform(chunk, _encoding, callback) {
      hash.update(chunk);
      receivedBytes += chunk.length;
      const now = Date.now();
      if (now - lastReportedTime > 1500 || (totalBytes > 0 && receivedBytes === totalBytes)) {
        lastReportedTime = now;
        const mb = (receivedBytes / (1024 * 1024)).toFixed(1);
        const totalMb = totalBytes > 0 ? (totalBytes / (1024 * 1024)).toFixed(1) : "?";
        onProgress?.(`Downloading ACP bundle: ${mb} MB / ${totalMb} MB...`);
      }
      callback(null, chunk);
    },
  });

  const fileStream = fs.createWriteStream(tempZip);

  // @ts-expect-error Node 18+ Web ReadableStream to Node stream conversion
  const webNodeStream = Readable.fromWeb(response.body);

  await pipeline(webNodeStream, progressAndHashStream, fileStream);

  // 2. Verify SHA-256 checksum
  onProgress?.("Verifying Google official package integrity (SHA-256)...");
  const computedSha = hash.digest("hex");
  if (computedSha.toLowerCase() !== asset.sha256.toLowerCase()) {
    try {
      await fs.promises.unlink(tempZip);
    } catch {}
    throw new Error(
      `Checksum verification failed for ACP archive. Expected ${asset.sha256}, got ${computedSha}`
    );
  }

  // 3. Extract using platform tar
  onProgress?.("Extracting ACP server and localharness...");
  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  const execFileAsync = promisify(execFile);

  await execFileAsync("tar", ["-xf", tempZip, "-C", managedDir], {
    windowsHide: true,
  });

  // Clean up zip
  try {
    await fs.promises.unlink(tempZip);
  } catch {}

  // Make executable on unix
  const exePath = path.join(managedDir, asset.executableName);
  const harnessPath = path.join(managedDir, asset.harnessName);

  if (process.platform !== "win32") {
    try {
      await fs.promises.chmod(exePath, 0o755);
      await fs.promises.chmod(harnessPath, 0o755);
    } catch {}
  }

  if (!fs.existsSync(exePath) || !fs.existsSync(harnessPath)) {
    throw new Error("Extracted ACP bundle is missing required executables.");
  }

  onProgress?.("Google Antigravity ACP runtime installed and verified successfully!");
  return { executablePath: exePath, harnessPath };
}

/**
 * Checks if the official agy_acp_server has an existing saved OAuth token.
 */
export function isAcpAuthenticated(): boolean {
  const managedDir = getAcpManagedDirectory();
  const tokenFile = path.join(managedDir, "acp_token.json");
  if (fs.existsSync(tokenFile)) {
    try {
      const stats = fs.statSync(tokenFile);
      if (stats.size > 20) return true;
    } catch {}
  }
  return false;
}

/**
 * Runs the interactive Google OAuth login flow for agy_acp_server.
 * Intercepts the Google auth URL, opens it in the user's default browser,
 * and waits for the local callback server in ACP to capture the credentials.
 */
export async function authenticateAcpServer(
  onStatus?: (msg: string) => void
): Promise<{ success: boolean; message: string }> {
  const binary = findAcpServerBinary();
  if (!binary) {
    throw new Error("ACP server is not installed. Run install first.");
  }

  const userHome = os.homedir();
  const { spawn, execFile } = await import("node:child_process");
  const readline = await import("node:readline");

  const child = spawn(binary.executablePath, [], {
    env: {
      ...process.env,
      ANTIGRAVITY_HARNESS_PATH: binary.harnessPath,
      AGY_ACP_FORCE_FILE_STORAGE: "1",
      PYTHONUNBUFFERED: "1",
      ELECTRON_RUN_AS_NODE: "1",
      GEMINI_HOME: path.join(userHome, ".gemini"),
    },
    windowsHide: true,
    stdio: ["pipe", "pipe", "pipe"],
  });

  return new Promise<{ success: boolean; message: string }>((resolve, reject) => {
    let resolved = false;
    let browserOpened = false;

    const timeout = setTimeout(() => {
      if (!resolved) {
        resolved = true;
        child.kill();
        reject(new Error("ACP authentication timed out (120s)."));
      }
    }, 120_000);

    const openBrowser = (url: string) => {
      if (browserOpened) return;
      browserOpened = true;
      onStatus?.(`Opening browser for Google login:\n${url}`);
      if (process.platform === "win32") {
        execFile("cmd", ["/c", "start", "", url]);
      } else if (process.platform === "darwin") {
        execFile("open", [url]);
      } else {
        execFile("xdg-open", [url]);
      }
    };

    const handleOutput = (text: string) => {
      const authPrefix = "Open the following link to authenticate the ACP server: ";
      const idx = text.indexOf(authPrefix);
      if (idx !== -1) {
        const urlPart = text.slice(idx + authPrefix.length).trim().split(/\s+/)[0];
        if (urlPart && urlPart.startsWith("https://")) {
          openBrowser(urlPart);
        }
      }
    };

    child.stderr?.on("data", (chunk) => handleOutput(chunk.toString()));

    const rl = readline.createInterface({ input: child.stdout!, crlfDelay: Infinity });
    rl.on("line", (line) => {
      handleOutput(line);
      try {
        const msg = JSON.parse(line.trim());
        if (msg.id === 1 && msg.result) {
          // Send authenticate
          child.stdin?.write(
            JSON.stringify({
              jsonrpc: "2.0",
              id: 2,
              method: "authenticate",
              params: { methodId: "oauth-personal" },
            }) + "\n"
          );
        } else if (msg.id === 2) {
          clearTimeout(timeout);
          resolved = true;
          child.kill();
          if (msg.error) {
            reject(new Error(msg.error.message || JSON.stringify(msg.error)));
          } else {
            resolve({
              success: true,
              message: "Google account successfully authenticated with ACP server!",
            });
          }
        }
      } catch {}
    });

    child.on("close", (code) => {
      clearTimeout(timeout);
      if (!resolved) {
        resolved = true;
        if (isAcpAuthenticated()) {
          resolve({ success: true, message: "Authenticated successfully." });
        } else {
          reject(new Error(`ACP server process exited prematurely with code ${code}`));
        }
      }
    });

    child.on("error", (err) => {
      clearTimeout(timeout);
      if (!resolved) {
        resolved = true;
        reject(err);
      }
    });

    // Send initialize
    child.stdin?.write(
      JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: 1,
          clientInfo: { name: "pi-agent", version: "1.0.0" },
          clientCapabilities: {
            fs: { readTextFile: false, writeTextFile: false },
            terminal: false,
          },
        },
      }) + "\n"
    );
  });
}

