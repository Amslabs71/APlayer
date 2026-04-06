import { build } from "esbuild";

await build({
    entryPoints: ["sw-source.js"],
    bundle: true,
    outfile: "sw.js",
    format: "iife",
    platform: "browser",
    target: ["chrome110", "firefox110", "safari16"],
    minify: true,
    legalComments: "inline",
    banner: {
        js: "/* Amos Player built-in adblocker, powered by @ghostery/adblocker. */"
    }
});

console.log("Built sw.js with Ghostery adblocker.");
