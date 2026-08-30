/**
 * Where shipment proof lives, and what the chain is told about it.
 *
 * The document itself never goes on chain — it would be expensive, permanent,
 * and pointless, since Move cannot read a PDF. What goes on chain is a
 * reference and a hash. The hash is the load-bearing half: a blob id says where
 * the bytes were, but only the digest says WHICH bytes were attested, and it
 * keeps saying so after the blob has expired or the storage provider has gone
 * away.
 *
 * Two implementations behind one interface. Walrus is the real evidence layer
 * and the one the architecture claims; the local store exists because a live
 * network dependency in the middle of a demo is the failure you cannot recover
 * from on stage. Both compute the same digest over the same bytes, so an
 * attestation made against either is verifiable the same way.
 */

import { createHash } from "node:crypto";

/** How the bytes were stored. Surfaced in the UI rather than glossed over. */
export type ProofStorageKind = "walrus" | "demo";

export interface StoredProof {
  /** Opaque reference. A Walrus blob id, or `demo:<digest>` locally. */
  blobId: string;
  /** Lowercase hex SHA-256 of the exact bytes stored. */
  sha256: string;
  byteLength: number;
  contentType: string;
  filename: string;
  storage: ProofStorageKind;
  /** Where a human can go and look, when the backing store has a reader. */
  url: string | null;
  storedAt: string;
}

export interface ProofStore {
  readonly kind: ProofStorageKind;
  put(input: ProofInput): Promise<StoredProof>;
  /** Null when the store cannot produce the bytes again. */
  get(blobId: string): Promise<Uint8Array | null>;
}

export interface ProofInput {
  bytes: Uint8Array;
  filename: string;
  contentType: string;
}

export function sha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/**
 * Verifies a document against what was attested.
 *
 * This is the function that makes the whole evidence chain checkable by someone
 * who trusts none of it: fetch the blob, hash it, compare to the attestation.
 */
export function proofMatches(bytes: Uint8Array, attestedSha256: string): boolean {
  return sha256Hex(bytes) === attestedSha256.toLowerCase().replace(/^0x/, "");
}

// --- Local ---------------------------------------------------------------------

/**
 * In-process store. Content-addressed, so it behaves like the real one: the
 * same bytes always yield the same reference.
 */
export function createLocalProofStore(): ProofStore {
  const blobs = new Map<string, Uint8Array>();

  return {
    kind: "demo",
    async put(input) {
      const sha256 = sha256Hex(input.bytes);
      const blobId = `demo:${sha256.slice(0, 32)}`;
      blobs.set(blobId, input.bytes);
      return {
        blobId,
        sha256,
        byteLength: input.bytes.byteLength,
        contentType: input.contentType,
        filename: input.filename,
        storage: "demo",
        url: null,
        storedAt: new Date().toISOString(),
      };
    },
    async get(blobId) {
      return blobs.get(blobId) ?? null;
    },
  };
}

// --- Walrus --------------------------------------------------------------------

export interface WalrusConfig {
  /** Publisher base URL, e.g. https://publisher.walrus-testnet.walrus.space */
  publisherUrl: string;
  /** Aggregator base URL, for reading blobs back. */
  aggregatorUrl: string;
  /** How many epochs the blob should be kept for. */
  epochs: number;
}

export function readWalrusConfig(
  env: Record<string, string | undefined> = process.env,
): WalrusConfig | null {
  const publisherUrl = env.WALRUS_PUBLISHER_URL?.trim();
  const aggregatorUrl = env.WALRUS_AGGREGATOR_URL?.trim();
  if (!publisherUrl || !aggregatorUrl) return null;

  const epochs = Number(env.WALRUS_EPOCHS ?? "5");
  return {
    publisherUrl: publisherUrl.replace(/\/+$/, ""),
    aggregatorUrl: aggregatorUrl.replace(/\/+$/, ""),
    epochs: Number.isFinite(epochs) && epochs > 0 ? Math.floor(epochs) : 5,
  };
}

export class WalrusError extends Error {
  constructor(
    message: string,
    readonly status: number | null,
  ) {
    super(message);
    this.name = "WalrusError";
  }
}

/**
 * Walrus testnet over its HTTP publisher/aggregator.
 *
 * The response shape differs depending on whether the blob is newly certified
 * or already known to the network, so both are handled — a re-upload of the
 * same document is a success, not an error, and content-addressed storage makes
 * it likely during a rehearsal.
 */
export function createWalrusProofStore(config: WalrusConfig): ProofStore {
  return {
    kind: "walrus",
    async put(input) {
      const sha256 = sha256Hex(input.bytes);
      const url = `${config.publisherUrl}/v1/blobs?epochs=${config.epochs}`;

      const response = await fetch(url, {
        method: "PUT",
        body: input.bytes as unknown as BodyInit,
        headers: { "content-type": "application/octet-stream" },
      });

      if (!response.ok) {
        throw new WalrusError(
          `Walrus publisher refused the blob (HTTP ${response.status}).`,
          response.status,
        );
      }

      const body: unknown = await response.json();
      const blobId = readBlobId(body);
      if (!blobId) {
        throw new WalrusError("Walrus accepted the blob but returned no blob id.", null);
      }

      return {
        blobId,
        sha256,
        byteLength: input.bytes.byteLength,
        contentType: input.contentType,
        filename: input.filename,
        storage: "walrus",
        url: `${config.aggregatorUrl}/v1/blobs/${blobId}`,
        storedAt: new Date().toISOString(),
      };
    },

    async get(blobId) {
      const response = await fetch(`${config.aggregatorUrl}/v1/blobs/${blobId}`);
      if (!response.ok) return null;
      return new Uint8Array(await response.arrayBuffer());
    },
  };
}

/** `newlyCreated` on first upload, `alreadyCertified` on a repeat. */
function readBlobId(body: unknown): string | null {
  if (typeof body !== "object" || body === null) return null;
  const root = body as Record<string, unknown>;

  const created = root.newlyCreated;
  if (typeof created === "object" && created !== null) {
    const blobObject = (created as Record<string, unknown>).blobObject;
    if (typeof blobObject === "object" && blobObject !== null) {
      const id = (blobObject as Record<string, unknown>).blobId;
      if (typeof id === "string" && id.length > 0) return id;
    }
  }

  const certified = root.alreadyCertified;
  if (typeof certified === "object" && certified !== null) {
    const id = (certified as Record<string, unknown>).blobId;
    if (typeof id === "string" && id.length > 0) return id;
  }

  return null;
}

// --- Selection -----------------------------------------------------------------

export interface ProofStoreSelection {
  store: ProofStore;
  /** True when the real evidence layer is in use. */
  live: boolean;
  /** Why the local store was chosen, when it was. */
  reason: string | null;
}

/**
 * Walrus when it is configured, the local store otherwise — and the caller is
 * told which, so the interface can say so rather than implying evidence is
 * decentralised when it is sitting in memory.
 */
export function selectProofStore(
  env: Record<string, string | undefined> = process.env,
): ProofStoreSelection {
  const config = readWalrusConfig(env);
  if (!config) {
    return {
      store: createLocalProofStore(),
      live: false,
      reason:
        "WALRUS_PUBLISHER_URL and WALRUS_AGGREGATOR_URL are not set, so proof is stored locally for this session.",
    };
  }
  return { store: createWalrusProofStore(config), live: true, reason: null };
}
