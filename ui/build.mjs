// Placeholder build until plan 02 scaffolds Vite: copy public/ to ../dist/ui.
import { cpSync, rmSync } from "node:fs";

const out = new URL("../dist/ui/", import.meta.url);
rmSync(out, { recursive: true, force: true });
cpSync(new URL("./public/", import.meta.url), out, { recursive: true });
