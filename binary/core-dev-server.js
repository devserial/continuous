const path = require("path");
process.env.CONTINUE_DEVELOPMENT = true;
// Dev control port: set CONTINUE_TCP_TOKEN (16+ characters) to the same
// value in the IDE process. If unset, a token is printed at startup.

process.env.CONTINUE_GLOBAL_DIR = path.join(
  process.env.PROJECT_DIR,
  "extensions",
  ".continue-debug",
);

require("./out/index.js");
