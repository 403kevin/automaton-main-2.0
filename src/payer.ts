/** Who paid an inbound transfer. Legacy rows leave this unset and count as outside. */
export type PayerClass = "outside" | "sibling";

/**
 * Sibling means the payer is already inside this swarm.
 * Pass every agent wallet (alive or archived, including the receiver) and the orchestrator treasury.
 * Any other address is outside. Comparison ignores case and surrounding space.
 */
export function classifyPayer(payer: string, swarmAddresses: Iterable<string>): PayerClass {
  const needle = payer.trim().toLowerCase();
  if (!needle) return "outside";
  for (const address of swarmAddresses) {
    if (address.trim().toLowerCase() === needle) return "sibling";
  }
  return "outside";
}
