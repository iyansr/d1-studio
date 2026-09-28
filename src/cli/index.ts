import { styleText } from "node:util";
import { UserError } from "../errors";
import { main } from "./main";

main(process.argv.slice(2)).catch((err: unknown) => {
  if (err instanceof UserError) {
    console.error(styleText("red", "Error:", { stream: process.stderr }), err.message);
  } else {
    console.error(err);
  }
  process.exitCode = 1;
});
