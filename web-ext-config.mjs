// web-ext settings for the Firefox/Zen build (the Chromium build runs in .github/actions/build-extensions)
export default {
  sourceDir: "extension",
  ignoreFiles: ["manifest.chromium.json", "hook-main.js"],
};
