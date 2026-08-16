# Automatic PostgreSQL v5 startup upgrade

- PostgreSQL deployments on schema version 4 now add the Assistant operator
  instructions column automatically during startup instead of failing the
  pre-migration compatibility check and requiring manual SQL.
