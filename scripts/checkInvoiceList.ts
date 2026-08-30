/**
 * Read-only check: does invoice discovery see the post-seed conditional pair?
 *
 * Queries only. Submits nothing.
 */
import { discoverInvoices } from "../lib/sui/chainReader";
import { createSuiQueries, graphqlUrlFor } from "../lib/sui/client";
import { configuredNetwork, loadManifest } from "../lib/sui/manifest";
import { resolveInvoiceSource } from "../lib/demo/invoiceSource";

async function main() {
  const network = configuredNetwork();
  const manifest = loadManifest(network);
  const queries = createSuiQueries(network);
  const invoices = await discoverInvoices(queries, manifest, graphqlUrlFor(network));

  console.log(`network=${network}  discovered=${invoices.length}`);
  for (const invoice of invoices) {
    const source = resolveInvoiceSource(invoice.invoiceNumber);
    console.log(
      `  ${invoice.invoiceNumber}  ${invoice.status.padEnd(9)}  ` +
        `$${(invoice.amountCents / 100).toLocaleString("en-US").padStart(8)}  ` +
        `doc=${source ? source.kind : "NONE"}  ${invoice.objectId.slice(0, 12)}`,
    );
  }
}

void main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
