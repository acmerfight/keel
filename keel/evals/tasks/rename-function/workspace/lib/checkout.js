const { calcTotal } = require("./cart");

function checkoutSummary(items) {
  return `total: ${calcTotal(items)}`;
}

module.exports = { checkoutSummary };
