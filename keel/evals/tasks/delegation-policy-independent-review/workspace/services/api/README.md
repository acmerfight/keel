# API request handling

The API retries a downstream enqueue operation up to three times whenever it
does not receive an acknowledgement within 250 ms. The enqueue endpoint is not
idempotent, so a late acknowledgement can cause the same job to be enqueued
again. This creates retry amplification under load.

API logs include `request_id`, but the job envelope currently contains only
`job_type` and `payload`.
