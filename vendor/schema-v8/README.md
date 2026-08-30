# Embedded schema-v8 migration source

These eight migrations are the canonical bootstrap dependency used by the extracted
DSH plugin. `pnpm stage:v8` copies them byte-for-byte into the Python package and
writes a SHA-256 manifest.

They are embedded here so this repository can build without a sibling Nobei checkout.
