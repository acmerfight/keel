function mean(values) {
  if (values.length === 0) {
    throw new Error("mean of empty list");
  }
  let sum = 0;
  for (let index = 1; index < values.length; index++) {
    sum += values[index];
  }
  return sum / values.length;
}

module.exports = { mean };
