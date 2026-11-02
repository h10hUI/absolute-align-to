// Builds ui.html (the file manifest.json points at) from src/ui/.
// Figma loads a single HTML file into the UI iframe, so CSS and JS must be
// inlined. ui.html is a generated file: edit src/ui/ instead.
import { build } from "esbuild";
import { readFile, writeFile } from "node:fs/promises";
import { watch } from "node:fs";
import console from "node:console";
import process from "node:process";
import { clearTimeout, setTimeout } from "node:timers";

const TEMPLATE = "src/ui/index.html";
const CSS_ENTRY = "src/ui/styles/index.css";
const JS_ENTRY = "src/ui/main.ts";
const OUTPUT = "ui.html";

// Replace a placeholder line, re-indenting the content to the placeholder's
// indentation. A function replacer keeps `$` in the content literal.
const inline = (html, placeholder, content) => {
  const pattern = new RegExp(`^( *)${placeholder}$`, "m");
  if (!pattern.test(html)) {
    throw new Error(`${TEMPLATE}: placeholder not found: ${placeholder}`);
  }
  return html.replace(pattern, (_match, indent) =>
    content
      .split("\n")
      .map((line) => (line === "" ? line : indent + line))
      .join("\n")
  );
};

// Keep inlined code from closing its own <script> / <style> element.
const escapeClosingTags = (code) => code.replace(/<\/(script|style)/gi, "<\\/$1");

const buildUi = async () => {
  const css = await build({
    entryPoints: [CSS_ENTRY],
    bundle: true,
    write: false,
    outfile: "ui.css",
    logLevel: "warning",
  });
  const cssText = css.outputFiles[0].text.trimEnd();
  const js = await build({
    entryPoints: [JS_ENTRY],
    bundle: true,
    format: "iife",
    target: "es2020",
    write: false,
    outfile: "ui.js",
    logLevel: "warning",
  });
  const jsText = js.outputFiles[0].text.trimEnd();
  const template = await readFile(TEMPLATE, "utf8");

  let html = inline(template, "/\\* @inline-css \\*/", escapeClosingTags(cssText));
  html = inline(html, "/\\* @inline-js \\*/", escapeClosingTags(jsText));
  await writeFile(OUTPUT, html);
  console.log(`built ${OUTPUT}`);
};

const run = () =>
  buildUi().catch((error) => {
    console.error(error);
    if (!process.argv.includes("--watch")) process.exit(1);
  });

await run();

if (process.argv.includes("--watch")) {
  let timer;
  watch("src/ui", { recursive: true }, () => {
    clearTimeout(timer);
    timer = setTimeout(run, 50);
  });
}
