#!/usr/bin/env node

const path = require('path');
const fs = require('fs');
const pkg = require('../package.json');

const args = process.argv.slice(2);

if (args.includes('--version') || args.includes('-v')) {
  console.log(pkg.version);
  process.exit(0);
}

if (args.includes('--help') || args.includes('-h')) {
  console.log(`cortex-engine v${pkg.version} - Code intelligence MCP server

Usage:
  cortex-engine [project-root] [options]

Options:
  --help, -h       Show this help
  --version, -v    Show version

If project-root is omitted, uses the current working directory.
Reads cortex.config.js from project root if present.`);
  process.exit(0);
}

const projectRoot = args[0] || process.cwd();
const resolvedRoot = path.resolve(projectRoot);

if (!fs.existsSync(resolvedRoot)) {
  console.error(`Error: directory does not exist: ${resolvedRoot}`);
  process.exit(1);
}

// Load project config if present
let config = {};
const configPath = path.join(resolvedRoot, 'cortex.config.js');
if (fs.existsSync(configPath)) {
  config = require(configPath);
}

const { createServer } = require('../src/server');
const { StdioServerTransport } = require('@modelcontextprotocol/sdk/server/stdio.js');

createServer(resolvedRoot, config)
  .then(async ({ server }) => {
    const transport = new StdioServerTransport();
    await server.connect(transport);
  })
  .catch((err) => {
    console.error('Failed to start cortex-engine:', err);
    process.exit(1);
  });
