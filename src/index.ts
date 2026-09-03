#!/usr/bin/env node

import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';

import { publicCliFailure, runCli } from './cli.js';
import { createWorkBuddyConnectionStore } from './connection.js';
import { PACKAGE_VERSION } from './constants.js';
import { createWorkBuddyMcpServer } from './mcp.js';

async function runMcp(): Promise<void> {
  const connectionStore = await createWorkBuddyConnectionStore();
  const server = createWorkBuddyMcpServer({ connectionStore });
  const transport = new StdioServerTransport();
  const shutdown = async () => {
    await server.close();
    process.exit(0);
  };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
  await server.connect(transport);
  process.stderr.write('BailingHub WorkBuddy connector is running on stdio.\n');
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.includes('--version') || args[0] === 'version') {
    process.stdout.write(`${PACKAGE_VERSION}\n`);
    return;
  }
  if (args[0] === 'mcp') {
    await runMcp();
    return;
  }
  if (await runCli(args)) return;
  process.stderr.write('Usage: bailinghub-workbuddy <auth|status|logout|connections|mcp|--version>\n');
  process.exitCode = 2;
}

main().catch((error: unknown) => {
  process.stderr.write(`BailingHub WorkBuddy connector failed: ${publicCliFailure(error)}\n`);
  process.exitCode = 1;
});
