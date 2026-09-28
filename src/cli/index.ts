const argv = process.argv.slice(2);
if (argv.includes("--version") || argv.includes("-v")) {
  console.log(__VERSION__);
}
