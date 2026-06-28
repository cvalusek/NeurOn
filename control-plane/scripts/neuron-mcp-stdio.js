#!/usr/bin/env node

const endpoint = process.env.NEURON_MCP_URL ?? "http://localhost:8090/mcp";
const apiKey = process.env.NEURON_API_KEY;

if (!apiKey) {
  console.error("NEURON_API_KEY is required");
  process.exit(1);
}

let buffer = Buffer.alloc(0);
process.stdin.on("data", (chunk) => {
  buffer = Buffer.concat([buffer, chunk]);
  drainMessages().catch((error) => {
    writeMessage({
      jsonrpc: "2.0",
      id: null,
      error: { code: -32603, message: error instanceof Error ? error.message : String(error) }
    });
  });
});

async function drainMessages() {
  while (true) {
    const headerEnd = buffer.indexOf("\r\n\r\n");
    if (headerEnd === -1) return;

    const header = buffer.subarray(0, headerEnd).toString("utf8");
    const lengthMatch = /^content-length:\s*(\d+)$/im.exec(header);
    if (!lengthMatch) throw new Error("Missing Content-Length header");

    const contentLength = Number(lengthMatch[1]);
    const messageStart = headerEnd + 4;
    const messageEnd = messageStart + contentLength;
    if (buffer.length < messageEnd) return;

    const message = JSON.parse(buffer.subarray(messageStart, messageEnd).toString("utf8"));
    buffer = buffer.subarray(messageEnd);
    await forwardMessage(message);
  }
}

async function forwardMessage(message) {
  const response = await fetch(endpoint, {
    method: "POST",
    headers: {
      authorization: `Bearer ${apiKey}`,
      "content-type": "application/json"
    },
    body: JSON.stringify(message)
  });

  if (!response.ok) {
    writeMessage({
      jsonrpc: "2.0",
      id: message.id ?? null,
      error: { code: -32603, message: `NeurOn MCP returned HTTP ${response.status}` }
    });
    return;
  }

  writeMessage(await response.json());
}

function writeMessage(message) {
  const payload = Buffer.from(JSON.stringify(message), "utf8");
  process.stdout.write(`Content-Length: ${payload.length}\r\n\r\n`);
  process.stdout.write(payload);
}
