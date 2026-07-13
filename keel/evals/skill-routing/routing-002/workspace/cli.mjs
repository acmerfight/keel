const [command, value] = process.argv.slice(2);

if (command === "--help") {
  process.stdout.write("usage: node cli.mjs parse <number>\n");
  process.exit(0);
}
if (command === "parse") {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    process.stderr.write("value must be a number\n");
    process.exit(2);
  }
  process.stdout.write(`${parsed}\n`);
  process.exit(0);
}
process.stderr.write("unknown command\n");
process.exit(2);
