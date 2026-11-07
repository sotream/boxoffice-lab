# Security

This is a learning and design lab, not a production system. Do not deploy it as is.

Known gaps that are deliberate and documented (see "Limits of this lab" in the README and `docs/e2e.md`):

- The payments service has no authentication and is not behind the gateway; it takes the user and the seats from the request body. The payment provider is an in-process fake.
- Default secrets (`ADMISSION_SECRET=dev-secret`, database `lab:lab`) are for local use only. In `NODE_ENV=production` the services refuse the default admission secret.
- The ops endpoints (`/metrics`, `/readyz`) expose internal counters and dependency errors and must stay off public networks.

There are no real credentials in this repository or in its history. To report a problem, open an issue on GitHub.
