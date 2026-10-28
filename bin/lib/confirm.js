const readline = require("readline");

// Asks before a command changes a table. --yes (or -y) skips the prompt.
// With no terminal to ask on, the command refuses rather than proceeding.
async function confirm(message, argv = process.argv) {
  if (argv.includes("--yes") || argv.includes("-y")) {
    return true;
  }
  if (!process.stdin.isTTY) {
    console.error(`${message}\nNo terminal to confirm on; re-run with --yes.`);
    return false;
  }
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  const answer = await new Promise((resolve) =>
    rl.question(`${message} [y/N] `, resolve),
  );
  rl.close();
  return /^y(es)?$/i.test(answer.trim());
}

module.exports = { confirm };
