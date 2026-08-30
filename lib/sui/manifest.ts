/**
 * Loads the deployment manifest.
 *
 * The manifest is the ONLY place package and object ids live. Nothing in the
 * application may hardcode one — re-deploying should mean regenerating a single
 * file, not hunting identifiers through component source.
 *
 * Server-side only: it reads from disk, and the ids are needed before any chain
 * call can be made. The browser receives resolved data through /api/chain, not
 * the manifest itself.
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import {
  isDeploymentManifest,
  manifestPath,
  type DeploymentManifest,
  type SuiNetwork,
} from "./deployment";

export class MissingDeploymentError extends Error {
  constructor(readonly network: SuiNetwork) {
    super(
      `No deployment manifest at ${manifestPath(network)}. ` +
        `The application cannot read chain state until the package is deployed.`,
    );
    this.name = "MissingDeploymentError";
  }
}

/** Which network the app reads from. Never mainnet — nothing here is audited. */
export function configuredNetwork(env: NodeJS.ProcessEnv = process.env): SuiNetwork {
  const requested = env.NEXT_PUBLIC_SUI_NETWORK ?? env.PAYFLOW_SUI_NETWORK ?? "testnet";
  if (requested === "testnet" || requested === "devnet" || requested === "localnet") {
    return requested;
  }
  throw new Error(
    `Unsupported Sui network "${requested}". AI PayFlow reads only testnet, devnet or localnet.`,
  );
}

let cached: { network: SuiNetwork; manifest: DeploymentManifest } | null = null;

/**
 * Cached per process. The manifest changes only on redeploy, and a server
 * restart follows that, so re-reading it on every request buys nothing.
 */
export function loadManifest(network: SuiNetwork = configuredNetwork()): DeploymentManifest {
  if (cached && cached.network === network) return cached.manifest;

  // The "deployments" segment is a literal on purpose. A fully dynamic path
  // makes Next's static analysis trace the entire project into the server
  // bundle, because it cannot tell which files might be read.
  const path = resolve(process.cwd(), "deployments", `${network}.json`);
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    throw new MissingDeploymentError(network);
  }
  if (!isDeploymentManifest(parsed)) {
    throw new Error(`Malformed deployment manifest at ${path}`);
  }
  if (parsed.network !== network) {
    throw new Error(
      `Manifest at ${path} is for ${parsed.network}, but the app is configured for ${network}.`,
    );
  }

  cached = { network, manifest: parsed };
  return parsed;
}

/** Test seam — the cache would otherwise outlive a fixture swap. */
export function clearManifestCache(): void {
  cached = null;
}
