# Deployment notes

Workers drain current deliveries before replacement. A deployment cannot alter
the API producer schema. Broker redelivery remains enabled during rollout, and
operators compare accepted, completed, and redelivered counts.
