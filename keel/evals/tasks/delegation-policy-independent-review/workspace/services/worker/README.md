# Worker delivery handling

Workers acknowledge a queue message only after the handler returns. If a worker
crashes after the side effect but before acknowledgement, the queue redelivers
the message and the handler performs the side effect twice. The handler has no
deduplication key, so duplicate execution is the primary delivery risk.

Worker logs include `job_id`, but the received job envelope contains only
`job_type` and `payload`; it has no originating `request_id`.
