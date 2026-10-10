#!/usr/bin/env node
'use strict';

// Builds the hosted website (GitHub Pages) from web/ into site/, or the folder given.
// The hosted copy gets a strict Content-Security-Policy: scripts, styles and images
// only from the site itself, and network requests only to plain-http addresses,
// which is how the v1 bridge is reached.

const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const out = path.resolve(root, process.argv[2] || 'site');
const FILES = ['index.html', 'app.js', 'style.css', 'icon.svg'];
const CSP = [
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self'",
  'connect-src http:',
  "base-uri 'none'",
  "form-action 'none'",
].join('; ');

fs.rmSync(out, { recursive: true, force: true });
fs.mkdirSync(out, { recursive: true });
for (const file of FILES) fs.copyFileSync(path.join(root, 'web', file), path.join(out, file));

const indexPath = path.join(out, 'index.html');
const html = fs.readFileSync(indexPath, 'utf8');
const anchor = '<meta charset="utf-8">';
if (!html.includes(anchor)) throw new Error(`web/index.html no longer contains ${anchor}`);
fs.writeFileSync(indexPath, html.replace(anchor, [
  anchor,
  `  <meta http-equiv="Content-Security-Policy" content="${CSP}">`,
  '  <meta name="referrer" content="no-referrer">',
].join('\n')));

console.log(`built ${path.relative(root, out)}`);
