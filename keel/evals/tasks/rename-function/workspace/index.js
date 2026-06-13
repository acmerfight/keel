const { checkoutSummary } = require("./lib/checkout");

const items = [
  { price: 10, quantity: 2 },
  { price: 5, quantity: 2 },
];

console.log(checkoutSummary(items));
