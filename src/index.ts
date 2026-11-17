import { main } from "./cli.js";
import { redact } from "./redact.js";

main(process.argv.slice(2)).catch((error) => {
  const message = error instanceof Error ? (error.stack ?? error.message) : String(error);
  console.error(redact(message));
  process.exit(1);
});
