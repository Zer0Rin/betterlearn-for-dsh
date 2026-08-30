# Protected-data sentinel

Standalone acceptance runs treat this directory as the protected-data boundary when
`NOBEI_FORMAL_DATA_DIRECTORY` is not set. Acceptance data, temporary SQLite files,
and generated evidence must remain outside it.

Set `NOBEI_FORMAL_DATA_DIRECTORY` to an absolute external directory when validating
isolation against a real host application's data directory.
