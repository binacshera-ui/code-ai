// Read installed program code only; never read user settings or credentials.
import fs from 'node:fs';
const filename = process.argv[2];
const needles = process.argv.slice(3);
const excerptBytes = Math.min(12_000, Math.max(360, Number(process.env.CODEAI_CODE_EXCERPT_BYTES) || 360));
const fd = fs.openSync(filename, 'r');
const prefix = Buffer.alloc(16);
fs.readSync(fd, prefix, 0, 16, 0);
const headerLength = prefix.readUInt32LE(12);
if (headerLength > 20_000_000) throw new Error('Unexpected archive header');
const header = Buffer.alloc(headerLength);
fs.readSync(fd, header, 0, headerLength, 16);
const tree = JSON.parse(header.toString());
const dataOffset = 8 + prefix.readUInt32LE(4);
function walk(node, root = '') {
  for (const [key, entry] of Object.entries(node.files || {})) {
    const name = root + key;
    if (entry.files) walk(entry, name + '/');
    else if (/^\.vite\/build\/(?:main|bootstrap|worker).*\.js$/.test(name) && entry.size < 8_000_000 && !entry.unpacked) {
      const content = Buffer.alloc(entry.size);
      fs.readSync(fd, content, 0, entry.size, dataOffset + Number(entry.offset));
      const source = content.toString();
      for (const needle of needles) {
        let start = -1;
        for (let occurrence = 0; occurrence < 3; occurrence++) {
          start = source.indexOf(needle, start + 1);
          if (start < 0) break;
          console.log(JSON.stringify({ file: name, needle,
            sourceExcerpt: source.slice(Math.max(0, start - 180), start + needle.length + excerptBytes) }));
        }
      }
    }
  }
}
walk(tree);
fs.closeSync(fd);
