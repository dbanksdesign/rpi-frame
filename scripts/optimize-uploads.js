#!/usr/bin/env node
// One-off: shrink photos already in uploads/ to display size (run after `npm run build`).
//   node scripts/optimize-uploads.js
const fs = require('fs');
const path = require('path');
const { optimizeImage } = require('../dist/server/utils/optimizeImage');

const dir = path.join(__dirname, '..', 'uploads');
(async () => {
  const files = fs.readdirSync(dir).filter(f => /\.(jpe?g|png|webp)$/i.test(f));
  let changed = 0;
  for (const f of files) {
    const p = path.join(dir, f);
    const before = fs.statSync(p).size;
    try {
      if (await optimizeImage(p)) {
        changed++;
        console.log(`${f}: ${(before / 1e6).toFixed(1)}MB -> ${(fs.statSync(p).size / 1e6).toFixed(1)}MB`);
      }
    } catch (e) {
      console.error(`${f}: skipped (${e.message})`);
    }
  }
  console.log(`Done: ${changed} of ${files.length} files resized.`);
})();
