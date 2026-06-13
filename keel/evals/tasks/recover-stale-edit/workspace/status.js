const STATUS_TEXT = "Queued";

function statusLabel() {
  return STATUS_TEXT;
}

function statusCode() {
  return 202;
}

module.exports = { statusLabel, statusCode };
