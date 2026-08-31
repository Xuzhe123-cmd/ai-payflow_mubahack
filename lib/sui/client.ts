/**
 * The seam between the application and the Sui network.
 *
 * `ChainQueries` is deliberately tiny — three read operations. That narrowness
 * is the point: chainReader.ts is written against this interface rather than a
 * transport, so it can be tested against recorded testnet payloads with no
 * network, and no other module gains the ability to sign anything.
 *
 * There is no write path here. Executing payments is a later phase.
 *
 * ## Why GraphQL rather than the JSON-RPC client
 *
 * `SuiJsonRpcClient` no longer works against public fullnodes. As of 1.78 they
 * answer every JSON-RPC method with:
 *
 *   "Method not found. JSON-RPC on public fullnodes has been deprecated.
 *    Please migrate to gRPC or GraphQL endpoints."
 *
 * Of the two replacements, GraphQL returns Move structs already decoded to JSON
 * (`contents.json`), which is exactly what a reader wants. The gRPC client
 * returns objects whose `content` needs a read mask that did not yield parsed
 * fields in testing, so it would mean decoding BCS by hand for no benefit.
 */

import type { SuiNetwork } from "./deployment";

export interface DynamicFieldEntry {
  /** The table key, already decoded — a supplier id, an AgentCap id. */
  name: unknown;
  /** The stored value, already decoded. */
  value: unknown;
  /**
   * The key's Move type, as `0x…::module::Struct`.
   *
   * Needed because a key can be an EMPTY struct — `CircuitBreakerKey {}` has no
   * fields, so `name` decodes to an empty object and carries nothing to match
   * on. The type is the only thing that identifies such a field.
   *
   * Optional so the existing test fakes, which key by address and have no need
   * of it, stay valid without being rewritten.
   */
  nameType?: string | null;
}

/** Everything the reader needs. Read-only, by construction. */
export interface ChainQueries {
  /** Decoded Move fields of one object, or null when it does not exist. */
  getObjectFields(objectId: string): Promise<unknown>;
  /** Same, batched. Missing objects are omitted rather than returned as null. */
  multiGetObjectFields(objectIds: string[]): Promise<unknown[]>;
  /** Every page of dynamic fields under a parent id, already followed. */
  getDynamicFields(parentId: string): Promise<DynamicFieldEntry[]>;
  /**
   * The object's current version, as the INDEX sees it.
   *
   * Optional so existing fakes need not implement it. It exists to tell two
   * situations apart that otherwise look identical: an object whose state is
   * genuinely not what was expected, and an object the indexer has simply not
   * caught up to. A version still sitting at its pre-transaction value is the
   * second, and treating it as the first is how a successful release came to be
   * reported as a failed one.
   */
  getObjectVersion?(objectId: string): Promise<string | null>;
}

export function graphqlUrlFor(network: SuiNetwork): string {
  if (network === "localnet") return "http://127.0.0.1:9125/graphql";
  return `https://graphql.${network}.sui.io/graphql`;
}

interface GraphQLResponse<T> {
  data?: T;
  errors?: { message: string }[];
}

export class SuiGraphQLError extends Error {
  constructor(message: string) {
    super(`Sui GraphQL: ${message}`);
    this.name = "SuiGraphQLError";
  }
}

const OBJECT_FIELDS = `asMoveObject { contents { json } }`;

/** One page of dynamic fields; 50 is the server's practical maximum. */
const PAGE_SIZE = 50;

/** Named so the pagination loop is not inferring its own type recursively. */
interface DynamicFieldPage {
  address: {
    dynamicFields: {
      pageInfo: { hasNextPage: boolean; endCursor: string | null };
      nodes: {
        name: { json: unknown; type?: { repr?: string } | null } | null;
        value: { json?: unknown } | null;
      }[];
    };
  } | null;
}

export function createSuiQueries(network: SuiNetwork): ChainQueries {
  const url = graphqlUrlFor(network);

  async function query<T>(text: string, variables: Record<string, unknown>): Promise<T> {
    const response = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ query: text, variables }),
      // Chain state moves; a cached balance is a lie with a timestamp on it.
      cache: "no-store",
    });
    if (!response.ok) {
      throw new SuiGraphQLError(`${response.status} ${response.statusText} from ${url}`);
    }
    const payload = (await response.json()) as GraphQLResponse<T>;
    if (payload.errors?.length) {
      throw new SuiGraphQLError(payload.errors.map((error) => error.message).join("; "));
    }
    if (!payload.data) throw new SuiGraphQLError("response contained no data");
    return payload.data;
  }

  return {
    async getObjectFields(objectId) {
      const data = await query<{ object: { asMoveObject?: { contents?: { json?: unknown } } } | null }>(
        `query($id: SuiAddress!) { object(address: $id) { ${OBJECT_FIELDS} } }`,
        { id: objectId },
      );
      return data.object?.asMoveObject?.contents?.json ?? null;
    },

    async getObjectVersion(objectId) {
      const data = await query<{ object: { version?: number | string } | null }>(
        `query($id: SuiAddress!) { object(address: $id) { version } }`,
        { id: objectId },
      );
      const version = data.object?.version;
      return version === undefined || version === null ? null : String(version);
    },

    async multiGetObjectFields(objectIds) {
      if (objectIds.length === 0) return [];
      const data = await query<{
        multiGetObjects: ({ asMoveObject?: { contents?: { json?: unknown } } } | null)[];
      }>(
        `query($keys: [ObjectKey!]!) { multiGetObjects(keys: $keys) { ${OBJECT_FIELDS} } }`,
        { keys: objectIds.map((address) => ({ address })) },
      );
      return data.multiGetObjects
        .map((node) => node?.asMoveObject?.contents?.json ?? null)
        .filter((fields) => fields !== null);
    },

    async getDynamicFields(parentId) {
      // A Table's id is a field parent, not a standalone object, so it is
      // reached through `address` rather than `object` — the latter returns
      // null for it.
      const text = `query($id: SuiAddress!, $after: String) {
        address(address: $id) {
          dynamicFields(first: ${PAGE_SIZE}, after: $after) {
            pageInfo { hasNextPage endCursor }
            nodes {
              name { json type { repr } }
              value { __typename ... on MoveValue { json } }
            }
          }
        }
      }`;

      const entries: DynamicFieldEntry[] = [];
      let after: string | null = null;
      for (;;) {
        const data: DynamicFieldPage = await query<DynamicFieldPage>(text, {
          id: parentId,
          after,
        });

        const page = data.address?.dynamicFields;
        if (!page) break;
        for (const node of page.nodes) {
          entries.push({
            name: node.name?.json ?? null,
            value: node.value?.json ?? null,
            nameType: node.name?.type?.repr ?? null,
          });
        }
        if (!page.pageInfo.hasNextPage || !page.pageInfo.endCursor) break;
        after = page.pageInfo.endCursor;
      }
      return entries;
    },
  };
}
