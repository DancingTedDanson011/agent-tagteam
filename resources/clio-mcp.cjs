#!/usr/bin/env node
// MCP stdio shim for CLI Organizer orchestrator tiles. The agent CLI starts it as an MCP server;
// it relays newline-delimited JSON-RPC between the agent (stdin/stdout) and the organizer (a local
// named pipe). The first line to the organizer is the tile's token, taken from the environment
// (CLIO_TOKEN) so it never shows on a command line. The organizer decides every right; this file
// only forwards bytes. No dependencies on purpose.
'use strict'
const net = require('node:net')

const i = process.argv.indexOf('--pipe')
const pipe = i > 0 ? process.argv[i + 1] : undefined
const token = process.env.CLIO_TOKEN
if (!pipe || !token || !pipe.startsWith('\\\\.\\pipe\\')) {
  process.stderr.write('clio-mcp: --pipe \\\\.\\pipe\\... and the CLIO_TOKEN environment variable are required\n')
  process.exit(2)
}

const sock = net.connect(pipe, () => {
  sock.write(JSON.stringify({ token }) + '\n')
  process.stdin.pipe(sock)
  sock.pipe(process.stdout)
})
sock.on('error', (err) => {
  process.stderr.write(`clio-mcp: CLI Organizer is not reachable (${err.message})\n`)
  process.exit(1)
})
sock.on('close', () => process.exit(0))
process.stdin.on('end', () => sock.end())
