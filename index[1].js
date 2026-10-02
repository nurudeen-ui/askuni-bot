// Orbuni ⇄ AskUni bot — start file (version 3). See README.md.
// The browser is installed inside node_modules when Render builds the service
// (see "postinstall" in package.json); this line tells Playwright to look there.
// It has to be set before Playwright loads, which is why the server lives in server.js.
process.env.PLAYWRIGHT_BROWSERS_PATH = process.env.PLAYWRIGHT_BROWSERS_PATH || "0";
await import("./server.js");
