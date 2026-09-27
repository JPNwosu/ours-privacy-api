import { createApp } from "./app.js";

const DEFAULT_PORT = 3000;

function readPort(): number {
  const raw = process.env.PORT;
  if (raw === undefined) return DEFAULT_PORT;

  const port = Number(raw);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`Invalid PORT environment variable: "${raw}"`);
  }
  return port;
}

const port = readPort();
const app = createApp();

app.listen(port, (error) => {
  if (error) throw error;
  console.log(`Image processing service listening on http://localhost:${port}`);
});
