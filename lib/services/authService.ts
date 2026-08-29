/**
 * Authentication service.
 *
 * SWAP POINT — zkLogin.
 *   signIn() becomes: Google OIDC -> JWT -> zkLogin proof -> Sui address.
 * The interface only ever sees a TreasurySession, so replacing the body below
 * with the real ceremony changes nothing above this line.
 */

export interface TreasurySession {
  companyName: string;
  companyId: string;
  operatorName: string;
  operatorEmail: string;
  /** The zkLogin-derived Sui address in the real implementation. */
  address: string;
  provider: "google";
  signedInAt: string;
}

const DEMO_SESSION: Omit<TreasurySession, "signedInAt"> = {
  companyName: "Acme Corporation",
  companyId: "acme",
  operatorName: "Treasury Operator",
  operatorEmail: "treasury@acme.co",
  address: "0x4f2c8b91d7a3e650f2c8b91d7a3e650f2c8b91d7a3e650f2c8b91d7a3e650f2c",
  provider: "google",
};

/** Mocked zkLogin. The delay stands in for the proof round-trip. */
export async function signInWithGoogle(): Promise<TreasurySession> {
  await new Promise((resolve) => setTimeout(resolve, 420));
  return { ...DEMO_SESSION, signedInAt: new Date().toISOString() };
}

export function shortAddress(address: string, lead = 6, tail = 4): string {
  if (address.length <= lead + tail + 2) return address;
  return `${address.slice(0, lead)}…${address.slice(-tail)}`;
}
