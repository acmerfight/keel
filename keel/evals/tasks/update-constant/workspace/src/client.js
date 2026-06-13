const { MAX_RETRIES, BASE_DELAY_MS } = require("./config");

function retryDelays() {
  const delays = [];
  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    delays.push(BASE_DELAY_MS * 2 ** attempt);
  }
  return delays;
}

module.exports = { retryDelays };
